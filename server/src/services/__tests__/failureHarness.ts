/* eslint-disable @typescript-eslint/no-unused-vars, no-redeclare, no-useless-escape */
/**
 * Reusable Failure Harness for StellarYield Backend
 *
 * Provides injectable failure behaviour for any async service call.
 * Five canonical failure classes:
 *
 *   1. TIMEOUT           – resolves after an artificially long delay
 *   2. STALE_DATA        – returns a well-formed response whose timestamps
 *                          are far in the past
 *   3. MALFORMED         – returns data that violates the expected schema
 *   4. RATE_LIMIT        – rejects with an HTTP 429-style error
 *   5. HARD_FAILURE      – rejects with a hard network/upstream error
 *
 * Usage
 * -----
 *   import { buildHarnessFor, FailureMode } from './failureHarness';
 *
 *   const harness = buildHarnessFor(async () => myService.fetch());
 *
 *   // Inject a 2-second timeout
 *   const result = await harness.inject(FailureMode.TIMEOUT, { delayMs: 2000 });
 *
 *   // Assert the caller handled it gracefully
 *   expect(result.timedOut).toBe(true);
 */

// ── Types ──────────────────────────────────────────────────────────────────

export const FailureMode = {
  TIMEOUT: "TIMEOUT",
  STALE_DATA: "STALE_DATA",
  MALFORMED: "MALFORMED",
  RATE_LIMIT: "RATE_LIMIT",
  HARD_FAILURE: "HARD_FAILURE",
} as const;

export type FailureMode = (typeof FailureMode)[keyof typeof FailureMode];

export interface HarnessOptions {
  /** Timeout mode: how long to wait before resolving/rejecting (ms). Default 5000. */
  delayMs?: number;
  /** Stale mode: how far in the past to shift timestamps (ms). Default 5 minutes. */
  staleness?: number;
  /** Hard-failure mode: the error message to throw. */
  errorMessage?: string;
  /** Rate-limit mode: retry-after hint in seconds. Default 60. */
  retryAfterSec?: number;
}

export interface HarnessCallResult<T> {
  /** Resolved value, if the call completed. */
  value: T | null;
  /** Rejection error, if the call threw. */
  error: Error | null;
  /** True when an injected timeout fired before the call completed. */
  timedOut: boolean;
  /** Elapsed wall-clock time in ms. */
  elapsedMs: number;
}

// ── Core Harness Builder ───────────────────────────────────────────────────

/**
 * Wrap a service call factory in a failure harness.
 *
 * @param factory  A zero-arg function returning the async service call.
 *                 Re-invoked on every `.inject()` call so state resets.
 */
