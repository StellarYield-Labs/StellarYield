/**
 * transparency.ts
 *
 * Backend route for protocol revenue & token burn aggregation, and incident lifecycle events.
 *
 * GET /api/transparency/summary
 *   Returns cumulative protocol fees, total burned tokens,
 *   deflationary ratio, and 30-day historical series.
 *
 * Data is cached for 60 seconds to avoid expensive on-chain queries
 * on every page load.
 */
import { Router, Request, Response } from "express";
import { failoverIncidentHistoryService } from "../services/failoverIncidentHistoryService";
import { incidentService } from "../services/incidentService";
import { incidentAutomationService } from "../services/incidentAutomationService";
import { freezeService } from "../services/freezeService";

const transparencyRouter = Router();

// ── In-memory cache ───────────────────────────────────────────────────────

interface TransparencyData {
  totalRevenueLumens: number;
  totalBurnedTokens: number;
  deflationaryRatio: number;
  history: Array<{ date: string; revenue: number; burned: number }>;
  cachedAt: number;
}

let cache: TransparencyData | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

// ── Data aggregation ─────────────────────────────────────────────────────

/**
 * Aggregates protocol revenue and burn metrics.
 *
 * In production this would query PostgreSQL and the Stellar Horizon API.
 * We return seeded deterministic data derived from the current date so
 * tests and the dashboard always have realistic numbers.
 *
 * @returns Aggregated transparency metrics.
 */
async function aggregateTransparencyData(): Promise<TransparencyData> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache;
  }

  // ── Build 30-day history ──────────────────────────────────────────────
  const history: Array<{ date: string; revenue: number; burned: number }> = [];
  const baseRevenue = 12_400; // USDC equivalent
  const baseBurned = 3_200; // YIELD tokens

  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    // Deterministic noise seeded by day index
    const noise = (((i * 17 + 7) % 13) - 6) / 100;
    history.push({
      date: dateStr,
      revenue: Math.round(baseRevenue * (1 + noise) * 100) / 100,
      burned: Math.round(baseBurned * (1 + noise / 2) * 100) / 100,
    });
  }

  const totalRevenueLumens = history.reduce((s, h) => s + h.revenue, 0);
  const totalBurnedTokens = history.reduce((s, h) => s + h.burned, 0);

  // Emission rate mock: 10_000 YIELD/day × 30 days
  const totalEmissions = 10_000 * 30;
  const deflationaryRatio =
    totalEmissions > 0
      ? Math.round((totalBurnedTokens / totalEmissions) * 10_000) / 100
      : 0;

  cache = {
    totalRevenueLumens,
    totalBurnedTokens,
    deflationaryRatio,
    history,
    cachedAt: Date.now(),
  };

  return cache;
}

// ── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/transparency/summary
 *
 * Returns protocol revenue and token burn metrics.
 * Cached for 60 seconds.
 */
transparencyRouter.get(
  "/summary",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await aggregateTransparencyData();
      const { cachedAt: _omit, ...payload } = data;
      res.json(payload);
    } catch (err) {
      console.error("Failed to aggregate transparency data", err);
      res.status(500).json({ error: "Unable to fetch transparency data." });
    }
  },
);

/**
 * GET /api/transparency/failover-history
 *
 * Returns the in-memory failover incident history, newest first.
 * Optional query param: ?protocolId=<id>
 */
transparencyRouter.get(
  "/failover-history",
  (req: Request, res: Response): void => {
    const protocolId = req.query.protocolId as string | undefined;
    res.json({
      incidents: failoverIncidentHistoryService.getHistory(protocolId),
    });
  },
);

/**
 * POST /api/transparency/failover-history
 *
 * Record a new failover incident.
 * Body: { protocolId, protocolName, reasons, startedAt? }
 */
transparencyRouter.post(
  "/failover-history",
  (req: Request, res: Response): void => {
    const { protocolId, protocolName, reasons, startedAt } = req.body as {
      protocolId?: string;
      protocolName?: string;
      reasons?: string[];
      startedAt?: string;
    };
    if (!protocolId || !protocolName || !Array.isArray(reasons)) {
      res
        .status(400)
        .json({ error: "protocolId, protocolName, and reasons are required." });
      return;
    }
    const incident = failoverIncidentHistoryService.recordIncident({
      protocolId,
      protocolName,
      reasons,
      startedAt,
    });
    res.status(201).json(incident);
  },
);

/**
 * POST /api/transparency/failover-history/:protocolId/resolve
 *
 * Mark the most recent open incident for a protocol as resolved.
 */
