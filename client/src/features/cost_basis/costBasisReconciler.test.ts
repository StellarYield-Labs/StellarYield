import { describe, it, expect } from "vitest";
import {
  reconcileEventSources,
  buildCostBasisReport,
  reconcilePortfolioCostBasis,
} from "./costBasisReconciler";
import type { LedgerEvent } from "./types";

function ev(overrides: Partial<LedgerEvent> & Pick<LedgerEvent, "id" | "type" | "asset" | "quantity" | "timestamp">): LedgerEvent {
  return {
    priceUsd: 1,
    source: "indexer",
    ...overrides,
  };
}

describe("buildCostBasisReport — deposit-only portfolios", () => {
  it("tracks a single deposit as one open principal lot with no realized gain", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.disposals).toEqual([]);
    expect(report.lots).toHaveLength(1);
    expect(report.lots[0]).toMatchObject({
      asset: "XLM",
      origin: "principal",
      quantityRemaining: "100",
      unitCostUsd: 0.1,
    });
    expect(report.totals.principalCostBasisUsd).toBeCloseTo(10, 6);
    expect(report.totals.rewardCostBasisUsd).toBe(0);
    expect(report.totals.realizedGainUsd).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it("accumulates multiple deposits into multiple lots for the same asset", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "USDC", quantity: "500", priceUsd: 1, timestamp: 1000 }),
      ev({ id: "d2", type: "acquisition", asset: "USDC", quantity: "300", priceUsd: 1, timestamp: 2000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.lots).toHaveLength(2);
    expect(report.totals.principalCostBasisUsd).toBeCloseTo(800, 6);
  });
});

describe("buildCostBasisReport — reward-heavy portfolios", () => {
  it("keeps reward lots separate from principal so earned value is distinguishable", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "YIELD", quantity: "1000", priceUsd: 2, timestamp: 1000 }),
      ev({ id: "r1", type: "reward", asset: "YIELD", quantity: "50", priceUsd: 2.5, timestamp: 2000 }),
      ev({ id: "r2", type: "reward", asset: "YIELD", quantity: "40", priceUsd: 2.6, timestamp: 3000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.totals.principalCostBasisUsd).toBeCloseTo(2000, 6);
    expect(report.totals.rewardCostBasisUsd).toBeCloseTo(50 * 2.5 + 40 * 2.6, 6);
    const rewardLots = report.lots.filter((l) => l.origin === "reward");
    expect(rewardLots).toHaveLength(2);
  });

  it("a disposal against reward-only holdings realizes gain against the reward lot's cost basis", () => {
    const events: LedgerEvent[] = [
      ev({ id: "r1", type: "reward", asset: "YIELD", quantity: "100", priceUsd: 2, timestamp: 1000 }),
      ev({ id: "s1", type: "disposal", asset: "YIELD", quantity: "100", priceUsd: 3, timestamp: 2000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.disposals).toHaveLength(1);
    expect(report.disposals[0]).toMatchObject({
      lotOrigin: "reward",
      costBasisUsd: 200,
      proceedsUsd: 300,
      realizedGainUsd: 100,
    });
    expect(report.lots).toEqual([]);
  });
});