export function buildHarnessFor<T>(
  factory: () => Promise<T>,
): {
  /** Run the call in the specified failure mode. */
  inject(mode: FailureMode, opts?: HarnessOptions): Promise<HarnessCallResult<T>>;
  /** Run the call without any fault injection (baseline). */
  baseline(): Promise<HarnessCallResult<T>>;
} {
  async function run(
    mode: FailureMode | "BASELINE",
    opts: HarnessOptions = {},
  ): Promise<HarnessCallResult<T>> {
    const start = Date.now();

    if (mode === "BASELINE") {
      try {
        const value = await factory();
        return { value, error: null, timedOut: false, elapsedMs: Date.now() - start };
      } catch (e) {
        return {
          value: null,
          error: e instanceof Error ? e : new Error(String(e)),
          timedOut: false,
          elapsedMs: Date.now() - start,
        };
      }
    }

    switch (mode) {
      case FailureMode.TIMEOUT: {
        const delayMs = opts.delayMs ?? 5_000;
        const raceResult = await Promise.race<HarnessCallResult<T>>([
          factory().then(
            (v) => ({ value: v, error: null, timedOut: false, elapsedMs: Date.now() - start }),
            (e: unknown) => ({
              value: null,
              error: e instanceof Error ? e : new Error(String(e)),
              timedOut: false,
              elapsedMs: Date.now() - start,
            }),
          ),
          new Promise<HarnessCallResult<T>>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  value: null,
                  error: new Error(`Timeout after ${delayMs}ms`),
                  timedOut: true,
                  elapsedMs: Date.now() - start,
                }),
              delayMs,
            ),
          ),
        ]);
        return raceResult;
      }

      case FailureMode.STALE_DATA: {
        try {
          const value = await factory();
          const staleValue = shiftTimestamps(value, opts.staleness ?? 5 * 60_000);
          return { value: staleValue, error: null, timedOut: false, elapsedMs: Date.now() - start };
        } catch (e) {
          return {
            value: null,
            error: e instanceof Error ? e : new Error(String(e)),
            timedOut: false,
            elapsedMs: Date.now() - start,
          };
        }
      }

      case FailureMode.MALFORMED: {
        // Return something that looks vaguely like the right type but is broken.
        const malformed = { __malformed: true, data: null, records: null } as unknown as T;
        return { value: malformed, error: null, timedOut: false, elapsedMs: Date.now() - start };
      }

      case FailureMode.RATE_LIMIT: {
        const retryAfter = opts.retryAfterSec ?? 60;
        const err = Object.assign(new Error("HTTP 429 Too Many Requests"), {
          status: 429,
          retryAfter,
        });
        return { value: null, error: err, timedOut: false, elapsedMs: Date.now() - start };
      }

      case FailureMode.HARD_FAILURE: {
        const msg = opts.errorMessage ?? "upstream service unavailable";
        const err = Object.assign(new Error(msg), {
          code: "ECONNREFUSED",
        });
        return { value: null, error: err, timedOut: false, elapsedMs: Date.now() - start };
      }
    }
  }

  return {
    inject: (mode, opts) => run(mode, opts),
    baseline: () => run("BASELINE"),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Recursively walk an object and push any ISO-string datetime fields
 * `shiftMs` milliseconds into the past.
 *
 * Exported so test files can use it directly when needed.
 */
export function shiftTimestamps<T>(value: T, shiftMs: number): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => shiftTimestamps(item, shiftMs)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && isIsoDate(v)) {
      const shifted = new Date(new Date(v).getTime() - shiftMs);
      result[k] = shifted.toISOString();
    } else if (typeof v === "object") {
      result[k] = shiftTimestamps(v, shiftMs);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s);
}

// ── HTTP Mock Helpers ──────────────────────────────────────────────────────

/**
 * Create a mock Horizon/RPC response factory for the five failure classes.
 * Returns a Jest-compatible mock function.
 *
 * Example:
 *   jest.spyOn(horizon, 'ledgers').mockImplementation(mockHorizonCall(FailureMode.TIMEOUT))
 */
export function mockHorizonCall(
  mode: FailureMode,
  opts: HarnessOptions = {},
): () => { order: () => { limit: () => { call: () => Promise<unknown> } } } {
  const makeCall = (): Promise<unknown> => {
    switch (mode) {
      case FailureMode.TIMEOUT: {
        const delayMs = opts.delayMs ?? 30_000;
        return new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${delayMs}ms`)), delayMs),
        );
      }
      case FailureMode.STALE_DATA: {
        const staleness = opts.staleness ?? 5 * 60_000;
        const staleDate = new Date(Date.now() - staleness).toISOString();
        return Promise.resolve({
          records: [
            {
              sequence: 1,
              closed_at: staleDate,
              successful_transaction_count: 0,
              base_fee_in_stroops: "100",
            },
          ],
        });
      }
      case FailureMode.MALFORMED: {
        return Promise.resolve({ records: null, __broken: true });
      }
      case FailureMode.RATE_LIMIT: {
        return Promise.reject(
          Object.assign(new Error("HTTP 429 Too Many Requests"), { status: 429 }),
        );
      }
      case FailureMode.HARD_FAILURE: {
        return Promise.reject(
          Object.assign(new Error(opts.errorMessage ?? "upstream unavailable"), {
            code: "ECONNREFUSED",
          }),
        );
      }
    }
  };

  return () => ({
    order: () => ({
      limit: () => ({
        call: makeCall,
      }),
    }),
  });
}
