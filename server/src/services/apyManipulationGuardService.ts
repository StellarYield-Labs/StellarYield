/**
 * APY Manipulation Guard
 *
 * Thin-liquidity sources are the easiest place to manufacture a fake APY
 * spike: a small pool can post a huge headline rate off a handful of
 * transactions. This module tracks recent (apy, liquidity) samples per
 * source and flags movement that looks manufactured so it can be
 * down-ranked (or excluded) before it reaches recommendations, instead of
 * letting a single thin-liquidity source dominate the top of the list.
 *
 * The classifier is a pure function over explicit inputs so it is trivial
 * to unit test; `evaluateAndRecordManipulationRisk` is the only stateful
 * entry point most callers need.
 */

export interface ApySample {
  apy: number;
  liquidityUsd: number;
  timestamp: number; // ms epoch
}

export type ManipulationRiskLevel = "none" | "warning" | "high";

export interface ManipulationRiskAssessment {
  riskLevel: ManipulationRiskLevel;
  isSuspicious: boolean;
  rule: string | null;
  reason: string | null;
  movementPct: number | null;
  /** Multiplier applied to a source's ranking score. 1 = no discount, 0 = excluded. */
  rankingWeight: number;
}

export const MANIPULATION_GUARD_THRESHOLDS = {
  /** Sources with less liquidity than this (USD) are eligible for manipulation checks. */
  thinLiquidityUsd: 50_000,
  /** Movement is evaluated against samples within this trailing window. */
  shortWindowMs: 15 * 60 * 1000,
  /** Relative APY movement (%) within the short window that triggers a warning. */
  suspiciousMovementPct: 40,
  /** Relative APY movement (%) within the short window that triggers exclusion. */
  extremeMovementPct: 100,
  /** How long samples are retained for movement comparisons. */
  historyWindowMs: 6 * 60 * 60 * 1000,
  /** Cap on retained samples per source, independent of time-based trimming. */
  maxSamplesPerSource: 50,
  /** Ranking multiplier applied to a "warning" level assessment. */
  downRankWeight: 0.35,
  /** Ranking multiplier applied to a "high" level assessment. */
  excludeWeight: 0,
} as const;

const history = new Map<string, ApySample[]>();
const latestAssessments = new Map<string, ManipulationRiskAssessment>();

export function recordApySample(sourceKey: string, sample: ApySample): void {
  const t = MANIPULATION_GUARD_THRESHOLDS;
  const existing = history.get(sourceKey) ?? [];
  const cutoff = sample.timestamp - t.historyWindowMs;
  const trimmed = existing.filter((s) => s.timestamp >= cutoff);
  trimmed.push(sample);
  if (trimmed.length > t.maxSamplesPerSource) {
    trimmed.splice(0, trimmed.length - t.maxSamplesPerSource);
  }
  history.set(sourceKey, trimmed);
}

export function getApyHistory(sourceKey: string): ApySample[] {
  return history.get(sourceKey) ?? [];
}

export function clearManipulationGuardState(sourceKey?: string): void {
  if (sourceKey) {
    history.delete(sourceKey);
    latestAssessments.delete(sourceKey);
  } else {
    history.clear();
    latestAssessments.clear();
  }
}

function relativeMovementPct(previous: number, current: number): number {
  const base = Math.abs(previous);
  if (base < 1e-9) {
    return current === previous ? 0 : 100;
  }
  return (Math.abs(current - previous) / base) * 100;
}

/**
 * Pure classifier: does this (current APY, current liquidity, recent
 * samples) combination look like manufactured thin-liquidity movement?
 *
 * Movement is measured against the oldest sample still inside the short
 * window, so once liquidity or APY has been stable across the window the
 * source naturally falls back to "none" without any separate recovery
 * bookkeeping.
 */
