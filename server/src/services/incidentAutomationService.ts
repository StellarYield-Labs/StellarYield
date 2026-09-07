/**
 * Incident Automation Service
 *
 * Coordinates automatic incident creation, freeze triggers, flap detection,
 * and recovery automation based on failover signals and health evaluations.
 *
 * Responsibilities:
 * 1. Create incidents from failover/health evaluation signals
 * 2. Track incident state machine transitions (DETECTED → FROZEN → MONITORING → RECOVERY_CANDIDATE → RECOVERED)
 * 3. Detect and deduplicate flapping signals (rapid on/off)
 * 4. Enforce stability windows before auto-recovery
 * 5. Trigger protocol-level freezes for high-severity incidents
 * 6. Coordinate with freeze and alert services
 */

import { PrismaClient, Incident } from "@prisma/client";
import { incidentService } from "./incidentService";
import { freezeService } from "./freezeService";
import { failoverIncidentHistoryService } from "./failoverIncidentHistoryService";
import { FailoverDecision } from "./protocolFailoverService";

const prisma = new PrismaClient();

export type IncidentState =
  | "DETECTED"
  | "FROZEN"
  | "MONITORING"
  | "RECOVERY_CANDIDATE"
  | "RECOVERED"
  | "MANUALLY_RESOLVED";

export interface IncidentAutomationConfig {
  // Thresholds for triggering auto-freeze
  freezeSeverities: string[]; // e.g., ["HIGH", "CRITICAL"]

  // Flap detection: time window (ms) to consider signals as duplicates
  flapDetectionWindow: number; // e.g., 60000 (1 minute)

  // Stability tracking: how many consecutive healthy checks before recovery candidate
  stabilityCheckCount: number; // e.g., 5

  // Cooldown before auto-recovery (ms)
  recoveryStabilityWindow: number; // e.g., 300000 (5 minutes)

  // Cooldown before creating new incident on same protocol (ms)
  incidentCooldown: number; // e.g., 300000 (5 minutes)
}

export const DEFAULT_AUTOMATION_CONFIG: IncidentAutomationConfig = {
  freezeSeverities: ["HIGH", "CRITICAL"],
  flapDetectionWindow: 60000, // 1 minute
  stabilityCheckCount: 5,
  recoveryStabilityWindow: 300000, // 5 minutes
  incidentCooldown: 300000, // 5 minutes
};

interface IncidentDeduplicationKey {
  protocol: string;
  reason: string;
}

interface FlapRecord {
  timestamp: number;
  decision: FailoverDecision;
}

// In-memory tracking of recent flaps and last incident per protocol
const flapRecords = new Map<string, FlapRecord[]>();
const lastIncidentPerProtocol = new Map<
  string,
  { timestamp: number; id: string }
>();
const incidentHealthyCheckCount = new Map<string, number>();

function deduplicationKey(protocol: string, reason: string): string {
  return `${protocol}::${reason}`;
}

function hashReason(decision: FailoverDecision): string {
  // Create deterministic hash from trigger reason
  const parts = [
    decision.action,
    decision.reasons.join(","),
    decision.severity || "unknown",
  ];
  return parts.join("|").toLowerCase();
}

export class IncidentAutomationService {
  private config: IncidentAutomationConfig;

  constructor(config: Partial<IncidentAutomationConfig> = {}) {
    this.config = { ...DEFAULT_AUTOMATION_CONFIG, ...config };
  }

