/**
 * Indexer Replay Checkpoint Status
 *
 * Operator-facing view of the contract event indexer: the latest indexed
 * ledger (replay checkpoint), the latest ledger on the network, the resulting
 * lag, and recent replay errors. The status classifier is pure so it can be
 * unit-tested without Prisma or a live Horizon connection.
 */

import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";

export type IndexerHealthStatus = "healthy" | "degraded" | "unavailable";

export interface IndexerReplayError {
  ledger: number | null;
  message: string;
  at: string; // ISO timestamp
}

export interface IndexerStatusInput {
  /** Last ledger the indexer durably committed (replay checkpoint). */
  indexedLedger: number | null;
  /** Latest ledger observed on the network via Horizon/RPC. */
  horizonLedger: number | null;
  /** ISO timestamp of the last successful commit, when known. */
  lastIndexedAt: string | null;
  recentErrors: IndexerReplayError[];
  streamsTracked?: number;
  pagesProcessed?: number;
  eventsProcessed?: number;
  unresolvedDeadLetters?: number;
  oldestUnresolvedDeadLetterAt?: string | null;
  now?: number;
}

export interface IndexerStatus {
  status: IndexerHealthStatus;
  reason: string | null;
  indexedLedger: number | null;
  horizonLedger: number | null;
  lagLedgers: number | null;
  lastIndexedAt: string | null;
  heartbeatAgeSeconds: number | null;
  recentErrors: IndexerReplayError[];
  streamsTracked: number;
  pagesProcessed: number;
  eventsProcessed: number;
  unresolvedDeadLetters: number;
  oldestUnresolvedDeadLetterAt: string | null;
  generatedAt: string;
}

export const INDEXER_THRESHOLDS = {
  /** Lag (ledgers) at or above which the indexer is degraded. ~5m @ 5s ledgers. */
  degradedLagLedgers: 60,
  /** Lag (ledgers) at or above which the indexer is effectively unavailable. ~1h. */
  unavailableLagLedgers: 720,
  /** No commit in this many seconds downgrades the indexer to degraded. */
  staleHeartbeatSeconds: 15 * 60,
} as const;

/**
 * Pure classifier: map indexer signals to an operator status and reason.
 */
export function classifyIndexerStatus(input: IndexerStatusInput): IndexerStatus {
  const now = input.now ?? Date.now();
  const t = INDEXER_THRESHOLDS;

  const lagLedgers =
    input.indexedLedger !== null && input.horizonLedger !== null
      ? Math.max(0, input.horizonLedger - input.indexedLedger)
      : null;

  const heartbeatAgeSeconds = input.lastIndexedAt
    ? Math.max(0, Math.round((now - new Date(input.lastIndexedAt).getTime()) / 1000))
    : null;

  let status: IndexerHealthStatus = "healthy";
  let reason: string | null = null;

  if (input.indexedLedger === null) {
    status = "unavailable";
    reason = "Indexer checkpoint unavailable";
  } else if (lagLedgers !== null && lagLedgers >= t.unavailableLagLedgers) {
    status = "unavailable";
    reason = `Indexer is ${lagLedgers} ledgers behind the network`;
  } else if (
    heartbeatAgeSeconds !== null &&
    heartbeatAgeSeconds > t.staleHeartbeatSeconds
  ) {
    status = "degraded";
    reason = `No indexed ledger committed for ${Math.round(heartbeatAgeSeconds / 60)}m`;
  } else if (lagLedgers !== null && lagLedgers >= t.degradedLagLedgers) {
    status = "degraded";
    reason = `Indexer lag of ${lagLedgers} ledgers exceeds threshold`;
  } else if (input.recentErrors.length > 0) {
    status = "degraded";
    reason = `${input.recentErrors.length} recent replay error(s)`;
  } else if ((input.unresolvedDeadLetters ?? 0) > 0) {
    status = "degraded";
    reason = `${input.unresolvedDeadLetters} unresolved dead-letter event(s)`;
  }

  return {
    status,
    reason,
    indexedLedger: input.indexedLedger,
    horizonLedger: input.horizonLedger,
    lagLedgers,
    lastIndexedAt: input.lastIndexedAt,
    heartbeatAgeSeconds,
    recentErrors: input.recentErrors,
    streamsTracked: input.streamsTracked ?? 0,
    pagesProcessed: input.pagesProcessed ?? 0,
    eventsProcessed: input.eventsProcessed ?? 0,
    unresolvedDeadLetters: input.unresolvedDeadLetters ?? 0,
    oldestUnresolvedDeadLetterAt: input.oldestUnresolvedDeadLetterAt ?? null,
    generatedAt: new Date(now).toISOString(),
  };
}

