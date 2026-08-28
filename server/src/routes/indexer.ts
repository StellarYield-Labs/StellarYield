/**
 * indexer.ts (routes)
 *
 * Operator routes for the contract event indexer.
 *
 * GET /api/indexer/status
 *   Returns the latest indexed ledger (replay checkpoint), the latest network
 *   ledger, lag from Horizon, recent replay errors, and a degraded/unavailable
 *   status when the indexer falls behind. Read-only — never mutates indexer state.
 *
 * GET /api/indexer/backfill/status
 *   Per-stream backfill progress summaries (processed/skipped/failed/pending
 *   batches) for whatever the current process has planned or run.
 *
 * POST /api/indexer/backfill/:network/:contractId
 *   Recovers missing event ranges for one configured stream, from an optional
 *   `fromLedger` down to the stream's durable checkpoint, in bounded batches.
 */
import { Router, Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getIndexerStatusSnapshot } from "../indexer/indexerStatus";
import { fetchAllEventsForRange, type IndexerPrismaClient } from "../indexer/indexer";
import { loadContractStreamsFromEnv, streamKey } from "../indexer/contractRegistry";
import {
  backfillProgress,
  deriveIndexedRangeFromCheckpoint,
  runContractBackfill,
  type LedgerRange,
} from "../indexer/backfillPlanner";
import { prisma } from "../utils/prisma";

const router = Router();

router.get("/status", async (_req: Request, res: Response) => {
  try {
    const snapshot = await getIndexerStatusSnapshot();
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=10");
    res.json({ success: true, data: snapshot });
  } catch (error) {
    console.error("Failed to build indexer status snapshot:", error);
    res.status(500).json({
      error: "Failed to build indexer status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/backfill/status", async (_req: Request, res: Response) => {
  try {
    const streams = loadContractStreamsFromEnv();
    const summaries = streams.map((stream) => backfillProgress.getSummary(streamKey(stream)));
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
    res.json({ success: true, data: summaries });
  } catch (error) {
    console.error("Failed to build backfill status:", error);
    res.status(500).json({
      error: "Failed to build backfill status",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/backfill/:network/:contractId", async (req: Request, res: Response) => {
  try {
    const { network, contractId } = req.params;
    const stream = loadContractStreamsFromEnv().find(
      (s) => s.network === network && s.contractId === contractId,
    );

    if (!stream) {
      res.status(404).json({
        error: "Unknown contract stream",
        message: `${network}:${contractId} is not configured in INDEXER_CONTRACTS_JSON`,
      });
      return;
    }

    const indexerPrisma = prisma as unknown as IndexerPrismaClient;
    const indexedRange = await deriveIndexedRangeFromCheckpoint(indexerPrisma, stream);

    if (!indexedRange) {
      res.status(409).json({
        error: "No checkpoint yet",
        message: "The live indexer has not committed a checkpoint for this stream yet.",
      });
      return;
    }

    const requestedFromLedger = Number(req.body?.fromLedger ?? req.query.fromLedger);
    const fromLedger = Number.isFinite(requestedFromLedger)
      ? requestedFromLedger
      : stream.deploymentLedger;
    const fullRange: LedgerRange = {
      start: Math.min(fromLedger, indexedRange.start),
      end: indexedRange.end,
    };

    const rpcServer = new StellarSdk.rpc.Server(stream.rpcUrl);
    const result = await runContractBackfill(
      indexerPrisma,
      stream,
      fullRange,
      [indexedRange],
      (startLedger) => fetchAllEventsForRange(rpcServer, stream, startLedger),
    );

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Backfill run failed:", error);
    res.status(500).json({
      error: "Backfill run failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