  /**
   * Detect if a failover decision should create or update an incident.
   * Handles deduplication (flap detection) and cooldown logic.
   */
  async evaluateFailoverDecision(decision: FailoverDecision): Promise<{
    shouldCreateIncident: boolean;
    isDuplicate: boolean;
    reason: string;
  }> {
    const protocol = decision.protocolName || "unknown";
    const reasonHash = hashReason(decision);
    const key = deduplicationKey(protocol, reasonHash);

    // Check for flapping within window
    const now = Date.now();
    if (!flapRecords.has(key)) {
      flapRecords.set(key, []);
    }

    const records = flapRecords.get(key)!;
    records.push({ timestamp: now, decision });

    // Remove old records outside the detection window
    const windowStart = now - this.config.flapDetectionWindow;
    const recentRecords = records.filter((r) => r.timestamp > windowStart);
    flapRecords.set(key, recentRecords);

    // Check cooldown on protocol
    const lastIncident = lastIncidentPerProtocol.get(protocol);
    const inCooldown =
      lastIncident &&
      now - lastIncident.timestamp < this.config.incidentCooldown;

    // Determine if this is a duplicate flap
    const isDuplicate = recentRecords.length > 1;

    if (inCooldown) {
      return {
        shouldCreateIncident: false,
        isDuplicate: true,
        reason: `Protocol ${protocol} in incident cooldown (${this.config.incidentCooldown}ms)`,
      };
    }

    if (isDuplicate && recentRecords.length >= 2) {
      // Log the duplicate but don't create new incident yet
      return {
        shouldCreateIncident: false,
        isDuplicate: true,
        reason: `Flapping detected: ${recentRecords.length} signals in ${this.config.flapDetectionWindow}ms`,
      };
    }

    return {
      shouldCreateIncident: true,
      isDuplicate: false,
      reason: "Evaluation criteria met",
    };
  }

  /**
   * Create or update incident from failover signal, trigger freeze if needed.
   */
  async processFailoverSignal(
    decision: FailoverDecision,
    affectedVaults: string[] = [],
  ): Promise<Incident | null> {
    const dedup = await this.evaluateFailoverDecision(decision);

    if (!dedup.shouldCreateIncident) {
      console.log(
        `[IncidentAutomation] Skipping incident creation for ${decision.protocolName}: ${dedup.reason}`,
      );
      return null;
    }

    const protocol = decision.protocolName || "unknown";
    const severity = this.mapFailoverSeverityToIncidentSeverity(
      decision.severity,
    );
    const title = this.buildIncidentTitle(decision);
    const description =
      decision.reasons.join(", ") ||
      "Protocol health evaluation triggered incident";

    // Create incident
    const incident = await incidentService.createIncident({
      protocol,
      severity,
      type: this.mapActionToIncidentType(decision.action),
      title,
      description,
      affectedVaults,
      startedAt: new Date(),
    });

    // Track this incident
    lastIncidentPerProtocol.set(protocol, {
      timestamp: Date.now(),
      id: incident.id,
    });

    // Update state and trigger freeze if needed
    await this.updateIncidentState(incident.id, "DETECTED");

    if (this.config.freezeSeverities.includes(severity)) {
      await this.freezeProtocol(
        incident.id,
        protocol,
        severity,
        decision.reasons[0],
      );
    }

    // Record in failover history
    failoverIncidentHistoryService.recordIncident({
      protocolId: protocol,
      protocolName: protocol,
      reasons: decision.reasons,
      startedAt: new Date().toISOString(),
    });

    console.log(
      `[IncidentAutomation] Created incident ${incident.id} for ${protocol} with severity ${severity}`,
    );

    return incident;
  }

