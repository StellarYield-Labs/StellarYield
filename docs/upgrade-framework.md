# Upgrade & Migration Framework

## Overview

All upgradeable StellarYield contracts follow a standard lifecycle for Wasm
upgrades and storage migrations. The framework provides governance gating,
timelock security, version detection, cursor-based batched migration, and
artifact provenance tracking.

## Lifecycle

```
Upload Wasm  ──>  Schedule Upgrade  ──>  Timelock  ──>  Execute Upgrade  ──>  Migrate Storage
  (separate tx)      (gov calls)         (7 days)         (gov calls)            (0-N batches)
```

### 1. Upload

The new Wasm blob is uploaded to the Soroban network via
`env.deployer().upload_contract_wasm()` or through the CLI:

```bash
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/yield_vault.wasm ...
```

The resulting Wasm hash (32 bytes) is used in the next step.

### 2. Schedule

The governance/admin address calls `schedule_upgrade` with:

| Parameter | Type | Description |
|-----------|------|-------------|
| `governance` | `Address` | Must match stored admin |
| `wasm_hash` | `BytesN<32>` | Hash of the uploaded Wasm |
| `expected_current_hash` | `BytesN<32>` | Stored code hash to verify at execution |
| `migration_id` | `u32` | Index into the migration registry |

A `PendingUpgrade` struct is stored and a 7-day timelock begins.

### 3. Cancel

Governance can cancel at any time before execution via `cancel_upgrade`.

### 4. Execute

After the timelock, governance calls `execute_upgrade`. The contract:

1. Verifies timelock has elapsed
2. Checks stored code hash matches `expected_current_hash` (if set)
3. Calls `env.deployer().update_current_contract_wasm(wasm_hash)`
4. Removes the pending upgrade record

The new Wasm now runs, reading the same persistent storage.

### 5. Migrate

If the storage schema changed (i.e., the upgrade is not read-compatible),
governance calls `migrate`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `governance` | `Address` | Must match stored admin |
| `from_version` | `u32` | Source storage version |
| `to_version` | `u32` | Target storage version |
| `cursor` | `Option<Bytes>` | `None` for first call, previous result for resumption |
| `limit` | `u32` | Max entries to process in this batch |

Returns `Option<Bytes>` — `None` when migration is complete.

## Migration Kinds

| Kind | Description |
|------|-------------|
| `OneShot` | Single call completes the migration |
| `Batched` | Resumable; caller invokes `migrate` repeatedly with cursor |
| `ReadCompatible` | No storage transformation; version bump only |

## Migration Registry

Edges are registered via `register_migration_edge`:

```rust
pub fn register_migration_edge(
    env: Env,
    governance: Address,
    from_version: u32,
    to_version: u32,
    kind: MigrationKind,
) -> Result<(), Error>;
```

## Standard Interface

Every upgradeable contract exposes:

| Function | Returns |
|----------|---------|
| `contract_version()` | `u32` (MMmmpp) |
| `storage_version()` | `u32` |
| `schedule_upgrade(...)` | `Result<(), Error>` |
| `cancel_upgrade(...)` | `Result<(), Error>` |
| `execute_upgrade(...)` | `Result<(), Error>` |
| `migrate(...)` | `Result<Option<Bytes>, Error>` |
| `migration_status()` | `MigrationStatus` |
| `register_migration_edge(...)` | `Result<(), Error>` |

## Security Invariants

- Only the configured governance/admin can schedule, cancel, or execute upgrades.
- Target Wasm and migration plan are immutable after the timelock begins.
- Migration steps are idempotent; fencing prevents double application.
- Execution fails if stored code hash differs from `expected_current_hash`.
- A 7-day timelock gives stakeholders time to review and dispute.

## SDK Integration

The `UpgradeClient` in the TypeScript SDK provides typed methods for all
upgrade operations and a `checkAndThrow` method that raises
`IncompatibleContractError` if the deployed contract does not meet the
minimum spec/storage version required by the caller.

```typescript
import { UpgradeClient, IncompatibleContractError } from "@stellaryield/sdk";

const client = new UpgradeClient({ contractId, networkPassphrase, rpcUrl });

try {
  await client.checkAndThrow(1_00_00, 1);
} catch (e) {
  if (e instanceof IncompatibleContractError) {
    console.error(`Contract v${e.contractVersion} is too old`);
  }
}
```

## Adopting in a New Contract

1. Add upgrade variants to your `DataKey` / `StorageKey` enum:
   ```
   ContractVersion, StorageVersion, CodeHash, PendingUpgrade,
   MigrationRegistry, MigrationCursor(u32, u32), MigrationBatch(u32, u32)
   ```
2. Add error codes for: `UpgradeAlreadyScheduled`, `NoPendingUpgrade`,
   `CodeHashMismatch`, `MigrationPathNotFound`, `MigrationInProgress`.
3. Create `upgrade.rs` using `contracts/yield_vault/src/upgrade.rs` as a
   template. Include the shared types via `#[path = "../../interfaces/upgrade.rs"]`.
4. Add `mod upgrade;` to your `lib.rs`.
5. Implement `migrate_oneshot` and `migrate_batch` for your storage schema.
6. Register migration edges on deploy or via governance.

## Release Procedure

1. Build the new Wasm: `cargo build --release --workspace` (from `contracts/`)
2. Compute the Wasm hash: `sha256sum target/wasm32-unknown-unknown/release/<contract>.wasm`
3. Upload the Wasm to the network
4. Governance calls `schedule_upgrade` with the hash
5. Wait 7 days (timelock)
6. Governance calls `execute_upgrade`
7. Governance calls `migrate` (may be multiple batches)
8. Verify invariants and events

## Emergency Rollback

Rollback is a **new forward upgrade** to the previous Wasm artifact.
The old Wasm file must have been retained and its hash known.

1. Upload the previous Wasm blob
2. Schedule upgrade to it (same process as above)
3. Execute after timelock
