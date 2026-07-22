import * as StellarSdk from "@stellar/stellar-sdk";
import { PrismaClient } from "@prisma/client";

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const GOVERNANCE_CONTRACT_ID = process.env.GOVERNANCE_CONTRACT_ID || "";
const POLL_INTERVAL_MS = 5000;
const INDEXER_STATE_ID = "governance-singleton";

const prisma = new PrismaClient();
const rpcServer = new StellarSdk.rpc.Server(RPC_URL);

/**
 * The optimistic_governance contract publishes one event per lifecycle
 * transition (propose/dispute/resolve/cancel/execute). This maps each raw
 * event topic to the terminal-ish GovernanceProposal.status it implies, so
 * proposal state can be rebuilt purely from indexed on-chain events and
 * transaction results - even from an empty application database (issue #81
 * acceptance criterion).
 */
const TOPIC_TO_STATUS: Record<string, string> = {
  propose: "PENDING",
  dispute: "CHALLENGED",
  resolve: "PENDING", // reinstated; cancellation is handled separately below
  cancel: "CANCELLED",
  execute: "CONFIRMED",
};

function decodeTopicSymbol(topicScVal: StellarSdk.xdr.ScVal): string | null {
  try {
    const native = StellarSdk.scValToNative(topicScVal);
    return typeof native === "string" ? native : null;
  } catch {
    return null;
  }
}

/**
 * Poll the optimistic_governance contract for lifecycle events and
 * reconcile GovernanceProposal/GovernanceEvent rows. Runs independently of
 * the generic vault event indexer since it targets a different contract and
 * a different reconciliation model (status derivation, not raw event log).
 */
export async function startGovernanceIndexer(): Promise<void> {
  if (!GOVERNANCE_CONTRACT_ID) {
    console.warn(
      "[GovernanceIndexer] GOVERNANCE_CONTRACT_ID is not set; skipping governance indexer startup.",
    );
    return;
  }

  console.log("[GovernanceIndexer] Starting optimistic_governance event indexer...");

  let state = await prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } });
  if (!state) {
    state = await prisma.indexerState.create({ data: { id: INDEXER_STATE_ID, lastLedger: 0 } });
  }
  let startLedger = state.lastLedger;

  const poll = async () => {
    try {
      const latestLedger = await rpcServer.getLatestLedger();
      const endLedger = latestLedger.sequence;

      if (startLedger >= endLedger) {
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      const eventsResponse = await rpcServer.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: [GOVERNANCE_CONTRACT_ID] }],
        limit: 100,
      });

      for (const event of eventsResponse.events) {
        await reconcileEvent(event);
      }

      startLedger = endLedger;
      await prisma.indexerState.update({
        where: { id: INDEXER_STATE_ID },
        data: { lastLedger: startLedger },
      });

      setTimeout(poll, POLL_INTERVAL_MS);
    } catch (error) {
      console.error("[GovernanceIndexer] Error:", error);
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  poll();
}

async function reconcileEvent(event: {
  topic: StellarSdk.xdr.ScVal[];
  value: StellarSdk.xdr.ScVal;
  ledger: number;
  txHash: string;
}): Promise<void> {
  const topicSymbol = event.topic.length > 0 ? decodeTopicSymbol(event.topic[0]) : null;
  if (!topicSymbol || !(topicSymbol in TOPIC_TO_STATUS)) {
    return;
  }

  let decodedValue: unknown;
  try {
    decodedValue = StellarSdk.scValToNative(event.value);
  } catch {
    decodedValue = null;
  }

  // The proposal id is always the first element of the published tuple
  // (see contracts/optimistic_governance/src/lib.rs event publishes).
  const onChainProposalIdRaw = Array.isArray(decodedValue) ? decodedValue[0] : decodedValue;
  const onChainProposalId =
    typeof onChainProposalIdRaw === "bigint"
      ? onChainProposalIdRaw
      : BigInt(String(onChainProposalIdRaw ?? "0"));

  const topicEncoded = event.topic.map((t) => t.toXDR("base64")).join(":");
  const dataEncoded = JSON.stringify(decodedValue, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  const existingEvent = await prisma.governanceEvent.findUnique({
    where: {
      txHash_topic_onChainProposalId: {
        txHash: event.txHash,
        topic: topicEncoded,
        onChainProposalId,
      },
    },
  });
  if (existingEvent) {
    return; // already reconciled - idempotent replay
  }

  const proposal = await prisma.governanceProposal.findFirst({
    where: { onChainProposalId },
  });

  let resolvedStatus = TOPIC_TO_STATUS[topicSymbol];
  if (topicSymbol === "resolve" && Array.isArray(decodedValue) && decodedValue[0] === false) {
    resolvedStatus = "CANCELLED"; // resolve_dispute(reinstate=false)
  }
  if (topicSymbol === "execute") {
    resolvedStatus = "CONFIRMED";
  }

  await prisma.governanceEvent.create({
    data: {
      proposalId: proposal?.id,
      onChainProposalId,
      eventType: topicSymbol.toUpperCase(),
      ledger: event.ledger,
      txHash: event.txHash,
      topic: topicEncoded,
      dataJson: dataEncoded,
    },
  });

  if (proposal) {
    await prisma.governanceProposal.update({
      where: { id: proposal.id },
      data: {
        status: resolvedStatus,
        executionTxHash: topicSymbol === "execute" ? event.txHash : proposal.executionTxHash,
        executionLedger: topicSymbol === "execute" ? event.ledger : proposal.executionLedger,
      },
    });
  }
}