  /**
   * Update incident to new state with appropriate actions.
   */
  async updateIncidentState(
    incidentId: string,
    newState: IncidentState,
  ): Promise<Incident> {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });
    if (!incident) throw new Error(`Incident ${incidentId} not found`);

    const updated = await prisma.incident.update({
      where: { id: incidentId },
      data: {
        state: newState,
        updatedAt: new Date(),
      },
    });

    console.log(
      `[IncidentAutomation] Transitioned incident ${incidentId} to state ${newState}`,
    );
    return updated;
  }

  /**
   * Mark a protocol as healthy and track recovery progress.
   * Auto-transition to RECOVERY_CANDIDATE if stability criteria met.
   */
  async recordProtocolHealthy(protocol: string): Promise<void> {
    const incident = await this.getActiveIncident(protocol);
    if (!incident) return;

    const count = (incidentHealthyCheckCount.get(protocol) || 0) + 1;
    incidentHealthyCheckCount.set(protocol, count);

    console.log(
      `[IncidentAutomation] Protocol ${protocol} healthy check ${count}/${this.config.stabilityCheckCount}`,
    );

    // Update lastHealthyAt
    await prisma.incident.update({
      where: { id: incident.id },
      data: { lastHealthyAt: new Date() },
    });

    // If we've hit the threshold and incident is in MONITORING, move to RECOVERY_CANDIDATE
    if (
      count >= this.config.stabilityCheckCount &&
      incident.state === "MONITORING"
    ) {
      await this.updateIncidentState(incident.id, "RECOVERY_CANDIDATE");
      console.log(
        `[IncidentAutomation] Incident ${incident.id} is recovery candidate after ${count} healthy checks`,
      );
    }
  }

  /**
   * Attempt automatic recovery if stability window has passed.
   */
  async attemptAutoRecovery(protocol: string): Promise<boolean> {
    const incident = await this.getActiveIncident(protocol);
    if (!incident) return false;

    if (incident.state !== "RECOVERY_CANDIDATE") {
      return false;
    }

    const now = Date.now();
    const recoveryStart =
      incident.lastHealthyAt?.getTime() || incident.frozenAt?.getTime() || 0;
    const elapsedSinceHealthy = now - recoveryStart;

    if (elapsedSinceHealthy < this.config.recoveryStabilityWindow) {
      console.log(
        `[IncidentAutomation] Recovery stability window not met for ${protocol}: ${elapsedSinceHealthy}ms < ${this.config.recoveryStabilityWindow}ms`,
      );
      return false;
    }

    // Unfreeze and mark as recovered
    await freezeService.resumeProtocol(protocol, "incident-automation");
    await this.updateIncidentState(incident.id, "RECOVERED");
    await incidentService.resolveIncident(incident.id);

    // Resolve in failover history
    failoverIncidentHistoryService.resolveIncident(protocol);

    // Reset health tracking
    incidentHealthyCheckCount.delete(protocol);

    console.log(
      `[IncidentAutomation] Auto-recovered protocol ${protocol} (incident ${incident.id})`,
    );
    return true;
  }

  /**
   * Manually resolve an incident (admin action).
   */
  async manuallyResolveIncident(
    incidentId: string,
    actor: string,
  ): Promise<Incident> {
    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });
    if (!incident) throw new Error(`Incident ${incidentId} not found`);

    await freezeService.resumeProtocol(incident.protocol, actor);
    await this.updateIncidentState(incidentId, "MANUALLY_RESOLVED");
    const resolved = await incidentService.resolveIncident(incidentId);

    incidentHealthyCheckCount.delete(incident.protocol);
    return resolved;
  }

  /**
   * Get the currently active (unresolved) incident for a protocol.
   */
  async getActiveIncident(protocol: string): Promise<Incident | null> {
    const incidents = await prisma.incident.findMany({
      where: { protocol, resolved: false },
      orderBy: { startedAt: "desc" },
      take: 1,
    });
    return incidents.length > 0 ? incidents[0] : null;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async freezeProtocol(
    incidentId: string,
    protocol: string,
    severity: string,
    reason?: string,
  ): Promise<void> {
    const freezeReason = `Incident ${incidentId}: ${severity} severity - ${reason || "Protocol health evaluation failed"}`;
    await freezeService.freezeProtocol(
      protocol,
      freezeReason,
      "incident-automation",
    );
    await prisma.incident.update({
      where: { id: incidentId },
      data: { frozenAt: new Date(), state: "FROZEN" },
    });
  }

  private mapFailoverSeverityToIncidentSeverity(
    failoverSeverity: string,
  ): string {
    switch (failoverSeverity) {
      case "fail":
        return "CRITICAL";
      case "warn":
        return "HIGH";
      default:
        return "LOW";
    }
  }

  private mapActionToIncidentType(action: string): string {
    switch (action) {
      case "exclude":
        return "PAUSE";
      case "recovered":
        return "ANOMALY";
      default:
        return "ANOMALY";
    }
  }

  private buildIncidentTitle(decision: FailoverDecision): string {
    const actionLabel =
      decision.action === "exclude" ? "Failover triggered" : "Health recovered";
    return `${actionLabel}: ${decision.protocolName || "unknown protocol"}`;
  }

  /**
   * Clean up old flap records to prevent unbounded memory growth.
   * Call periodically (e.g., every hour).
   */
  cleanupOldFlapRecords(): void {
    const now = Date.now();
    const window = this.config.flapDetectionWindow * 2; // Keep 2x window for safety

    for (const [key, records] of flapRecords.entries()) {
      const filtered = records.filter((r) => now - r.timestamp < window);
      if (filtered.length === 0) {
        flapRecords.delete(key);
      } else if (filtered.length < records.length) {
        flapRecords.set(key, filtered);
      }
    }
  }
}

export const incidentAutomationService = new IncidentAutomationService();
