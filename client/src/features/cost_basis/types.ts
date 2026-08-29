/**
 * Portfolio cost-basis reconciliation — shared types.
 *
 * A "ledger event" is a normalized representation of anything that moves an
 * asset balance: a deposit/swap-in (acquisition), a withdrawal/swap-out
 * (disposal), a reward claim, or a protocol fee. Two independent sources
 * observe these — the connected wallet (which may see pending/local state)
 * and the on-chain indexer (authoritative once confirmed) — and must be
 * reconciled into one timeline before cost-basis lots can be built.
 */

/** What kind of balance movement this event represents. */
export type LedgerEventType = "acquisition" | "disposal" | "reward" | "fee";

/** Which side observed this event. */
export type LedgerEventSource = "wallet" | "indexer";

export interface LedgerEvent {
  /** Stable identifier for this event (e.g. tx hash, or tx hash + log index). */
  id: string;
  type: LedgerEventType;
  /** Asset code, e.g. "XLM", "USDC", "YIELD". */
  asset: string;
  /** Quantity moved, as a decimal string. Always positive — direction comes from `type`. */
  quantity: string;
  /**
   * USD price per unit at the time of the event. `null` means the price
   * could not be determined (oracle gap, unsupported asset, etc.) — cost
   * basis and realized-gain figures derived from this event are then
   * themselves unknown, not zero.
   */
  priceUsd: number | null;
  /** Unix seconds. */
  timestamp: number;
  /**
   * Tiebreaker for events sharing a timestamp (e.g. multiple operations in
   * the same ledger close / same block) — typically the on-chain operation
   * index. Ordering falls back to `id` when omitted, which is stable but
   * not necessarily chain-accurate, so same-block inputs should set this.
   */
  sequence?: number;
  source: LedgerEventSource;
  /**
   * Cross-reference used to match the same underlying transaction as seen
   * by both `wallet` and `indexer` sources during reconciliation. Defaults
   * to `id` when omitted.
   */
  ref?: string;
}

/** Where a lot's underlying value originally came from. */
export type LotOrigin = "principal" | "reward";

/** An open (not yet fully disposed) cost-basis lot for one asset. */
export interface CostBasisLot {
  asset: string;
  origin: LotOrigin;
  quantityRemaining: string;
  /** `null` when the acquiring event had no price data. */
  unitCostUsd: number | null;
  acquiredAt: number;
  sourceEventId: string;
}

/** The realized outcome of consuming (part of) one or more lots via a disposal event. */
export interface RealizedDisposal {
  asset: string;
  disposalEventId: string;
  quantity: string;
  proceedsUsd: number | null;
  costBasisUsd: number | null;
  /** `null` whenever proceeds or cost basis is unknown — never a guessed zero. */
  realizedGainUsd: number | null;
  lotOrigin: LotOrigin;
  timestamp: number;
}

export type CostBasisWarningCode =
  | "MISSING_PRICE_DATA"
  | "UNCONFIRMED_WALLET_EVENT"
  | "INSUFFICIENT_COST_BASIS";

export interface CostBasisWarning {
  code: CostBasisWarningCode;
  message: string;
  context?: Record<string, unknown>;
}

export interface CostBasisTotals {
  /** Sum of realized gains/losses across disposals with a known result. */
  realizedGainUsd: number;
  /** Cost basis of everything still held (open lots) with a known cost. */
  unrealizedCostBasisUsd: number;
  /** Portion of unrealizedCostBasisUsd from principal (deposit/swap-in) lots. */
  principalCostBasisUsd: number;
  /** Portion of unrealizedCostBasisUsd from reward lots. */
  rewardCostBasisUsd: number;
}

export interface CostBasisReport {
  /** Remaining open lots after all disposals are applied, oldest first per asset. */
  lots: CostBasisLot[];
  /** One entry per disposal event, in chronological order. */
  disposals: RealizedDisposal[];
  warnings: CostBasisWarning[];
  totals: CostBasisTotals;
}
