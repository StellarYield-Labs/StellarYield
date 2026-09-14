# Bridge Finality and Asset Accounting

Issue #76 replaces bridge relayer placeholders with verifiable state
transitions that are deterministic enough to audit and replay.

## Canonical message hash

Messages are hashed with SHA3-256 and the domain separator:

```text
StellarYield:bridge-relayer:v1
```

The digest commits to source chain, target chain, nonce, sender, recipient,
asset, amount, metadata bytes, and message type. Queue IDs use a separate
domain separator so they cannot collide with message hashes.

## Finality checks

- Merkle messages recompute the proof path from the canonical message hash and
  compare the resulting root to the submitted checkpoint root.
- Multi-signature messages must bind to the same canonical message hash.
- Validators must be active, unique, and accompanied by 65-byte signatures.
- Duplicate validator entries are rejected before quorum weight is counted.

## Replay protection

The relayer now tracks nonces per source chain, instead of sharing one global
nonce across every domain. That allows chain A nonce `1` and chain B nonce `1`
to both be valid while still rejecting replay inside each source domain.

## Queue persistence

Transfers above `queue_threshold` are persisted in the contract queue map with
their original message, enqueue timestamp, executable timestamp, and processed
flag. Execution retrieves the stored message, enforces the timelock, processes
it once, and writes the processed state back.

## Asset accounting

Every mint, burn, and transfer updates an `AssetAccounting` record keyed by the
asset address. Burns cannot exceed minted supply, and operators can query
`get_asset_accounting(asset)` to compare wrapped supply against bridge-side
source-chain reserves.

## Follow-up audit items

This patch adds deterministic verification and accounting primitives. A
production audit should still wire validator signature recovery to the exact
Stellar/Soroban signature scheme used by the validator set and bind submitted
checkpoint roots to a source-chain light-client or governance-controlled
checkpoint registry.
