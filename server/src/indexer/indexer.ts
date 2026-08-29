import crypto from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  type ContractStreamConfig,
  loadContractStreamsFromEnv,
  streamKey,
} from "./contractRegistry";
import { recordReplayError } from "./indexerStatus";

const POLL_INTERVAL = 5000; // 5 seconds
const PAGE_LIMIT = Number(process.env.INDEXER_PAGE_LIMIT || 100);

export type IndexerPrismaClient = {
  $transaction<T>(fn: (tx: IndexerPrismaClient) => Promise<T>): Promise<T>;
  indexerContractStream: {
    upsert(args: {
      where: { network_contractId: { network: string; contractId: string } };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
  indexerCheckpoint: {
    findUnique(args: {
      where: { network_contractId: { network: string; contractId: string } };
    }): Promise<{
      network: string;
      contractId: string;
      lastLedger: number;
      cursor: string | null;
      networkPassphrase: string;
    } | null>;
    upsert(args: {
      where: { network_contractId: { network: string; contractId: string } };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
  rawSorobanEvent: {
    upsert(args: {
      where: { identity: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
  decodedSorobanEvent: {
    upsert(args: {
      where: { rawEventId_projectorVersion: { rawEventId: string; projectorVersion: number } };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
  indexerDeadLetter: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  event: {
    upsert(args: {
      where: { txHash_topic_data: { txHash: string; topic: string; data: string } };
      update: Record<string, never>;
      create: {
        ledger: number;
        txHash: string;
        contractId: string;
        topic: string;
        data: string;
      };
    }): Promise<unknown>;
  };
};

export interface RawRpcEvent {
  ledger: number;
  txHash?: string;
  contractId?: unknown;
  topic?: Array<{ toXDR: (format: "base64") => string }>;
  value?: { toXDR: (format: "base64") => string };
  pagingToken?: string;
  eventIndex?: number;
  type?: string;
}

export interface IndexerPage {
  events: RawRpcEvent[];
  cursor?: string;
}

export interface NormalizedSorobanEvent {
  identity: string;
  network: string;
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  pagingToken: string | null;
  topic: string;
  data: string;
  envelope: Record<string, unknown>;
}

export interface DecodedIndexerEvent {
  eventType: string;
  payload: Record<string, unknown>;
  projectorVersion: number;
}

async function loadPrismaClient(): Promise<IndexerPrismaClient | null> {
  try {
    const prismaModule = (await import('@prisma/client')) as unknown as {
      PrismaClient?: new () => IndexerPrismaClient;
    };

    if (!prismaModule.PrismaClient) {
      return null;
    }

    return new prismaModule.PrismaClient();
  } catch (error) {
    console.warn('[Indexer] Prisma client is unavailable:', error);
    return null;
  }
}

function toXdr(value: unknown): string {
  if (value && typeof (value as { toXDR?: unknown }).toXDR === "function") {
    return (value as { toXDR: (format: "base64") => string }).toXDR("base64");
  }
  return Buffer.from(JSON.stringify(value ?? null)).toString("base64");
}

function eventTopics(event: RawRpcEvent): string {
  return (event.topic || []).map((topic) => toXdr(topic)).join(":");
}

export function normalizeSorobanEvent(
  stream: ContractStreamConfig,
  event: RawRpcEvent,
  ordinal: number,
): NormalizedSorobanEvent {
  const topic = eventTopics(event);
  const data = toXdr(event.value);
  const txHash = event.txHash || `missing-tx-${event.ledger}-${ordinal}`;
  const pagingToken = event.pagingToken || null;
  const eventIndex = Number.isInteger(event.eventIndex) ? Number(event.eventIndex) : ordinal;
  const contractId = String(event.contractId ?? stream.contractId);
  const identityMaterial = [
    stream.network,
    contractId,
    event.ledger,
    txHash,
    eventIndex,
    pagingToken || "no-cursor-token",
  ].join(":");

  return {
    identity: crypto.createHash("sha256").update(identityMaterial).digest("hex"),
    network: stream.network,
    contractId,
    ledger: event.ledger,
    txHash,
    eventIndex,
    pagingToken,
    topic,
    data,
    envelope: {
      ledger: event.ledger,
      txHash,
      eventIndex,
      pagingToken,
      type: event.type || "contract",
      topic,
      data,
      contractId,
      decoderVersion: stream.decoderVersion,
      specVersion: stream.specVersion,
    },
  };
}

export function decodeIndexerEvent(
  raw: NormalizedSorobanEvent,
  projectorVersion = 1,
): DecodedIndexerEvent {
  const firstTopic = raw.topic.split(":").filter(Boolean)[0] || "unknown";
  return {
    eventType: firstTopic,
    projectorVersion,
    payload: {
      network: raw.network,
      contractId: raw.contractId,
      ledger: raw.ledger,
      txHash: raw.txHash,
      eventIndex: raw.eventIndex,
      topicXdr: raw.topic,
      valueXdr: raw.data,
    },
  };
}

export async function fetchAllEventsForRange(
  rpcServer: {
    getEvents(args: Record<string, unknown>): Promise<IndexerPage>;
  },
  stream: ContractStreamConfig,
  startLedger: number,
): Promise<{ events: RawRpcEvent[]; terminalCursor: string | null; pagesProcessed: number }> {
  const events: RawRpcEvent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let terminalCursor: string | null = null;
  let pagesProcessed = 0;

  do {
    const page = await rpcServer.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [stream.contractId] }],
      limit: PAGE_LIMIT,
      cursor,
    });

    pagesProcessed += 1;
    events.push(...(page.events || []));
    terminalCursor = page.cursor || terminalCursor;

    if (!page.cursor) {
      break;
    }
    if (seenCursors.has(page.cursor)) {
      throw new Error(`Cursor regression detected for ${streamKey(stream)} at ${page.cursor}`);
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  } while (cursor);

  return { events, terminalCursor, pagesProcessed };
}

async function ensureStreamRegistered(
  prisma: IndexerPrismaClient,
  stream: ContractStreamConfig,
): Promise<void> {
  await prisma.indexerContractStream.upsert({
    where: { network_contractId: { network: stream.network, contractId: stream.contractId } },
    update: {
      rpcUrl: stream.rpcUrl,
      networkPassphrase: stream.networkPassphrase,
      contractType: stream.contractType,
      deploymentLedger: stream.deploymentLedger,
      specVersion: stream.specVersion,
      decoderVersion: stream.decoderVersion,
      enabled: true,
    },
    create: {
      network: stream.network,
      contractId: stream.contractId,
      rpcUrl: stream.rpcUrl,
      networkPassphrase: stream.networkPassphrase,
      contractType: stream.contractType,
      deploymentLedger: stream.deploymentLedger,
      specVersion: stream.specVersion,
      decoderVersion: stream.decoderVersion,
      enabled: true,
    },
  });
}

async function loadCheckpoint(
  prisma: IndexerPrismaClient,
  stream: ContractStreamConfig,
): Promise<{ lastLedger: number; cursor: string | null }> {
  const checkpoint = await prisma.indexerCheckpoint.findUnique({
    where: { network_contractId: { network: stream.network, contractId: stream.contractId } },
  });

  if (checkpoint && checkpoint.networkPassphrase !== stream.networkPassphrase) {
    throw new Error(`Network passphrase mismatch for ${streamKey(stream)}`);
  }

  return {
    lastLedger: checkpoint?.lastLedger ?? stream.deploymentLedger,
    cursor: checkpoint?.cursor ?? null,
  };
}

export async function persistBatchTransactionally(
  prisma: IndexerPrismaClient,
  stream: ContractStreamConfig,
  normalizedEvents: NormalizedSorobanEvent[],
  endLedger: number,
  cursor: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const raw of normalizedEvents) {
      await tx.rawSorobanEvent.upsert({
        where: { identity: raw.identity },
        update: {},
        create: {
          id: raw.identity,
          identity: raw.identity,
          network: raw.network,
          contractId: raw.contractId,
          ledger: raw.ledger,
          txHash: raw.txHash,
          eventIndex: raw.eventIndex,
          pagingToken: raw.pagingToken,
          topic: raw.topic,
          data: raw.data,
          envelopeJson: raw.envelope,
        },
      });

      try {
        const decoded = decodeIndexerEvent(raw);
        await tx.decodedSorobanEvent.upsert({
          where: {
            rawEventId_projectorVersion: {
              rawEventId: raw.identity,
              projectorVersion: decoded.projectorVersion,
            },
          },
          update: { eventType: decoded.eventType, payloadJson: decoded.payload },
          create: {
            rawEventId: raw.identity,
            network: raw.network,
            contractId: raw.contractId,
            ledger: raw.ledger,
            eventType: decoded.eventType,
            projectorVersion: decoded.projectorVersion,
            payloadJson: decoded.payload,
          },
        });
      } catch (error) {
        await tx.indexerDeadLetter.create({
          data: {
            rawEventId: raw.identity,
            network: raw.network,
            contractId: raw.contractId,
            ledger: raw.ledger,
            reason: "DECODE_FAILED",
            errorMessage: error instanceof Error ? error.message : String(error),
            payloadJson: raw.envelope,
          },
        });
      }

      // Compatibility write for older API paths that still read Event.
      await tx.event.upsert({
        where: {
          txHash_topic_data: {
            txHash: raw.txHash,
            topic: raw.topic,
            data: raw.data,
          },
        },
        update: {},
        create: {
          ledger: raw.ledger,
          txHash: raw.txHash,
          contractId: raw.contractId,
          topic: raw.topic,
          data: raw.data,
        },
      });
    }

    await tx.indexerCheckpoint.upsert({
      where: { network_contractId: { network: stream.network, contractId: stream.contractId } },
      update: {
        lastLedger: endLedger,
        cursor,
        lastSuccessfulBatchAt: new Date(),
        eventsProcessed: { increment: normalizedEvents.length },
      },
      create: {
        network: stream.network,
        contractId: stream.contractId,
        networkPassphrase: stream.networkPassphrase,
        lastLedger: endLedger,
        cursor,
        lastSuccessfulBatchAt: new Date(),
        eventsProcessed: normalizedEvents.length,
      },
    });
  });
}

/**
 * Cursor-paginated, multi-contract Soroban indexer.
 *
 * The durable checkpoint is scoped by network + contract id and is committed in
 * the same transaction as raw/decoded/dead-letter rows so replay can resume
 * without skipping or duplicating events.
 */
export async function startIndexer() {
  console.log("[Indexer] Starting StellarYield event indexer...");
  const prisma = await loadPrismaClient();

  if (!prisma) {
    console.warn("[Indexer] Prisma client has not been generated; skipping indexer startup.");
    return;
  }

  const streams = loadContractStreamsFromEnv();
  if (streams.length === 0) {
    console.warn("[Indexer] No contracts configured; set INDEXER_CONTRACTS_JSON or CONTRACT_ID.");
    return;
  }

  for (const stream of streams) {
    await ensureStreamRegistered(prisma, stream);
  }

  const poll = async () => {
    for (const stream of streams) {
      const rpcServer = new StellarSdk.rpc.Server(stream.rpcUrl);
      const checkpoint = await loadCheckpoint(prisma, stream);
      let startLedger = checkpoint.lastLedger;

      try {
        const latestLedger = await rpcServer.getLatestLedger();
        const endLedger = latestLedger.sequence;

        if (startLedger > endLedger) {
          throw new Error(`Ledger rollback detected for ${streamKey(stream)}: checkpoint ${startLedger}, tip ${endLedger}`);
        }

        if (startLedger >= endLedger) {
          continue;
        }

        console.log(`[Indexer] ${streamKey(stream)} catching up from ${startLedger} to ${endLedger}...`);

        const { events, terminalCursor, pagesProcessed } = await fetchAllEventsForRange(
          rpcServer,
          stream,
          startLedger,
        );
        const normalizedEvents = events.map((event, ordinal) =>
          normalizeSorobanEvent(stream, event, ordinal),
        );

        await persistBatchTransactionally(
          prisma,
          stream,
          normalizedEvents,
          endLedger,
          terminalCursor,
        );

        console.log(
          `[Indexer] ${streamKey(stream)} committed ${normalizedEvents.length} event(s) across ${pagesProcessed} page(s) to ledger ${endLedger}`,
        );
      } catch (error) {
        console.error("[Indexer] Error:", error);
        recordReplayError(error instanceof Error ? error.message : String(error), startLedger);
      }
    }

    setTimeout(poll, POLL_INTERVAL);
  };

  poll();
}