describe("buildCostBasisReport — swap-heavy portfolios", () => {
  it("FIFO-matches a partial disposal against the oldest lot first", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000 }),
      ev({ id: "d2", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.2, timestamp: 2000 }),
      // Swap out 150 — consumes all of the first (cheaper) lot plus half of the second.
      ev({ id: "s1", type: "disposal", asset: "XLM", quantity: "150", priceUsd: 0.3, timestamp: 3000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.disposals).toHaveLength(1);
    // costBasis = 100 * 0.1 + 50 * 0.2 = 20
    expect(report.disposals[0].costBasisUsd).toBeCloseTo(20, 6);
    expect(report.disposals[0].proceedsUsd).toBeCloseTo(45, 6);
    expect(report.disposals[0].realizedGainUsd).toBeCloseTo(25, 6);

    // 50 units of the second lot remain open.
    expect(report.lots).toHaveLength(1);
    expect(report.lots[0]).toMatchObject({ quantityRemaining: "50", unitCostUsd: 0.2 });
  });

  it("a chain of swaps (swap-in then swap-out) realizes gain on the swapped-in asset", () => {
    const events: LedgerEvent[] = [
      ev({ id: "swap-in", type: "acquisition", asset: "USDC", quantity: "1000", priceUsd: 1, timestamp: 1000 }),
      ev({ id: "swap-out", type: "disposal", asset: "USDC", quantity: "1000", priceUsd: 1.05, timestamp: 2000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.totals.realizedGainUsd).toBeCloseTo(50, 6);
    expect(report.lots).toEqual([]);
  });

  it("flags an over-disposal (more sold than was ever acquired) instead of corrupting totals", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000 }),
      ev({ id: "s1", type: "disposal", asset: "XLM", quantity: "150", priceUsd: 0.2, timestamp: 2000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: "INSUFFICIENT_COST_BASIS" }),
    );
    // Cost basis is unknown (not a corrupted partial number), so the
    // disposal's gain must not be reported as a concrete figure.
    expect(report.disposals[0].costBasisUsd).toBeNull();
    expect(report.disposals[0].realizedGainUsd).toBeNull();
  });
});

describe("buildCostBasisReport — missing price data", () => {
  it("does not treat a null price as zero — cost basis stays unknown, not corrupted", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "OBSCURE", quantity: "10", priceUsd: null, timestamp: 1000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.lots[0].unitCostUsd).toBeNull();
    expect(report.totals.unrealizedCostBasisUsd).toBe(0); // unknown-cost lots excluded from the sum, not counted as $0
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ code: "MISSING_PRICE_DATA", context: expect.objectContaining({ eventId: "d1" }) }),
    );
  });

  it("propagates unknown cost basis through a disposal that consumes a price-less lot", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "OBSCURE", quantity: "10", priceUsd: null, timestamp: 1000 }),
      ev({ id: "s1", type: "disposal", asset: "OBSCURE", quantity: "10", priceUsd: 5, timestamp: 2000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.disposals[0].costBasisUsd).toBeNull();
    expect(report.disposals[0].realizedGainUsd).toBeNull();
    // Proceeds are still known even though cost basis isn't.
    expect(report.disposals[0].proceedsUsd).toBe(50);
  });

  it("a disposal with unknown proceeds also yields an unknown realized gain even with known cost basis", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "XLM", quantity: "10", priceUsd: 0.1, timestamp: 1000 }),
      ev({ id: "s1", type: "disposal", asset: "XLM", quantity: "10", priceUsd: null, timestamp: 2000 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.disposals[0].costBasisUsd).toBeCloseTo(1, 6);
    expect(report.disposals[0].proceedsUsd).toBeNull();
    expect(report.disposals[0].realizedGainUsd).toBeNull();
  });
});

describe("buildCostBasisReport — fees", () => {
  it("consumes lot quantity for a fee but does not report it as a realized disposal", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000 }),
      ev({ id: "f1", type: "fee", asset: "XLM", quantity: "1", priceUsd: 0.1, timestamp: 1500 }),
    ];

    const report = buildCostBasisReport(events);

    expect(report.disposals).toEqual([]);
    expect(report.lots[0].quantityRemaining).toBe("99");
  });
});

