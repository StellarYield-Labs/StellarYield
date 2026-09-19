# Protocol Adapter Manifests

Issue #80 replaces production mock compatibility checks with versioned protocol adapters. Each adapter owns an approved manifest and must fail closed when deployed contracts differ from that manifest.

## Manifest approval

Every manifest version must include:

- protocol name, version, and network;
- contract IDs by role;
- expected Wasm/spec hashes;
- supported method signatures;
- token metadata with explicit decimals;
- expected event schemas;
- required capabilities;
- safe unwind methods.

If RPC observation returns a different contract ID, Wasm hash, or spec hash, new deposits and allocation routes must remain blocked until maintainers review and approve a new manifest version.

## Adapter responsibilities

Adapters must:

1. attest deployed contracts against the manifest;
2. probe required read-only capabilities with deterministic arguments;
3. return health, APY, TVL, reward, liquidity, and provenance metadata through typed methods as those integrations mature;
4. quote with integer atomic units only;
5. preserve quote assumptions: state ledger, route, minimum output, expiry ledger, and manifest version;
6. classify errors as retryable transport failures or terminal compatibility failures;
7. report safe unwind separately from deposit/swap capability.

## Adding another protocol

Add a new `ProtocolAdapter` implementation and register it with:

```ts
const engine = new ProtocolCompatibilityEngine();
engine.registerAdapter(new NewProtocolAdapter());
```

The orchestrator discovers protocols from the adapter registry, so no protocol-name switch should be necessary.

## Test fixtures

Recorded RPC fixtures must be deterministic and scrubbed of secrets. Tests should include:

- matching manifest → compatible;
- changed spec hash → incompatible;
- unsupported asset → quote rejected before simulation;
- stale/unavailable probe → never healthy;
- third adapter registration without orchestrator changes.
