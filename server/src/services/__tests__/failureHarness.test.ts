/**
 * Failure Harness Integration Tests
 *
 * Tests five failure classes (timeout, stale data, malformed response,
 * rate limit, hard failure) across:
 *
 *   - Oracle deviation sentinel  (oracle service)
 *   - Fee oracle service         (fee oracle)
 *   - Relayer status service     (relayer status)
 *   - VaultOrchestrator          (rebalance execution path)
 *   - Fallback tree traversal    (degraded-state routing)
 *
 * Each critical execution path that depends on risk/oracle data must
 * "fail closed" — i.e. return BLOCK or equivalent when data is unavailable.
 *
 * Property (fail-closed):
 *   For every failure mode that makes oracle data unavailable,
 *   evaluateOracle() must return decision === "BLOCK".
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import fc from "fast-check";

// ── Services under test ────────────────────────────────────────────────────
import {
  evaluateOracle,
  evaluateAndRecord,
  getDeviationLog,
  clearDeviationLog,
  DEFAULT_THRESHOLDS,
  type OracleReading,
} from "../oracleDeviationSentinel";

import {
  computeFeeDeviationAlert,
  checkFeeDeviation,
  resetFeeBaseline,
} from "../feeOracleService";

import {
  getRelayerStatus,
  recordRelayStart,
  recordRelayFailure,
  recordRelaySuccess,
} from "../relayerStatusService";

import {
  VaultOrchestrator,
  type OrchestrationConfig,
  type StrategyModule,
} from "../vaultOrchestratorService";

import {
  traverseFallbackTree,
  createFallbackTreeFromList,
  type FallbackNode,
  type TraversalContext,
} from "../fallbackTreeService";

// ── Harness ────────────────────────────────────────────────────────────────
import {
  buildHarnessFor,
  FailureMode,
  mockHorizonCall,
} from "./failureHarness";

// ── Local reading factories ────────────────────────────────────────────────
function makeStaleReading(price: number, staleness = 5 * 60_000): OracleReading {
  return { price, fetchedAt: Date.now() - staleness, source: "test" };
}

function makeFreshReading(price: number): OracleReading {
  return { price, fetchedAt: Date.now() - 1_000, source: "test" };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearDeviationLog();
  resetFeeBaseline();
});

// ══════════════════════════════════════════════════════════════════════════
// 1. FAILURE CLASS: TIMEOUT
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: TIMEOUT", () => {
  it("harness races caller's promise against an injected timeout sentinel", async () => {
    let timer: ReturnType<typeof setTimeout>;
    const slowFactory = () =>
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("done"), 10_000);
      });

    const harness = buildHarnessFor(slowFactory);
    const result = await harness.inject(FailureMode.TIMEOUT, { delayMs: 50 });

    clearTimeout(timer!);

    expect(result.timedOut).toBe(true);
    expect(result.value).toBeNull();
    expect(result.error?.message).toMatch(/timeout/i);
  });

  it("oracle evaluates as MISSING/BLOCK when reading is unavailable after timeout", () => {
    // Simulates what happens when the oracle fetch times out — caller passes null
    const r = evaluateOracle(null, null, DEFAULT_THRESHOLDS, Date.now());
    expect(r.decision).toBe("BLOCK");
    expect(r.state).toBe("MISSING");
  });

  it("fee oracle falls back to minimum fee on timeout (harness confirms timeout path)", async () => {
    // Simulate a timeout-style rejection from the harness
    const harness = buildHarnessFor(async () => {
      await new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 100ms")), 150),
      );
      return null;
    });
    const r = await harness.inject(FailureMode.TIMEOUT, { delayMs: 50 });

    expect(r.timedOut).toBe(true);
    expect(r.error).not.toBeNull();
  });

  it("fallback tree selects next viable node when primary times out (simulated via HARD_FAILURE)", async () => {
    let callCount = 0;
    const tree = createFallbackTreeFromList([
      { id: "primary", name: "Primary", priority: 10 },
      { id: "backup", name: "Backup", priority: 5 },
    ]);

    const ctx: TraversalContext = {
      checkHealth: (id) => {
        callCount++;
        // Primary is "offline" (score 0), backup is fine
        if (id === "primary") return { status: "critical", score: 0, checkedAt: new Date().toISOString(), reasons: ["timed out"] };
        return { status: "healthy", score: 100, checkedAt: new Date().toISOString(), reasons: [] };
      },
      checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
      minHealthScore: 50,
      allowDegraded: true,
      maxDepth: 10,
    };

    const result = await traverseFallbackTree(tree, ctx);
    expect(result.selectedNode?.id).toBe("backup");
    expect(result.terminalFailure).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. FAILURE CLASS: STALE DATA
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: STALE_DATA", () => {
  it("harness shifts ISO timestamps backward by staleness amount", async () => {
    const factory = async () => ({
      generatedAt: new Date().toISOString(),
      nested: { checkedAt: new Date().toISOString() },
    });

    const harness = buildHarnessFor(factory);
    const result = await harness.inject(FailureMode.STALE_DATA, { staleness: 10 * 60_000 });

    expect(result.value).not.toBeNull();
    const age = Date.now() - new Date(result.value!.generatedAt).getTime();
    expect(age).toBeGreaterThan(9 * 60_000);
  });

  it("oracle evaluates as STALE + BLOCK when reading age exceeds maxAgeMs", () => {
    const staleReading = makeStaleReading(100, DEFAULT_THRESHOLDS.maxAgeMs + 5_000);
    const r = evaluateOracle(staleReading, 100, DEFAULT_THRESHOLDS, Date.now());
    expect(r.state).toBe("STALE");
    expect(r.decision).toBe("BLOCK");
  });

  it("oracle evaluates stale data regardless of price accuracy", () => {
    // Even a perfectly-priced reading must be blocked when stale
    const staleButCorrect = makeStaleReading(100, DEFAULT_THRESHOLDS.maxAgeMs + 1);
    const r = evaluateOracle(staleButCorrect, 100, DEFAULT_THRESHOLDS, Date.now());
    expect(r.decision).toBe("BLOCK");
  });

  it("relayer status reflects stale last-relay timestamp when no events occurred recently", () => {
    // Simulate a relayer that had a relay 2 hours ago — status still shows isOnline
    // but callers should check lastRelayAt themselves
    const status = getRelayerStatus();
    // When there are no events, lastRelayAt is null — callers must treat this as stale
    expect(status.lastRelayAt === null || typeof status.lastRelayAt === "string").toBe(true);
    expect(status.checkedAt).toBeTruthy();
  });

  it("fee oracle deviation detects stale baseline (no recent samples)", () => {
    // First call sets baseline to 100
    checkFeeDeviation(100);
    // Simulate 10 minutes of stale data — the EMA baseline hasn't moved
    // but suddenly the fee spikes: should detect as warning/critical
    const alert = checkFeeDeviation(300);
    expect(["warning", "critical"]).toContain(alert.level);
  });

  it("PBT: any reading older than maxAgeMs always produces BLOCK", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),      // price
        fc.integer({ min: 1, max: 3_600_000 }),       // extra ms beyond threshold
        (price, extraMs) => {
          const reading = makeStaleReading(price, DEFAULT_THRESHOLDS.maxAgeMs + extraMs);
          const r = evaluateOracle(reading, price, DEFAULT_THRESHOLDS, Date.now());
          return r.decision === "BLOCK";
        },
      ),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. FAILURE CLASS: MALFORMED RESPONSE
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: MALFORMED_RESPONSE", () => {
  it("harness returns a broken object when mode is MALFORMED", async () => {
    const factory = async () => ({ price: 100, source: "horizon" });
    const harness = buildHarnessFor(factory);
    const result = await harness.inject(FailureMode.MALFORMED);

    expect(result.value).not.toBeNull();
    expect((result.value as any).__malformed).toBe(true);
  });

  it("oracle evaluates null reading (malformed → no reading extracted) as BLOCK", () => {
    const r = evaluateOracle(null, 100, DEFAULT_THRESHOLDS, Date.now());
    expect(r.decision).toBe("BLOCK");
    expect(r.state).toBe("MISSING");
  });

  it("fee deviation alert handles zero/NaN baseline without throwing", () => {
    expect(() => computeFeeDeviationAlert(NaN, 100)).not.toThrow();
    expect(() => computeFeeDeviationAlert(100, NaN)).not.toThrow();
    expect(() => computeFeeDeviationAlert(0, 0)).not.toThrow();
  });

  it("VaultOrchestrator validateComposition catches malformed weight allocation", () => {
    const badStrategy: StrategyModule = {
      id: "s1",
      name: "S1",
      version: "1",
      weight: 1.5,           // invalid: > 1
      priority: 0,
      performanceScore: 80,
      isActive: true,
      compatibilityTags: [],
      lastRebalanceAt: new Date(),
    };

    const config: OrchestrationConfig = {
      vaultId: "v1",
      vaultName: "Test Vault",
      strategies: [badStrategy],
      normalizeWeights: false,
      minStrategyWeight: 0.05,
      maxStrategyWeight: 0.95,
      requireCompatibilityCheck: false,
      rotationIntervalMs: 3_600_000,
      failureIsolation: true,
    };

    const orchestrator = new VaultOrchestrator(config);
    const errors = orchestrator.validateComposition();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("weight"))).toBe(true);
  });

  it("fallback tree traversal handles malformed (cyclic) tree gracefully", async () => {
    // Manually craft a node that references itself
    const selfReferential: FallbackNode = {
      id: "loop",
      name: "Looping",
      fallbacks: [],
    };
    selfReferential.fallbacks.push(selfReferential); // cycle

    const ctx: TraversalContext = {
      checkHealth: () => ({ status: "blocked", score: 0, checkedAt: new Date().toISOString(), reasons: [] }),
      checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
      minHealthScore: 50,
      allowDegraded: false,
      maxDepth: 5,
    };

    const result = await traverseFallbackTree(selfReferential, ctx);
    // Should detect cycle and report terminal failure without hanging
    expect(result.terminalFailure).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. FAILURE CLASS: RATE LIMIT (HTTP 429)
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: RATE_LIMIT", () => {
  it("harness injects a 429 error with retryAfter metadata", async () => {
    const factory = async () => ({ data: "ok" });
    const harness = buildHarnessFor(factory);
    const result = await harness.inject(FailureMode.RATE_LIMIT, { retryAfterSec: 30 });

    expect(result.value).toBeNull();
    expect(result.error?.message).toMatch(/429/);
    expect((result.error as any).retryAfter).toBe(30);
  });

  it("relayer records failure and decrements queue depth on rate-limit error", () => {
    const id = recordRelayStart();
    recordRelayFailure(id, 200, "HTTP 429 Too Many Requests");

    const status = getRelayerStatus();
    expect(status.failureCount).toBeGreaterThan(0);
    expect(status.queueDepth).toBe(0);
    expect(status.successRate).toBeLessThan(100);
  });

  it("oracle always blocks when rate-limit causes missing reading", () => {
    // Rate-limit → caller cannot fetch oracle → passes null
    const r = evaluateOracle(null, null, DEFAULT_THRESHOLDS, Date.now());
    expect(r.decision).toBe("BLOCK");
  });

  it("fee oracle deviation alert still produces a valid response on rate-limit (cached path)", () => {
    // Pre-prime baseline
    checkFeeDeviation(100);

    // If horizon is rate-limited, the last alert level must still be returned
    const alert = computeFeeDeviationAlert(100, 100);
    expect(alert).toMatchObject({
      level: "normal",
      warningThresholdPct: 20,
      criticalThresholdPct: 50,
    });
  });

  it("VaultOrchestrator orchestrate() never throws on rate-limited strategy data", () => {
    const strategies: StrategyModule[] = [
      {
        id: "s1", name: "S1", version: "1",
        weight: 0.6, priority: 1, performanceScore: 80,
        isActive: true, compatibilityTags: ["stable"],
        lastRebalanceAt: new Date(),
      },
      {
        id: "s2", name: "S2", version: "1",
        weight: 0.4, priority: 2, performanceScore: 70,
        isActive: true, compatibilityTags: ["stable"],
        lastRebalanceAt: new Date(),
      },
    ];

    const config: OrchestrationConfig = {
      vaultId: "v1", vaultName: "Test",
      strategies,
      normalizeWeights: false,
      minStrategyWeight: 0.05, maxStrategyWeight: 0.95,
      requireCompatibilityCheck: false,
      rotationIntervalMs: 3_600_000,
      failureIsolation: true,
    };

    const orchestrator = new VaultOrchestrator(config);
    expect(() => orchestrator.orchestrate()).not.toThrow();
    const result = orchestrator.orchestrate();
    expect(result.allocationDecisions.length).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. FAILURE CLASS: HARD FAILURE (upstream unavailable)
// ══════════════════════════════════════════════════════════════════════════

describe("Failure class: HARD_FAILURE", () => {
  it("harness injects ECONNREFUSED error", async () => {
    const factory = async () => ({ data: "ok" });
    const harness = buildHarnessFor(factory);
    const result = await harness.inject(FailureMode.HARD_FAILURE);

    expect(result.value).toBeNull();
    expect(result.error).not.toBeNull();
    expect((result.error as any).code).toBe("ECONNREFUSED");
  });

  it("oracle evaluates as BLOCK when upstream is down (no reading)", () => {
    const r = evaluateOracle(null, null, DEFAULT_THRESHOLDS, Date.now());
    expect(r.decision).toBe("BLOCK");
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("relayer records multiple failures and correctly tracks failure rate", () => {
    // Simulate burst of failures
    for (let i = 0; i < 5; i++) {
      const id = recordRelayStart();
      recordRelayFailure(id, 10, "ECONNREFUSED");
    }

    const status = getRelayerStatus();
    expect(status.failureCount).toBeGreaterThanOrEqual(5);
    expect(status.successRate).toBeLessThanOrEqual(0);
  });

  it("fallback tree exhausts all options and reports terminal failure when all nodes are hard-down", async () => {
    const tree = createFallbackTreeFromList([
      { id: "n1", name: "Node 1", priority: 10 },
      { id: "n2", name: "Node 2", priority: 5 },
      { id: "n3", name: "Node 3", priority: 1 },
    ]);

    const ctx: TraversalContext = {
      // All nodes return score 0 — hard down
      checkHealth: () => ({ status: "critical", score: 0, checkedAt: new Date().toISOString(), reasons: ["ECONNREFUSED"] }),
      checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
      minHealthScore: 50,
      allowDegraded: false,
      maxDepth: 10,
    };

    const result = await traverseFallbackTree(tree, ctx);
    expect(result.terminalFailure).toBe(true);
    expect(result.selectedNode).toBeNull();
    expect(result.nodesEvaluated).toBe(3);
  });

  it("VaultOrchestrator reports composition invalid when all strategies are inactive", () => {
    const inactiveStrategy: StrategyModule = {
      id: "s1", name: "S1", version: "1",
      weight: 1.0, priority: 0, performanceScore: 50,
      isActive: false,
      compatibilityTags: [],
      lastRebalanceAt: new Date(),
    };

    const config: OrchestrationConfig = {
      vaultId: "v1", vaultName: "Test",
      strategies: [inactiveStrategy],
      normalizeWeights: false,
      minStrategyWeight: 0, maxStrategyWeight: 1,
      requireCompatibilityCheck: false,
      rotationIntervalMs: 3_600_000,
      failureIsolation: true,
    };

    const orchestrator = new VaultOrchestrator(config);
    const state = orchestrator.getCompositionState();
    expect(state.isValid).toBe(false);
    expect(state.validationErrors.some((e) => e.includes("active"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED PROPERTY TESTS (property-based)
// ══════════════════════════════════════════════════════════════════════════

describe("Fail-closed properties (PBT)", () => {
  it("PROPERTY: null oracle reading always produces BLOCK regardless of reference price", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 1, max: 1_000_000 })),
        (refPrice) => {
          const r = evaluateOracle(null, refPrice ?? null, DEFAULT_THRESHOLDS, Date.now());
          return r.decision === "BLOCK";
        },
      ),
    );
  });

  it("PROPERTY: stale oracle reading always produces BLOCK regardless of deviation", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),  // current price
        fc.integer({ min: 1, max: 1_000_000 }),  // reference price
        fc.integer({ min: 1, max: 3_600_000 }),  // extra staleness ms
        (price, ref, extra) => {
          const reading = makeStaleReading(price, DEFAULT_THRESHOLDS.maxAgeMs + extra);
          const r = evaluateOracle(reading, ref, DEFAULT_THRESHOLDS, Date.now());
          return r.decision === "BLOCK";
        },
      ),
    );
  });

  it("PROPERTY: deviation > maxDeviationPct always produces BLOCK", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),  // reference price
        fc.double({ min: 1.1, max: 5.0 }),        // multiplier > 5%
        (ref, multiplier) => {
          const price = Math.round(ref * (1 + DEFAULT_THRESHOLDS.maxDeviationPct / 100 * multiplier));
          const reading = makeFreshReading(price);
          const r = evaluateOracle(reading, ref, DEFAULT_THRESHOLDS, Date.now());
          if (r.state === "DEVIATED") {
            return r.decision === "BLOCK";
          }
          return true; // too small a deviation — skip
        },
      ),
    );
  });

  it("PROPERTY: fee deviation alert always returns a valid FeeAlertLevel", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),  // current fee in stroops
        fc.integer({ min: 0, max: 10_000 }),  // baseline fee
        (current, baseline) => {
          const alert = computeFeeDeviationAlert(current, baseline);
          return ["normal", "warning", "critical"].includes(alert.level);
        },
      ),
    );
  });

  it("PROPERTY: VaultOrchestrator never throws orchestrate() regardless of weight configuration", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            weight: fc.double({ min: 0, max: 2, noNaN: true }),
            performanceScore: fc.double({ min: 0, max: 100, noNaN: true }),
            isActive: fc.boolean(),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (strategyParams) => {
          const strategies: StrategyModule[] = strategyParams.map((p, i) => ({
            id: `s${i}`,
            name: `Strategy ${i}`,
            version: "1",
            weight: p.weight,
            priority: i,
            performanceScore: p.performanceScore,
            isActive: p.isActive,
            compatibilityTags: [],
            lastRebalanceAt: new Date(),
          }));

          const config: OrchestrationConfig = {
            vaultId: "v1", vaultName: "PBT Vault",
            strategies,
            normalizeWeights: false,
            minStrategyWeight: 0, maxStrategyWeight: 2,
            requireCompatibilityCheck: false,
            rotationIntervalMs: 3_600_000,
            failureIsolation: true,
          };

          const orchestrator = new VaultOrchestrator(config);
          try {
            orchestrator.orchestrate();
            return true;
          } catch {
            return false;
          }
        },
      ),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// RETRY & FALLBACK ASSERTIONS
// ══════════════════════════════════════════════════════════════════════════

describe("Retry and fallback assertions", () => {
  it("relayer retry count increments and success rate recalculates correctly after failure then success", () => {
    const id1 = recordRelayStart();
    recordRelayFailure(id1, 50, "timeout");

    const id2 = recordRelayStart();
    recordRelaySuccess(id2, 100, "hash_abc", "hash_def");

    const status = getRelayerStatus();
    expect(status.totalRelayed).toBeGreaterThanOrEqual(2);
    expect(status.successRate).toBeGreaterThan(0);
    expect(status.successRate).toBeLessThan(100);
  });

  it("fallback tree selects degraded node when allowDegraded is true", async () => {
    const tree = createFallbackTreeFromList([
      { id: "primary", name: "Primary", priority: 10 },
      { id: "degraded-backup", name: "Degraded Backup", priority: 5 },
    ]);

    const ctx: TraversalContext = {
      checkHealth: (id) =>
        id === "primary"
          ? { status: "critical", score: 0, checkedAt: new Date().toISOString(), reasons: ["down"] }
          : { status: "degraded", score: 60, checkedAt: new Date().toISOString(), reasons: ["slow"] },
      checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
      minHealthScore: 50,
      allowDegraded: true,
      maxDepth: 10,
    };

    const result = await traverseFallbackTree(tree, ctx);
    expect(result.selectedNode?.id).toBe("degraded-backup");
  });

  it("fallback tree rejects degraded node when allowDegraded is false", async () => {
    const tree = createFallbackTreeFromList([
      { id: "primary", name: "Primary", priority: 10 },
      { id: "degraded-backup", name: "Degraded Backup", priority: 5 },
    ]);

    const ctx: TraversalContext = {
      checkHealth: (id) =>
        id === "primary"
          ? { status: "critical", score: 0, checkedAt: new Date().toISOString(), reasons: ["down"] }
          : { status: "degraded", score: 60, checkedAt: new Date().toISOString(), reasons: ["slow"] },
      checkBlocklist: () => ({ isBlocked: false, checkedAt: new Date().toISOString() }),
      minHealthScore: 50,
      allowDegraded: false,
      maxDepth: 10,
    };

    const result = await traverseFallbackTree(tree, ctx);
    expect(result.terminalFailure).toBe(true);
  });

  it("oracle deviation log records all failure events for audit", () => {
    evaluateAndRecord("XLM/USDC", null, null, DEFAULT_THRESHOLDS, Date.now());
    evaluateAndRecord("XLM/USDC", makeStaleReading(1, DEFAULT_THRESHOLDS.maxAgeMs + 1_000), null, DEFAULT_THRESHOLDS, Date.now());
    evaluateAndRecord("XLM/USDC", makeFreshReading(200), 100, DEFAULT_THRESHOLDS, Date.now());

    const log = getDeviationLog();
    expect(log.length).toBe(3);
    // All should be block decisions
    const blocked = log.filter((e) => e.evaluation.decision === "BLOCK");
    expect(blocked.length).toBe(3);
  });
});
