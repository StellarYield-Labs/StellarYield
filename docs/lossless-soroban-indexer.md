# Lossless Soroban Event Indexer

This indexer is designed to replay Soroban contract events without silently
dropping events when a contract emits more than one RPC page, multiple contracts
are active, or two events carry identical topic/value XDR.

## Configuration

Prefer `INDEXER_CONTRACTS_JSON` for production:

```json
[
  {
    "network": "testnet",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "contractId": "CD...",
    "contractType": "vault",
    "deploymentLedger": 123456,
    "specVersion": 1,
    "decoderVersion": 1
  }
]
```

The old `CONTRACT_ID` / `VITE_CONTRACT_ID` fallback still works for local
development, but only tracks one vault stream.

## Replay guarantees

- Checkpoints are scoped by `network + contractId`.
- RPC pagination follows cursors until the terminal page.
- Repeated cursors are rejected as cursor regression.
- A checkpoint ahead of the current network tip is treated as rollback.
- Raw events are keyed by network, contract, ledger, tx hash, event index, and
  paging token so identical event payloads do not collapse into one row.
- Raw rows, decoded projector rows, dead letters, and checkpoints commit in one
  database transaction.
- Decoder failures become `IndexerDeadLetter` rows instead of advancing
  silently.

## Operator status

`GET /api/indexer/status` exposes:

- replay lag against the latest network ledger;
- stream count;
- total events processed from the checkpoint table;
- unresolved dead-letter count and oldest unresolved dead letter;
- recent in-memory replay errors.

## Rebuilding projections

Projection rebuilds should read `RawSorobanEvent` in `(network, contractId,
ledger, txHash, eventIndex)` order and write a new `ProjectionVersion`. Because
raw envelopes are immutable and decoded rows are keyed by projector version, a
new decoder can be rolled out without mutating historical raw data.
