/**
 * Client-side Failure Harness
 *
 * Provides fetch/API mock factories for the five failure classes so frontend
 * component tests can simulate degraded backend conditions without real network
 * calls.
 *
 * Usage
 * -----
 *   import { mockFetch, FailureMode } from '../test-utils/failureHarness';
 *
 *   beforeEach(() => {
 *     vi.stubGlobal('fetch', mockFetch(FailureMode.TIMEOUT, { delayMs: 100 }));
 *   });
 */

export const FailureMode = {
  TIMEOUT: "TIMEOUT",
  STALE_DATA: "STALE_DATA",
  MALFORMED: "MALFORMED",
  RATE_LIMIT: "RATE_LIMIT",
  HARD_FAILURE: "HARD_FAILURE",
} as const;

export type FailureMode = (typeof FailureMode)[keyof typeof FailureMode];

export interface HarnessOptions {
  /** Timeout: how long before the promise resolves/rejects (ms). Default 5000. */
  delayMs?: number;
  /** Stale: how many ms in the past to back-date fetchedAt fields. Default 5 min. */
  staleness?: number;
  /** Hard failure: error message. */
  errorMessage?: string;
  /** Rate limit: value for Retry-After header (sec). Default 60. */
  retryAfterSec?: number;
  /** Payload to return for STALE_DATA and SUCCESS modes. */
  payload?: unknown;
}

// ── Response Factories ─────────────────────────────────────────────────────

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function make429Response(retryAfterSec: number): Response {
  return new Response(JSON.stringify({ error: "Too Many Requests" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSec),
    },
  });
}

// ── Core Mock Builder ──────────────────────────────────────────────────────

/**
 * Build a `fetch` mock that injects the requested failure class.
 *
 * Pass this to `vi.stubGlobal('fetch', mockFetch(...))` or assign it to
 * `global.fetch` in a `beforeEach`.
 */
export function mockFetch(
  mode: FailureMode,
  opts: HarnessOptions = {},
): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    switch (mode) {
      case FailureMode.TIMEOUT: {
        const delayMs = opts.delayMs ?? 5_000;
        await new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Network timeout after ${delayMs}ms`)), delayMs),
        );
        // unreachable but satisfies TS
        throw new Error("unreachable");
      }

      case FailureMode.STALE_DATA: {
        const staleness = opts.staleness ?? 5 * 60_000;
        const staleDate = new Date(Date.now() - staleness).toISOString();
        const stalePayload = Array.isArray(opts.payload)
          ? opts.payload.map((item: unknown) => ({
              ...(item as Record<string, unknown>),
              fetchedAt: staleDate,
            }))
          : [
              {
                protocol: "Blend",
                asset: "USDC",
                apy: 5.2,
                tvl: 1_000_000,
                risk: "Low",
                change24h: 0.1,
                rewardTokens: ["BLND"],
                category: "Lending",
                fetchedAt: staleDate,
              },
            ];
        return makeJsonResponse(stalePayload);
      }

      case FailureMode.MALFORMED: {
        // Valid HTTP but structurally broken body
        return makeJsonResponse({ totally: "unexpected", shape: null });
      }

      case FailureMode.RATE_LIMIT: {
        return make429Response(opts.retryAfterSec ?? 60);
      }

      case FailureMode.HARD_FAILURE: {
        throw Object.assign(
          new TypeError(opts.errorMessage ?? "Failed to fetch"),
          { code: "ECONNREFUSED" },
        );
      }
    }
  };
}

/**
 * Build a fetch mock that succeeds after `delayMs` and returns the given
 * payload. Useful as a baseline for loading-state assertions.
 */
export function mockFetchSuccess(
  payload: unknown,
  opts: { delayMs?: number } = {},
): typeof fetch {
  return async () => {
    if (opts.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
    return makeJsonResponse(payload);
  };
}

/**
 * Build a fetch mock that returns HTTP 500 (server error).
 */
export function mockFetch500(message = "Internal Server Error"): typeof fetch {
  return async () => makeJsonResponse({ error: message }, 500);
}

// ── Degraded-state sentinel helpers ───────────────────────────────────────

/** Minimum fields an APY entry needs to not be flagged as stale by the component */
export const FRESH_APY_ENTRY = {
  protocol: "Blend",
  asset: "USDC",
  apy: 5.2,
  tvl: 1_000_000,
  risk: "Low",
  change24h: 0.1,
  rewardTokens: ["BLND"],
  category: "Lending",
  fetchedAt: new Date().toISOString(),
};

export const STALE_APY_ENTRY = {
  ...FRESH_APY_ENTRY,
  fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min old
};