describe("buildCostBasisReport — mixed portfolios and same-block ordering", () => {
  it("processes deposits, rewards, swaps, and fees together in the right order", () => {
    const events: LedgerEvent[] = [
      ev({ id: "d1", type: "acquisition", asset: "XLM", quantity: "1000", priceUsd: 0.1, timestamp: 1000 }),
      ev({ id: "r1", type: "reward", asset: "XLM", quantity: "50", priceUsd: 0.12, timestamp: 2000 }),
      ev({ id: "f1", type: "fee", asset: "XLM", quantity: "5", priceUsd: 0.12, timestamp: 2500 }),
      ev({ id: "s1", type: "disposal", asset: "XLM", quantity: "1000", priceUsd: 0.15, timestamp: 3000 }),
    ];

    const report = buildCostBasisReport(events);

    // Disposal of 1000 consumes: fee already took 5 from the 1000-lot,
    // leaving 995 principal + 50 reward = 1045 available; 1000 consumed
    // FIFO drains the whole (995-unit) principal lot plus 5 of the reward
    // lot, leaving 45 reward units open.
    expect(report.lots).toHaveLength(1);
    expect(report.lots[0]).toMatchObject({ origin: "reward", quantityRemaining: "45" });
    expect(report.disposals).toHaveLength(1);
    expect(report.disposals[0].lotOrigin).toBe("principal");
  });

  it("orders same-timestamp events by their explicit sequence, not input order", () => {
    // A swap-in and swap-out that land in the same ledger close (timestamp)
    // must be applied in on-chain operation order (sequence), regardless of
    // which order they appear in the input array.
    const swapOut: LedgerEvent = ev({
      id: "out",
      type: "disposal",
      asset: "XLM",
      quantity: "100",
      priceUsd: 0.2,
      timestamp: 5000,
      sequence: 2,
    });
    const swapIn: LedgerEvent = ev({
      id: "in",
      type: "acquisition",
      asset: "XLM",
      quantity: "100",
      priceUsd: 0.15,
      timestamp: 5000,
      sequence: 1,
    });

    // Deliberately pass the disposal before the acquisition in the input.
    const report = buildCostBasisReport([swapOut, swapIn]);

    expect(report.warnings.some((w) => w.code === "INSUFFICIENT_COST_BASIS")).toBe(false);
    expect(report.disposals[0].costBasisUsd).toBeCloseTo(15, 6);
    expect(report.lots).toEqual([]);
  });

  it("produces the same report regardless of input array order (sorted internally)", () => {
    const a = ev({ id: "a", type: "acquisition", asset: "XLM", quantity: "10", priceUsd: 0.1, timestamp: 1000, sequence: 1 });
    const b = ev({ id: "b", type: "reward", asset: "XLM", quantity: "5", priceUsd: 0.1, timestamp: 1000, sequence: 2 });
    const c = ev({ id: "c", type: "disposal", asset: "XLM", quantity: "5", priceUsd: 0.2, timestamp: 2000, sequence: 1 });

    const forward = buildCostBasisReport([a, b, c]);
    const shuffled = buildCostBasisReport([c, a, b]);

    expect(shuffled).toEqual(forward);
  });
});

describe("reconcileEventSources", () => {
  it("dedupes an event the indexer has confirmed, keeping the indexer's copy", () => {
    const walletCopy = ev({ id: "w1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000, source: "wallet", ref: "tx-abc" });
    const indexedCopy = ev({ id: "i1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000, source: "indexer", ref: "tx-abc" });

    const { events, warnings } = reconcileEventSources([walletCopy], [indexedCopy]);

    expect(events).toEqual([indexedCopy]);
    expect(warnings).toEqual([]);
  });

  it("keeps and flags a wallet event the indexer hasn't confirmed yet", () => {
    const pending = ev({ id: "w1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000, source: "wallet", ref: "tx-pending" });

    const { events, warnings } = reconcileEventSources([pending], []);

    expect(events).toEqual([pending]);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "UNCONFIRMED_WALLET_EVENT", context: expect.objectContaining({ eventId: "w1" }) }),
    ]);
  });

  it("includes indexer-only events without any warning", () => {
    const indexedOnly = ev({ id: "i1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000, source: "indexer" });

    const { events, warnings } = reconcileEventSources([], [indexedOnly]);

    expect(events).toEqual([indexedOnly]);
    expect(warnings).toEqual([]);
  });
});

describe("reconcilePortfolioCostBasis — end to end", () => {
  it("merges sources then builds the report, surfacing reconciliation warnings alongside cost-basis warnings", () => {
    const indexedDeposit = ev({ id: "i1", type: "acquisition", asset: "XLM", quantity: "100", priceUsd: 0.1, timestamp: 1000, source: "indexer", ref: "tx-1" });
    const pendingReward = ev({ id: "w1", type: "reward", asset: "XLM", quantity: "10", priceUsd: null, timestamp: 2000, source: "wallet", ref: "tx-2" });

    const report = reconcilePortfolioCostBasis([pendingReward], [indexedDeposit]);

    const codes = report.warnings.map((w) => w.code).sort();
    expect(codes).toEqual(["MISSING_PRICE_DATA", "UNCONFIRMED_WALLET_EVENT"]);
    expect(report.lots).toHaveLength(2);
  });
});
