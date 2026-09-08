import {
  decodeIndexerEvent,
  fetchAllEventsForRange,
  normalizeSorobanEvent,
  type RawRpcEvent,
} from "../indexer/indexer";
import { loadContractStreamsFromEnv } from "../indexer/contractRegistry";

const stream = {
  network: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://rpc.example",
  contractId: "CDVAULT",
  contractType: "vault" as const,
  deploymentLedger: 100,
  specVersion: 1,
  decoderVersion: 1,
};

function xdr(value: string) {
  return { toXDR: () => Buffer.from(value).toString("base64") };
}

function event(overrides: Partial<RawRpcEvent> = {}): RawRpcEvent {
  return {
    ledger: 123,
    txHash: "tx-1",
    contractId: "CDVAULT",
    eventIndex: 0,
    pagingToken: "cursor:1",
    topic: [xdr("deposit")],
    value: xdr("100"),
    ...overrides,
  };
}

describe("loadContractStreamsFromEnv", () => {
  it("loads multiple contract streams from INDEXER_CONTRACTS_JSON", () => {
    const streams = loadContractStreamsFromEnv({
      INDEXER_CONTRACTS_JSON: JSON.stringify([
        { contractId: "CDA", contractType: "vault", deploymentLedger: 10 },
        { contractId: "CDB", contractType: "governance", deploymentLedger: 20 },
      ]),
    } as NodeJS.ProcessEnv);

    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatchObject({ contractId: "CDA", deploymentLedger: 10 });
    expect(streams[1]).toMatchObject({ contractId: "CDB", contractType: "governance" });
  });

  it("keeps the legacy CONTRACT_ID fallback", () => {
    const streams = loadContractStreamsFromEnv({
      CONTRACT_ID: "CDLEGACY",
      INDEXER_DEPLOYMENT_LEDGER: "42",
    } as NodeJS.ProcessEnv);

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ contractId: "CDLEGACY", deploymentLedger: 42 });
  });
});

describe("lossless Soroban event identity", () => {
  it("does not collapse identical payloads emitted at different event indexes", () => {
    const first = normalizeSorobanEvent(stream, event({ eventIndex: 0 }), 0);
    const second = normalizeSorobanEvent(stream, event({ eventIndex: 1 }), 1);

    expect(first.topic).toBe(second.topic);
    expect(first.data).toBe(second.data);
    expect(first.identity).not.toBe(second.identity);
  });

  it("returns deterministic decoded projector payloads from raw envelopes", () => {
    const raw = normalizeSorobanEvent(stream, event(), 0);
    const decoded = decodeIndexerEvent(raw, 2);

    expect(decoded.projectorVersion).toBe(2);
    expect(decoded.payload).toMatchObject({
      network: "testnet",
      contractId: "CDVAULT",
      ledger: 123,
      txHash: "tx-1",
    });
  });
});

describe("fetchAllEventsForRange", () => {
  it("follows Soroban RPC cursors until the terminal page", async () => {
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event({ pagingToken: "a" })], cursor: "next-a" })
      .mockResolvedValueOnce({ events: [event({ pagingToken: "b", eventIndex: 1 })] });

    const result = await fetchAllEventsForRange({ getEvents }, stream, 100);

    expect(result.events).toHaveLength(2);
    expect(result.pagesProcessed).toBe(2);
    expect(getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "next-a" }),
    );
  });

  it("rejects cursor regression to avoid infinite replay loops", async () => {
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [], cursor: "same" })
      .mockResolvedValueOnce({ events: [], cursor: "same" });

    await expect(fetchAllEventsForRange({ getEvents }, stream, 100)).rejects.toThrow(
      /cursor regression/i,
    );
  });
});
