/**
 * Contract Event Backfill Planner
 *
 * Recovers missing contract event ranges (downtime, a deployment ledger that
 * was configured later than the contract's actual first event, a dead-letter
 * range an operator wants replayed) without overwhelming RPC providers or
 * re-inserting events the indexer already has.
 *
 * Planning — which ledgers are missing, how to batch them, how long to back
 * off — is pure and unit-testable. Only `runContractBackfill` touches the
 * network or database, and it reuses the main indexer's
 * `persistBatchTransactionally` so backfilled events are deduplicated the
 * same way live-polled events are (identity-hash upsert on RawSorobanEvent).
 */

import {
  type ContractStreamConfig,
  streamKey,
} from "./contractRegistry";
import {
  normalizeSorobanEvent,
  persistBatchTransactionally,
  type IndexerPrismaClient,
  type RawRpcEvent,
} from "./indexer";

export interface LedgerRange {
  start: number;
  end: number;
}

export type BackfillBatchStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped"
  | "failed";

export interface BackfillBatch {
  range: LedgerRange;
  status: BackfillBatchStatus;
  attempts: number;
  lastError: string | null;
  eventsIndexed: number;
}

export const BACKFILL_THRESHOLDS = {
  /** Ledgers per backfill batch, kept well under an RPC provider's page/window limits. */
  maxLedgersPerBatch: 2_000,
  /** Retries per batch before it is given up on and marked skipped. */
  maxAttemptsPerBatch: 5,
  /** Base delay (ms) for exponential backoff between retries. */
  baseRetryDelayMs: 2_000,
  /** Backoff cap (ms). */
  maxRetryDelayMs: 60_000,
  /** Extra multiplier applied to backoff when the provider signals a rate limit (HTTP 429). */
  rateLimitBackoffMultiplier: 4,
} as const;

// ── Pure range math ───────────────────────────────────────────────────────

/** Merge overlapping/adjacent ledger ranges into a minimal sorted set. */
export function mergeRanges(ranges: LedgerRange[]): LedgerRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .map((range) => ({ ...range }))
    .sort((a, b) => a.start - b.start);
  const merged: LedgerRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Missing ranges = fullRange minus every already-indexed range, i.e. the
 * gaps a backfill needs to recover. Overlapping already-indexed ranges are
 * merged first so overlaps never produce spurious gaps.
 */
export function computeMissingRanges(
  fullRange: LedgerRange,
  indexedRanges: LedgerRange[],
): LedgerRange[] {
  if (fullRange.start > fullRange.end) return [];

  const covered = mergeRanges(indexedRanges).filter(
    (range) => range.end >= fullRange.start && range.start <= fullRange.end,
  );

  const gaps: LedgerRange[] = [];
  let cursor = fullRange.start;

  for (const range of covered) {
    const clampedStart = Math.max(range.start, fullRange.start);
    const clampedEnd = Math.min(range.end, fullRange.end);
    if (clampedStart > cursor) {
      gaps.push({ start: cursor, end: clampedStart - 1 });
    }
    cursor = Math.max(cursor, clampedEnd + 1);
  }

  if (cursor <= fullRange.end) {
    gaps.push({ start: cursor, end: fullRange.end });
  }

  return gaps;
}

/** Split gaps into provider-safe, bounded batches ordered oldest-first. */
export function planBackfillBatches(
  gaps: LedgerRange[],
  maxLedgersPerBatch: number = BACKFILL_THRESHOLDS.maxLedgersPerBatch,
): LedgerRange[] {
  const batches: LedgerRange[] = [];

  for (const gap of mergeRanges(gaps)) {
    let start = gap.start;
    while (start <= gap.end) {
      const end = Math.min(start + maxLedgersPerBatch - 1, gap.end);
      batches.push({ start, end });
      start = end + 1;
    }
  }

  return batches;
}

// ── RPC error classification / backoff ────────────────────────────────────

export type RpcErrorClass = "rate_limited" | "retryable" | "terminal";