transparencyRouter.post(
  "/failover-history/:protocolId/resolve",
  (req: Request, res: Response): void => {
    const { recoveredAt } = req.body as { recoveredAt?: string };
    const incident = failoverIncidentHistoryService.resolveIncident(
      req.params.protocolId,
      recoveredAt,
    );
    if (!incident) {
      res
        .status(404)
        .json({ error: "No open incident found for this protocol." });
      return;
    }
    res.json(incident);
  },
);

/**
 * GET /api/transparency/incidents/protocol/:protocol
 *
 * Get all incidents (open and resolved) for a specific protocol.
 * Ordered by startedAt descending.
 */
transparencyRouter.get(
  "/incidents/protocol/:protocol",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const incidents = await incidentService.getIncidents({
        protocol: req.params.protocol,
      });
      res.json(incidents);
    } catch (err) {
      console.error("Failed to fetch incidents for protocol", err);
      res.status(500).json({ error: "Unable to fetch incidents." });
    }
  },
);

/**
 * GET /api/transparency/incidents/active
 *
 * Get all currently active (unresolved) incidents across all protocols.
 * Useful for showing system-wide health status.
 */
transparencyRouter.get(
  "/incidents/active",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const incidents = await incidentService.getIncidents({
        resolved: false,
      });
      res.json(incidents);
    } catch (err) {
      console.error("Failed to fetch active incidents", err);
      res.status(500).json({ error: "Unable to fetch active incidents." });
    }
  },
);

/**
 * GET /api/transparency/freeze-status
 *
 * Get current global and protocol-specific freeze status.
 * Returns which protocols are frozen and why.
 */
transparencyRouter.get(
  "/freeze-status",
  (_req: Request, res: Response): void => {
    try {
      const globalStatus = freezeService.getFreezeStatus();
      res.json({
        global: globalStatus,
        message: globalStatus.isFrozen
          ? `Global freeze active: ${globalStatus.reason}`
          : "No global freeze",
      });
    } catch (err) {
      console.error("Failed to fetch freeze status", err);
      res.status(500).json({ error: "Unable to fetch freeze status." });
    }
  },
);

/**
 * GET /api/transparency/incident-lifecycle/:protocol
 *
 * Get complete lifecycle information for the current or most recent incident of a protocol.
 * Includes current state, timeline, and recovery progress.
 */
transparencyRouter.get(
  "/incident-lifecycle/:protocol",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const incident = await incidentAutomationService.getActiveIncident(
        req.params.protocol,
      );

      if (!incident) {
        // Return recent resolved incident if no active one
        const resolved = await incidentService.getIncidents({
          protocol: req.params.protocol,
          resolved: true,
        });
        if (resolved.length > 0) {
          res.json({
            protocol: req.params.protocol,
            currentIncident: null,
            lastIncident: resolved[0],
            freezeStatus: freezeService.getFreezeStatus(req.params.protocol),
          });
          return;
        }

        res.json({
          protocol: req.params.protocol,
          currentIncident: null,
          lastIncident: null,
          freezeStatus: freezeService.getFreezeStatus(req.params.protocol),
          message: "No incidents recorded",
        });
        return;
      }

      const freezeStatus = freezeService.getFreezeStatus(req.params.protocol);
      const incidentAny = incident as any;

      res.json({
        protocol: req.params.protocol,
        currentIncident: {
          ...incident,
          stateTransitions: [
            { state: "DETECTED", timestamp: incident.startedAt },
            ...(incidentAny.frozenAt
              ? [{ state: "FROZEN", timestamp: incidentAny.frozenAt }]
              : []),
            ...(incidentAny.lastHealthyAt
              ? [{ state: "MONITORING", timestamp: incidentAny.lastHealthyAt }]
              : []),
            ...(incident.resolvedAt
              ? [
                  {
                    state: incidentAny.state || "DETECTED",
                    timestamp: incident.resolvedAt,
                  },
                ]
              : []),
          ],
        },
        freezeStatus,
        recoveryProgress: {
          isMonitoring: incidentAny.state === "MONITORING",
          isRecoveryCandidate: incidentAny.state === "RECOVERY_CANDIDATE",
          lastHealthyAt: incidentAny.lastHealthyAt,
          stableFor: incidentAny.lastHealthyAt
            ? Math.round(
                (Date.now() - new Date(incidentAny.lastHealthyAt).getTime()) /
                  1000,
              )
            : null,
        },
      });
    } catch (err) {
      console.error("Failed to fetch incident lifecycle", err);
      res.status(500).json({ error: "Unable to fetch incident lifecycle." });
    }
  },
);

export { aggregateTransparencyData };
export default transparencyRouter;
