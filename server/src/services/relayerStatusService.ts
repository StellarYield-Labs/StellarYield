/* eslint-disable @typescript-eslint/no-unused-vars, no-redeclare, no-useless-escape */
// ── Relayer Status Service ─────────────────────────────────────────────────
// Tracks bridge relayer health metrics: queue depth, replay protection,
// relay failures, and recent activity for the read-only status page.

export interface RelayEvent {
  id: string;
  timestamp: string;
  status: "success" | "failed" | "pending";
  innerTxHash?: string;
  feeBumpHash?: string;
  error?: string;
  durationMs: number;
}

export interface ReplayProtectionStatus {
  enabled: boolean;
  trackedHashes: number;
  oldestHashAge: string | null;
  deduplicationWindow: string;
}

export interface RelayerStatus {
  isOnline: boolean;
  serviceState: "online" | "degraded" | "offline";
  network: string;
  queueDepth: number;
  totalRelayed: number;
  successCount: number;
  failureCount: number;
  successRate: number; // 0-100
  avgDurationMs: number;
  lastRelayAt: string | null;
  lastRelayAgeMs: number | null;
  recentEvents: RelayEvent[];
  replayProtection: ReplayProtectionStatus;
  uptime: string;
  checkedAt: string;
  alerts: string[];
}

// ── In-memory state ───────────────────────────────────────────────────────

const MAX_EVENTS = 100;
const DEDUP_WINDOW_HOURS = 24;
const DEGRADED_AFTER_MS = Number(
  process.env.RELAYER_STATUS_DEGRADED_AFTER_MS ?? 5 * 60 * 1000,
);
const OFFLINE_AFTER_MS = Number(
  process.env.RELAYER_STATUS_OFFLINE_AFTER_MS ?? 15 * 60 * 1000,
);
const DEGRADED_QUEUE_DEPTH = Number(
  process.env.RELAYER_STATUS_DEGRADED_QUEUE_DEPTH ?? 10,
);

const events: RelayEvent[] = [];
const seenHashes = new Map<string, number>(); // hash -> timestamp ms
const startedAt = Date.now();

let pendingCount = 0;

// ── Public API ────────────────────────────────────────────────────────────

export function recordRelayStart(): string {
  const id = `relay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingCount++;
  return id;
}

export function recordRelaySuccess(
  id: string,
  durationMs: number,
  innerTxHash?: string,
  feeBumpHash?: string,
  timestamp = new Date().toISOString(),
): void {
  pendingCount = Math.max(0, pendingCount - 1);

  const eventTimestampMs = new Date(timestamp).getTime();
  const hashTimestamp = Number.isFinite(eventTimestampMs)
    ? eventTimestampMs
    : Date.now();

  if (innerTxHash) {
    seenHashes.set(innerTxHash, hashTimestamp);
  }
  if (feeBumpHash) {
    seenHashes.set(feeBumpHash, hashTimestamp);
  }

  events.unshift({
    id,
    timestamp,
    status: "success",
    innerTxHash,
    feeBumpHash,
    durationMs,
  });

  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  pruneSeenHashes(hashTimestamp);
}

export function recordRelayFailure(
  id: string,
  durationMs: number,
  error: string,
  timestamp = new Date().toISOString(),
): void {
  pendingCount = Math.max(0, pendingCount - 1);

  events.unshift({
    id,
    timestamp,
    status: "failed",
    error,
    durationMs,
  });

  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

export function isHashSeen(hash: string): boolean {
  return seenHashes.has(hash);
}

export function getRelayerStatus(now = Date.now()): RelayerStatus {
  pruneSeenHashes(now);

  const successCount = events.filter((e) => e.status === "success").length;
  const failureCount = events.filter((e) => e.status === "failed").length;
  const totalRelayed = successCount + failureCount;
  const successRate = totalRelayed > 0 ? Math.round((successCount / totalRelayed) * 100) : 100;

  const durations = events
    .filter((e) => e.status === "success")
    .map((e) => e.durationMs);
  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

  const lastSuccessfulRelay = events.find((event) => event.status === "success");
  const lastRelayAt = lastSuccessfulRelay?.timestamp ?? null;
  const lastRelayAgeMs =
    lastRelayAt !== null
      ? Math.max(0, now - new Date(lastRelayAt).getTime())
      : null;

  // Uptime since service started
  const uptimeMs = now - startedAt;
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

  // Replay protection
  const cutoff = now - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  let oldestHashAge: string | null = null;
  let oldestTs = now;

  for (const [, ts] of seenHashes) {
    if (ts < oldestTs) oldestTs = ts;
  }

  if (seenHashes.size > 0) {
    const ageMs = now - oldestTs;
    const ageMinutes = Math.floor(ageMs / (1000 * 60));
    oldestHashAge = ageMinutes < 60 ? `${ageMinutes}m` : `${Math.floor(ageMinutes / 60)}h ${ageMinutes % 60}m`;
  }

  const alerts: string[] = [];
  let serviceState: RelayerStatus["serviceState"] = "online";

  if (pendingCount >= DEGRADED_QUEUE_DEPTH) {
    alerts.push(`Relay queue depth is elevated (${pendingCount}).`);
  }

  if (lastRelayAgeMs !== null && lastRelayAgeMs > DEGRADED_AFTER_MS) {
    alerts.push(
      `Last successful relay is stale (${Math.round(lastRelayAgeMs / 1000)}s ago).`,
    );
  }

  if (failureCount > 0 && totalRelayed >= 3 && successRate < 80) {
    alerts.push(
      `Recent relay failures are elevated (${failureCount}/${totalRelayed} failed).`,
    );
  }

  if (lastRelayAgeMs !== null && lastRelayAgeMs > OFFLINE_AFTER_MS) {
    serviceState = "offline";
  } else if (alerts.length > 0) {
    serviceState = "degraded";
  }

  return {
    isOnline: serviceState !== "offline",
    serviceState,
    network: process.env.NETWORK_PASSPHRASE?.includes("TESTNET") ? "testnet" : "mainnet",
    queueDepth: pendingCount,
    totalRelayed,
    successCount,
    failureCount,
    successRate,
    avgDurationMs,
    lastRelayAt,
    lastRelayAgeMs,
    recentEvents: events.slice(0, 20),
    replayProtection: {
      enabled: true,
      trackedHashes: seenHashes.size,
      oldestHashAge,
      deduplicationWindow: `${DEDUP_WINDOW_HOURS}h`,
    },
    uptime: `${uptimeHours}h ${uptimeMinutes}m`,
    checkedAt: new Date(now).toISOString(),
    alerts,
  };
}

// ── Internal ──────────────────────────────────────────────────────────────

function pruneSeenHashes(now = Date.now()): void {
  const cutoff = now - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  for (const [hash, ts] of seenHashes) {
    if (ts < cutoff) seenHashes.delete(hash);
  }
}

export function resetRelayerStatusForTests(): void {
  events.length = 0;
  seenHashes.clear();
  pendingCount = 0;
}