function extractHttpStatus(error: Record<string, unknown>): number | undefined {
  if (typeof error.status === "number") return error.status;
  const response = error.response;
  if (typeof response === "object" && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Classifies an RPC error so the caller knows whether to back off, retry, or give up. */
export function classifyRpcError(error: unknown): RpcErrorClass {
  if (typeof error !== "object" || error === null) return "terminal";
  const err = error as Record<string, unknown>;
  const status = extractHttpStatus(err);

  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500) return "retryable";
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
    return "retryable";
  }
  return "terminal";
}

/** Exponential backoff, amplified for rate-limit responses so we pull back harder. */
export function computeBackoffDelayMs(
  attempt: number,
  errorClass: RpcErrorClass,
  thresholds: Pick<
    typeof BACKFILL_THRESHOLDS,
    "baseRetryDelayMs" | "maxRetryDelayMs" | "rateLimitBackoffMultiplier"
  > = BACKFILL_THRESHOLDS,
): number {
  const multiplier = errorClass === "rate_limited" ? thresholds.rateLimitBackoffMultiplier : 1;
  const delay = thresholds.baseRetryDelayMs * multiplier * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, thresholds.maxRetryDelayMs);
}

// ── Progress tracking (in-memory, per stream) ─────────────────────────────

export interface BackfillSummary {
  streamKey: string;
  totalBatches: number;
  processed: number;
  skipped: number;
  failed: number;
  pending: number;
  eventsIndexed: number;
  updatedAt: string;
}

/**
 * Tracks backfill progress, retry attempts, and skipped ranges per stream.
 * In-memory only (mirrors how recent replay errors are tracked for the live
 * indexer) — a process restart re-derives the plan from Prisma state rather
 * than resuming mid-batch, which is safe because persistence is idempotent.
 */
export class BackfillProgressTracker {
  private readonly batches = new Map<string, BackfillBatch[]>();

  plan(key: string, ranges: LedgerRange[]): void {
    this.batches.set(
      key,
      ranges.map((range) => ({
        range,
        status: "pending",
        attempts: 0,
        lastError: null,
        eventsIndexed: 0,
      })),
    );
  }

  private list(key: string): BackfillBatch[] {
    return this.batches.get(key) ?? [];
  }

  private find(key: string, range: LedgerRange): BackfillBatch | undefined {
    return this.list(key).find((b) => b.range.start === range.start && b.range.end === range.end);
  }

  nextPendingBatch(key: string): BackfillBatch | null {
    return this.list(key).find((b) => b.status === "pending") ?? null;
  }

  markInProgress(key: string, range: LedgerRange): void {
    const batch = this.find(key, range);
    if (batch) batch.status = "in_progress";
  }

  markCompleted(key: string, range: LedgerRange, eventsIndexed: number): void {
    const batch = this.find(key, range);
    if (!batch) return;
    batch.status = "completed";
    batch.eventsIndexed = eventsIndexed;
    batch.lastError = null;
  }

  /** Records a failed attempt; the batch goes back to pending until attempts are exhausted, then skipped. */
  markFailed(
    key: string,
    range: LedgerRange,
    error: string,
    maxAttempts: number = BACKFILL_THRESHOLDS.maxAttemptsPerBatch,
  ): BackfillBatchStatus {
    const batch = this.find(key, range);
    if (!batch) return "failed";
    batch.attempts += 1;
    batch.lastError = error;
    batch.status = batch.attempts >= maxAttempts ? "skipped" : "pending";
    return batch.status;
  }

  getSummary(key: string, now: number = Date.now()): BackfillSummary {
    const batches = this.list(key);
    return {
      streamKey: key,
      totalBatches: batches.length,
      processed: batches.filter((b) => b.status === "completed").length,
      skipped: batches.filter((b) => b.status === "skipped").length,
      failed: batches.filter((b) => b.status === "failed").length,
      pending: batches.filter((b) => b.status === "pending" || b.status === "in_progress").length,
      eventsIndexed: batches.reduce((sum, b) => sum + b.eventsIndexed, 0),
      updatedAt: new Date(now).toISOString(),
    };
  }

  getBatches(key: string): BackfillBatch[] {
    return this.list(key).map((batch) => ({ ...batch, range: { ...batch.range } }));
  }

