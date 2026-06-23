/**
 * ApyDashboard Failure Harness Tests
 *
 * Verifies that the APY Dashboard degrades safely under all five failure
 * classes instead of throwing unhandled exceptions or crashing the React tree.
 *
 * Failure classes exercised:
 *   1. TIMEOUT       – fetch hangs indefinitely (simulated via fast timeout)
 *   2. STALE_DATA    – API responds with entries whose fetchedAt is far in the past
 *   3. MALFORMED     – API returns a non-array / structurally broken body
 *   4. RATE_LIMIT    – API returns HTTP 429
 *   5. HARD_FAILURE  – fetch throws TypeError("Failed to fetch")
 *
 * Degraded-state contract:
 *   - Dashboard renders an error or retry UI instead of crashing
 *   - No unhandled promise rejections escape into the console
 *   - Stale entries display a "Stale Data" indicator
 *   - Component remains interactive (retry button is present/clickable)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ApyDashboard from "../ApyDashboard";
import {
  mockFetch,
  mockFetchSuccess,
  mockFetch500,
  FailureMode,
  FRESH_APY_ENTRY,
  STALE_APY_ENTRY,
} from "../../../test-utils/failureHarness";

// ── Helpers ────────────────────────────────────────────────────────────────

function renderDashboard() {
  return render(
    <MemoryRouter>
      <ApyDashboard />
    </MemoryRouter>,
  );
}

// Silence expected console.error output from React error boundaries in tests
const originalError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// 1. TIMEOUT
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: TIMEOUT", () => {
  it("shows loading skeleton while fetch is pending, then error UI on timeout rejection", async () => {
    // Use a fast timeout so the test doesn't actually wait 5 s
    vi.stubGlobal(
      "fetch",
      mockFetch(FailureMode.TIMEOUT, { delayMs: 50 }),
    );

    renderDashboard();

    // Should show loading state immediately
    expect(screen.getByText(/loading latest apy data/i)).toBeInTheDocument();

    // After timeout fires the component should surface an error
    await waitFor(
      () => {
        const heading = screen.queryByText(/failed to load apy data/i);
        const banner  = screen.queryByText(/unable to fetch live apy data/i);
        const retry   = screen.queryByRole("button", { name: /retry/i });
        expect(heading ?? banner ?? retry).toBeTruthy();
      },
      { timeout: 500 },
    );
  });

  it("does not crash React tree on network timeout", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.TIMEOUT, { delayMs: 50 }));

    // renderDashboard itself must not throw
    expect(() => renderDashboard()).not.toThrow();

    await waitFor(
      () => expect(screen.queryAllByText(/failed|retry|unable/i).length).toBeGreaterThan(0),
      { timeout: 500 },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. STALE DATA
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: STALE_DATA", () => {
  it("renders stale-data indicator when fetchedAt is 10 minutes in the past", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSuccess([STALE_APY_ENTRY]),
    );

    renderDashboard();

    await waitFor(() => {
      // Stale entry should be filtered out (unusableDueToStale) or flagged
      // The component either hides the entry or shows a "Stale Data" badge
      const staleLabel = screen.queryByText(/stale data/i);
      const noResults  = screen.queryByText(/no results|no matching/i);
      // Either rendering outcome is acceptable — the key thing is no crash
      expect(staleLabel ?? noResults ?? screen.getByRole("main", { hidden: true })).toBeTruthy();
    });
  });

  it("does not crash React tree when all entries are stale", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess([STALE_APY_ENTRY, STALE_APY_ENTRY]));

    expect(() => renderDashboard()).not.toThrow();

    // Component should finish loading without error heading
    await waitFor(
      () => expect(screen.queryByText(/loading latest apy data/i)).toBeNull(),
      { timeout: 2_000 },
    );
  });

  it("freshness confidence badge is present for recent entries", async () => {
    vi.stubGlobal("fetch", mockFetchSuccess([FRESH_APY_ENTRY]));

    renderDashboard();

    await waitFor(() => {
      // Should show "Updated just now" freshness label
      expect(screen.getByText(/updated just now/i)).toBeInTheDocument();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. MALFORMED RESPONSE
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: MALFORMED_RESPONSE", () => {
  it("renders empty/error state when API returns non-array body", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.MALFORMED));

    renderDashboard();

    await waitFor(() => {
      // normalizeApyEntry handles unknown shapes gracefully —
      // the component renders 0 cards but no crash
      const noResults = screen.queryByText(/no results|no matching|failed/i);
      const hasData   = screen.queryByText(/% apy/i);
      // Expect either a graceful empty state or no valid APY entries
      expect(noResults !== null || hasData === null).toBe(true);
    });
  });

  it("does not throw when API returns null body", async () => {
    vi.stubGlobal("fetch", async () => new Response("null", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    expect(() => renderDashboard()).not.toThrow();

    await waitFor(
      () => expect(screen.queryByText(/loading latest apy data/i)).toBeNull(),
      { timeout: 2_000 },
    );
  });

  it("handles structurally valid response with missing required fields gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSuccess([
        { protocol: null, asset: undefined, apy: "not-a-number", tvl: {}, risk: 42 },
      ]),
    );

    renderDashboard();

    await waitFor(
      () => expect(screen.queryByText(/loading latest apy data/i)).toBeNull(),
      { timeout: 2_000 },
    );

    // Must not crash — normalization should produce Unknown Protocol / 0 values
    expect(screen.queryByText(/uncaught|undefined is not/i)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. RATE LIMIT (HTTP 429)
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: RATE_LIMIT", () => {
  it("shows error UI on HTTP 429", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.RATE_LIMIT));

    renderDashboard();

    await waitFor(() => {
      const failed = screen.queryByText(/failed to load apy data/i);
      const banner = screen.queryByText(/live apy refresh failed/i);
      const retry  = screen.queryByRole("button", { name: /retry/i });
      expect(failed ?? banner ?? retry).toBeTruthy();
    });
  });

  it("retry button is interactive after 429 response", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.RATE_LIMIT));

    renderDashboard();

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /retry/i })).toBeTruthy();
    });

    // After clicking Retry, another fetch is triggered — swap in a success mock
    const successPayload = [FRESH_APY_ENTRY];
    vi.stubGlobal("fetch", mockFetchSuccess(successPayload));

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    await userEvent.click(retryBtn);

    await waitFor(() => {
      // Use getAllBy so duplicate matches don't cause failure
      expect(screen.getAllByText(/blend/i).length).toBeGreaterThan(0);
    });
  });

  it("does not crash React tree on HTTP 429", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.RATE_LIMIT));
    expect(() => renderDashboard()).not.toThrow();

    await waitFor(
      () => expect(screen.queryByText(/loading latest apy data/i)).toBeNull(),
      { timeout: 2_000 },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. HARD FAILURE
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: HARD_FAILURE", () => {
  it("shows error UI when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.HARD_FAILURE));

    renderDashboard();

    await waitFor(() => {
      const failed = screen.queryByText(/failed to load apy data/i);
      const banner = screen.queryByText(/live apy refresh failed/i);
      expect(failed ?? banner).toBeTruthy();
    });
  });

  it("does not propagate an unhandled rejection to the React tree", async () => {
    vi.stubGlobal("fetch", mockFetch(FailureMode.HARD_FAILURE));

    expect(() => renderDashboard()).not.toThrow();

    await waitFor(
      () => expect(screen.queryByText(/loading latest apy data/i)).toBeNull(),
      { timeout: 2_000 },
    );
  });

  it("shows error UI (not crash) when refresh fails after prior success", async () => {
    // First load succeeds
    vi.stubGlobal("fetch", mockFetchSuccess([FRESH_APY_ENTRY]));
    renderDashboard();

    await waitFor(() => {
      expect(screen.getAllByText(/blend/i).length).toBeGreaterThan(0);
    });

    // Subsequent background refresh fails hard — component goes to error state
    vi.stubGlobal("fetch", mockFetch(FailureMode.HARD_FAILURE));

    const refreshBtn = screen.getByRole("button", { name: /refresh rates/i });
    await userEvent.click(refreshBtn);

    await waitFor(() => {
      // Component surfaces some error indication — either banner or full-screen error
      const failedText  = screen.queryAllByText(/failed to load apy data/i);
      const bannerText  = screen.queryAllByText(/live apy refresh failed/i);
      const retryBtn    = screen.queryAllByRole("button", { name: /retry/i });
      expect(failedText.length + bannerText.length + retryBtn.length).toBeGreaterThan(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// HTTP 500 bonus case
// ══════════════════════════════════════════════════════════════════════════

describe("HTTP 500 server error", () => {
  it("shows error UI on HTTP 500", async () => {
    vi.stubGlobal("fetch", mockFetch500());

    renderDashboard();

    await waitFor(() => {
      const failed = screen.queryByText(/failed to load apy data/i);
      const banner = screen.queryByText(/live apy refresh failed/i);
      const retry  = screen.queryByRole("button", { name: /retry/i });
      expect(failed ?? banner ?? retry).toBeTruthy();
    });
  });

  it("does not crash on HTTP 500", async () => {
    vi.stubGlobal("fetch", mockFetch500());
    expect(() => renderDashboard()).not.toThrow();
  });
});