// ── Recent replay error ring buffer ───────────────────────────────────────
// In-memory only; mirrors how the indexer's own state lives during runtime.

const MAX_RECENT_ERRORS = 10;
const recentErrors: IndexerReplayError[] = [];

/** Record a replay error so the status route can surface it. Called by the indexer. */
export function recordReplayError(message: string, ledger: number | null = null): void {
  recentErrors.unshift({ ledger, message, at: new Date().toISOString() });
  if (recentErrors.length > MAX_RECENT_ERRORS) {
    recentErrors.length = MAX_RECENT_ERRORS;
  }
}

/** Return a copy of the most recent replay errors (newest first). */
export function getRecentReplayErrors(): IndexerReplayError[] {
  return [...recentErrors];
}

// ── Snapshot assembly ─────────────────────────────────────────────────────

type IndexerStatePrismaClient = {
  indexerCheckpoint?: {
    findMany(args: {
      orderBy: { lastLedger: "asc" };
      take: number;
    }): Promise<Array<{
      lastLedger: number;
      lastSuccessfulBatchAt: Date | null;
      eventsProcessed: number;
    }>>;
  };
  indexerContractStream?: {
    count(args: { where: { enabled: boolean } }): Promise<number>;
  };
  indexerDeadLetter?: {
    count(args: { where: { resolvedAt: null } }): Promise<number>;
    findFirst(args: {
      where: { resolvedAt: null };
      orderBy: { createdAt: "asc" };
    }): Promise<{ createdAt: Date } | null>;
  };
};

async function loadIndexerState(): Promise<{
  indexedLedger: number | null;
  lastIndexedAt: string | null;
  streamsTracked: number;
  eventsProcessed: number;
  unresolvedDeadLetters: number;
  oldestUnresolvedDeadLetterAt: string | null;
}> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => IndexerStatePrismaClient;
    };
    if (!prismaModule.PrismaClient) {
      return emptyIndexerState();
    }

    const prisma = new prismaModule.PrismaClient();
    if (!prisma.indexerCheckpoint) {
      return emptyIndexerState();
    }

    const checkpoints = await prisma.indexerCheckpoint.findMany({
      orderBy: { lastLedger: "asc" },
      take: 1,
    });
    const checkpoint = checkpoints[0];
    const [streamsTracked, unresolvedDeadLetters, oldestDeadLetter] = await Promise.all([
      prisma.indexerContractStream?.count({ where: { enabled: true } }) ?? Promise.resolve(0),
      prisma.indexerDeadLetter?.count({ where: { resolvedAt: null } }) ?? Promise.resolve(0),
      prisma.indexerDeadLetter?.findFirst({
        where: { resolvedAt: null },
        orderBy: { createdAt: "asc" },
      }) ?? Promise.resolve(null),
    ]);

    return {
      indexedLedger: checkpoint?.lastLedger ?? null,
      lastIndexedAt: checkpoint?.lastSuccessfulBatchAt?.toISOString() ?? null,
      streamsTracked,
      eventsProcessed: checkpoint?.eventsProcessed ?? 0,
      unresolvedDeadLetters,
      oldestUnresolvedDeadLetterAt: oldestDeadLetter?.createdAt.toISOString() ?? null,
    };
  } catch {
    return emptyIndexerState();
  }
}

function emptyIndexerState() {
  return {
    indexedLedger: null,
    lastIndexedAt: null,
    streamsTracked: 0,
    eventsProcessed: 0,
    unresolvedDeadLetters: 0,
    oldestUnresolvedDeadLetterAt: null,
  };
}

async function loadHorizonLedger(): Promise<number | null> {
  try {
    const rpcServer = new StellarSdk.rpc.Server(RPC_URL);
    const latest = await Promise.race([
      rpcServer.getLatestLedger(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_500)),
    ]);
    return latest && typeof latest.sequence === "number" ? latest.sequence : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort live snapshot of indexer health. Reads the replay checkpoint
 * from Prisma and the latest ledger from Horizon, degrading gracefully (no
 * throw) when either is unavailable.
 */
export async function getIndexerStatusSnapshot(): Promise<IndexerStatus> {
  const state = await loadIndexerState();

  // Skip the network round-trip when we have no checkpoint to compare against.
  const horizonLedger = state.indexedLedger === null ? null : await loadHorizonLedger();

  return classifyIndexerStatus({
    indexedLedger: state.indexedLedger,
    horizonLedger,
    lastIndexedAt: state.lastIndexedAt,
    recentErrors: getRecentReplayErrors(),
    streamsTracked: state.streamsTracked,
    eventsProcessed: state.eventsProcessed,
    unresolvedDeadLetters: state.unresolvedDeadLetters,
    oldestUnresolvedDeadLetterAt: state.oldestUnresolvedDeadLetterAt,
  });
}