  reset(key?: string): void {
    if (key) this.batches.delete(key);
    else this.batches.clear();
  }
}

export const backfillProgress = new BackfillProgressTracker();

// ── Orchestration ─────────────────────────────────────────────────────────

export type FetchEventsForRangeFn = (startLedger: number) => Promise<{
  events: RawRpcEvent[];
  terminalCursor: string | null;
  pagesProcessed: number;
}>;

export interface BackfillRunResult {
  streamKey: string;
  summary: BackfillSummary;
  pausedForRateLimit: boolean;
}

/**
 * Runs backfill batches for a stream, one at a time, until the plan is
 * exhausted, paused for a rate limit, or the caller's retry budget is used
 * up per batch. Returns immediately (without throwing) when the provider
 * rate-limits us, so the caller can reschedule the rest of the plan later
 * instead of hammering the RPC endpoint.
 *
 * Already-indexed events are naturally deduplicated: `persistBatchTransactionally`
 * upserts on `RawSorobanEvent.identity`, so replaying a batch that overlaps
 * existing data never creates duplicates.
 */
export async function runContractBackfill(
  prisma: IndexerPrismaClient,
  stream: ContractStreamConfig,
  fullRange: LedgerRange,
  indexedRanges: LedgerRange[],
  fetchEventsForRange: FetchEventsForRangeFn,
): Promise<BackfillRunResult> {
  const key = streamKey(stream);
  const gaps = computeMissingRanges(fullRange, indexedRanges);
  const plannedBatches = planBackfillBatches(gaps);
  backfillProgress.plan(key, plannedBatches);

  let batch = backfillProgress.nextPendingBatch(key);

  while (batch) {
    const range = batch.range;
    backfillProgress.markInProgress(key, range);

    try {
      const { events, terminalCursor } = await fetchEventsForRange(range.start);
      const boundedEvents = events.filter((event) => event.ledger <= range.end);
      const normalizedEvents = boundedEvents.map((event, ordinal) =>
        normalizeSorobanEvent(stream, event, ordinal),
      );

      await persistBatchTransactionally(prisma, stream, normalizedEvents, range.end, terminalCursor);
      backfillProgress.markCompleted(key, range, normalizedEvents.length);
    } catch (error) {
      const errorClass = classifyRpcError(error);
      const message = error instanceof Error ? error.message : String(error);

      if (errorClass === "rate_limited") {
        const delay = computeBackoffDelayMs(batch.attempts + 1, errorClass);
        backfillProgress.markFailed(key, range, `Rate limited: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return {
          streamKey: key,
          summary: backfillProgress.getSummary(key),
          pausedForRateLimit: true,
        };
      }

      const status = backfillProgress.markFailed(key, range, message);
      if (status === "pending") {
        const delay = computeBackoffDelayMs(batch.attempts, errorClass);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    batch = backfillProgress.nextPendingBatch(key);
  }

  return {
    streamKey: key,
    summary: backfillProgress.getSummary(key),
    pausedForRateLimit: false,
  };
}

// ── Checkpoint-derived range helper ────────────────────────────────────────

type BackfillCheckpointPrismaClient = {
  indexerCheckpoint: {
    findUnique(args: {
      where: { network_contractId: { network: string; contractId: string } };
    }): Promise<{ lastLedger: number } | null>;
  };
};

/**
 * Derives the "already indexed" range for a stream from its durable
 * checkpoint: everything from the configured deployment ledger up to the
 * last committed ledger is assumed covered (the live indexer only advances
 * the checkpoint after a batch commits successfully, so there are no
 * internal gaps within that span under normal operation).
 */
export async function deriveIndexedRangeFromCheckpoint(
  prisma: BackfillCheckpointPrismaClient,
  stream: ContractStreamConfig,
): Promise<LedgerRange | null> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { network_contractId: { network: stream.network, contractId: stream.contractId } },
  });

  if (!checkpoint || checkpoint.lastLedger < stream.deploymentLedger) {
    return null;
  }

  return { start: stream.deploymentLedger, end: checkpoint.lastLedger };
}
