/**
 * Portfolio cost-basis reconciliation across rewards and swaps.
 *
 * Two stages, both pure and side-effect-free so they can run against
 * historical data in tests without a live wallet/indexer connection:
 *
 *   1. `reconcileEventSources` merges the wallet's view of activity with
 *      the indexer's view into one deduplicated timeline.
 *   2. `buildCostBasisReport` walks that timeline per-asset in
 *      chronological (timestamp, then sequence) order, using FIFO lot
 *      matching, to separate principal movement from earned (reward)
 *      value and produce realized/unrealized figures with source
 *      references.
 */

import type {
  CostBasisLot,
  CostBasisReport,
  CostBasisWarning,
  LedgerEvent,
  LotOrigin,
  RealizedDisposal,
} from "./types";

function eventRef(event: LedgerEvent): string {
  return event.ref ?? event.id;
}

/**
 * Deterministic chronological order: timestamp, then explicit sequence
 * (defaulting to 0), then id as a final stable tiebreaker. Two events from
 * the same block/ledger close must set `sequence` to get chain-accurate
 * ordering; without it, ties still resolve the same way on every run.
 */
function compareEvents(a: LedgerEvent, b: LedgerEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  const seqA = a.sequence ?? 0;
  const seqB = b.sequence ?? 0;
  if (seqA !== seqB) return seqA - seqB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge the wallet's and the indexer's view of activity into one timeline.
 *
 * An event present in both sources (matched by `ref`) is deduplicated,
 * keeping the indexer's copy as authoritative (on-chain data wins over a
 * wallet's possibly-optimistic local record). An event the wallet reports
 * that the indexer hasn't picked up yet is kept — dropping it would
 * silently understate the portfolio — but flagged as unconfirmed so a
 * reviewer knows it may still change or disappear.
 */
export function reconcileEventSources(
  walletEvents: LedgerEvent[],
  indexedEvents: LedgerEvent[],
): { events: LedgerEvent[]; warnings: CostBasisWarning[] } {
  const warnings: CostBasisWarning[] = [];
  const indexedByRef = new Map<string, LedgerEvent>();
  for (const event of indexedEvents) {
    indexedByRef.set(eventRef(event), event);
  }

  const merged: LedgerEvent[] = [...indexedEvents];

  for (const walletEvent of walletEvents) {
    const ref = eventRef(walletEvent);
    if (indexedByRef.has(ref)) {
      continue; // indexer's copy already included; wallet's is a duplicate
    }
    merged.push(walletEvent);
    warnings.push({
      code: "UNCONFIRMED_WALLET_EVENT",
      message: `Event ${walletEvent.id} (${walletEvent.type} ${walletEvent.quantity} ${walletEvent.asset}) has not been observed by the indexer yet`,
      context: { eventId: walletEvent.id, ref, asset: walletEvent.asset },
    });
  }

  merged.sort(compareEvents);
  return { events: merged, warnings };
}

function originFor(type: LedgerEvent["type"]): LotOrigin {
  return type === "reward" ? "reward" : "principal";
}

/**
 * Build per-asset cost-basis lots and realized-disposal history from a
 * reconciled event timeline, using FIFO lot matching (oldest lot consumed
 * first). `fee` events consume lots the same way a disposal does (they
 * reduce the held quantity) but are not reported as realized disposals —
 * a fee isn't a sale, it's a cost, so it has no "proceeds" to compare
 * against cost basis.
 */
export function buildCostBasisReport(events: LedgerEvent[]): CostBasisReport {
  const warnings: CostBasisWarning[] = [];
  const disposals: RealizedDisposal[] = [];
  const openLotsByAsset = new Map<string, CostBasisLot[]>();

  const sorted = [...events].sort(compareEvents);

  for (const event of sorted) {
    const quantity = Number(event.quantity);

    if (event.priceUsd === null && event.type !== "fee") {
      warnings.push({
        code: "MISSING_PRICE_DATA",
        message: `${event.type} event ${event.id} for ${event.asset} has no price data — its cost/proceeds are excluded from totals rather than treated as zero`,
        context: { eventId: event.id, asset: event.asset, type: event.type },
      });
    }

    if (event.type === "acquisition" || event.type === "reward") {
      const lots = openLotsByAsset.get(event.asset) ?? [];
      lots.push({
        asset: event.asset,
        origin: originFor(event.type),
        quantityRemaining: event.quantity,
        unitCostUsd: event.priceUsd,
        acquiredAt: event.timestamp,
        sourceEventId: event.id,
      });
      openLotsByAsset.set(event.asset, lots);
      continue;
    }

    // disposal | fee — consume open lots FIFO.
    const lots = openLotsByAsset.get(event.asset) ?? [];
    let remainingToConsume = quantity;
    let costBasisUsd: number | null = 0;
    let costBasisKnown = true;
    let consumedOrigin: LotOrigin | null = null;

    while (remainingToConsume > 0 && lots.length > 0) {
      const lot = lots[0];
      const lotQty = Number(lot.quantityRemaining);
      const consumed = Math.min(lotQty, remainingToConsume);

      if (lot.unitCostUsd === null) {
        costBasisKnown = false;
      } else if (costBasisKnown) {
        costBasisUsd = (costBasisUsd ?? 0) + consumed * lot.unitCostUsd;
      }

      // A disposal spanning lots of mixed origin still reports one
      // dominant origin — the first (oldest, FIFO) lot it draws from —
      // since that's the lot whose lifecycle the disposal is closing out.
      if (consumedOrigin === null) consumedOrigin = lot.origin;

      const newLotQty = lotQty - consumed;
      if (newLotQty <= 0) {
        lots.shift();
      } else {
        lot.quantityRemaining = newLotQty.toString();
      }

      remainingToConsume -= consumed;
    }

    if (remainingToConsume > 0) {
      warnings.push({
        code: "INSUFFICIENT_COST_BASIS",
        message: `${event.type} event ${event.id} for ${event.asset} disposes ${event.quantity} but only ${(quantity - remainingToConsume).toString()} was available in open lots — the untracked ${remainingToConsume.toString()} is excluded from cost-basis totals`,
        context: {
          eventId: event.id,
          asset: event.asset,
          requested: event.quantity,
          shortfall: remainingToConsume,
        },
      });
      costBasisKnown = false;
    }

    openLotsByAsset.set(event.asset, lots);

    if (event.type === "fee") continue; // a cost, not a realized disposal

    const proceedsUsd =
      event.priceUsd === null ? null : quantity * event.priceUsd;
    const finalCostBasis = costBasisKnown ? costBasisUsd : null;
    const realizedGainUsd =
      proceedsUsd === null || finalCostBasis === null
        ? null
        : proceedsUsd - finalCostBasis;

    disposals.push({
      asset: event.asset,
      disposalEventId: event.id,
      quantity: event.quantity,
      proceedsUsd,
      costBasisUsd: finalCostBasis,
      realizedGainUsd,
      lotOrigin: consumedOrigin ?? "principal",
      timestamp: event.timestamp,
    });
  }

  const lots = Array.from(openLotsByAsset.values()).flat();

  let realizedGainUsd = 0;
  for (const d of disposals) {
    if (d.realizedGainUsd !== null) realizedGainUsd += d.realizedGainUsd;
  }

  let unrealizedCostBasisUsd = 0;
  let principalCostBasisUsd = 0;
  let rewardCostBasisUsd = 0;
  for (const lot of lots) {
    if (lot.unitCostUsd === null) continue;
    const value = Number(lot.quantityRemaining) * lot.unitCostUsd;
    unrealizedCostBasisUsd += value;
    if (lot.origin === "principal") principalCostBasisUsd += value;
    else rewardCostBasisUsd += value;
  }

  return {
    lots,
    disposals,
    warnings,
    totals: {
      realizedGainUsd,
      unrealizedCostBasisUsd,
      principalCostBasisUsd,
      rewardCostBasisUsd,
    },
  };
}

/**
 * Convenience entry point: reconcile the two sources, then build the
 * cost-basis report from the merged timeline.
 */
export function reconcilePortfolioCostBasis(
  walletEvents: LedgerEvent[],
  indexedEvents: LedgerEvent[],
): CostBasisReport {
  const { events, warnings: reconciliationWarnings } = reconcileEventSources(
    walletEvents,
    indexedEvents,
  );
  const report = buildCostBasisReport(events);
  return { ...report, warnings: [...reconciliationWarnings, ...report.warnings] };
}