export function classifyManipulationRisk(
  currentApy: number,
  currentLiquidityUsd: number,
  recentSamples: ApySample[],
  now: number,
): ManipulationRiskAssessment {
  const t = MANIPULATION_GUARD_THRESHOLDS;
  const isThinLiquidity = currentLiquidityUsd < t.thinLiquidityUsd;

  const windowSamples = recentSamples.filter((s) => now - s.timestamp <= t.shortWindowMs);

  if (!isThinLiquidity || windowSamples.length === 0) {
    return {
      riskLevel: "none",
      isSuspicious: false,
      rule: null,
      reason: null,
      movementPct: null,
      rankingWeight: 1,
    };
  }

  const oldestInWindow = windowSamples[0];
  const movementPct = relativeMovementPct(oldestInWindow.apy, currentApy);
  const liquidityLabel = `$${Math.round(currentLiquidityUsd).toLocaleString("en-US")}`;
  const windowMinutes = Math.round(t.shortWindowMs / 60_000);

  if (movementPct >= t.extremeMovementPct) {
    return {
      riskLevel: "high",
      isSuspicious: true,
      rule: "thin_liquidity_extreme_apy_spike",
      reason: `APY moved ${movementPct.toFixed(1)}% in ${windowMinutes}m on ${liquidityLabel} liquidity`,
      movementPct,
      rankingWeight: t.excludeWeight,
    };
  }

  if (movementPct >= t.suspiciousMovementPct) {
    return {
      riskLevel: "warning",
      isSuspicious: true,
      rule: "thin_liquidity_apy_spike",
      reason: `APY moved ${movementPct.toFixed(1)}% in ${windowMinutes}m on thin liquidity (${liquidityLabel})`,
      movementPct,
      rankingWeight: t.downRankWeight,
    };
  }

  return {
    riskLevel: "none",
    isSuspicious: false,
    rule: null,
    reason: null,
    movementPct,
    rankingWeight: 1,
  };
}

/**
 * Stateful entry point: classify the current reading against a source's
 * recorded history, then append the reading to that history so the next
 * call has an up-to-date window.
 */
export function evaluateAndRecordManipulationRisk(
  sourceKey: string,
  currentApy: number,
  currentLiquidityUsd: number,
  now: number = Date.now(),
): ManipulationRiskAssessment {
  const priorSamples = getApyHistory(sourceKey);
  const assessment = classifyManipulationRisk(currentApy, currentLiquidityUsd, priorSamples, now);
  recordApySample(sourceKey, { apy: currentApy, liquidityUsd: currentLiquidityUsd, timestamp: now });
  latestAssessments.set(sourceKey, assessment);
  return assessment;
}

/**
 * Latest recorded assessment for a source key, or a null-ish "none"
 * assessment if the source hasn't been evaluated yet. Used to surface
 * manipulation-risk warnings alongside unrelated source-health signals
 * without recomputing anything.
 */
export function getLatestManipulationAssessment(
  sourceKey: string,
): ManipulationRiskAssessment | null {
  return latestAssessments.get(sourceKey) ?? null;
}

/** Finds the latest assessment for a source whose key matches (case-insensitively) a label. */
export function findLatestManipulationAssessmentByLabel(
  label: string,
): { sourceKey: string; assessment: ManipulationRiskAssessment } | null {
  const needle = label.toLowerCase();
  for (const [sourceKey, assessment] of latestAssessments.entries()) {
    if (needle.includes(sourceKey.toLowerCase()) || sourceKey.toLowerCase().includes(needle)) {
      return { sourceKey, assessment };
    }
  }
  return null;
}

export interface RankableYield {
  totalApy: number;
  netApy?: number;
  manipulationRisk?: ManipulationRiskAssessment;
}

/**
 * Re-orders yields so suspicious thin-liquidity sources can't dominate the
 * top of a recommendation list: entries are sorted by (score * rankingWeight)
 * rather than raw APY, so a flagged high-APY source sinks below honest ones
 * without being silently dropped from the payload.
 */
export function applyManipulationResistantRanking<T extends RankableYield>(entries: T[]): T[] {
  const scoreOf = (entry: T): number => {
    const baseScore = entry.netApy ?? entry.totalApy;
    const weight = entry.manipulationRisk?.rankingWeight ?? 1;
    return baseScore * weight;
  };

  return [...entries].sort((a, b) => scoreOf(b) - scoreOf(a));
}
