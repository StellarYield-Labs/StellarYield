# Adopting the Upgrade Framework in Other Contracts

## Prerequisites

Read `docs/upgrade-framework.md` first.

## Step-by-step

### 1. Storage Key Additions

Add these variants to your contract's `DataKey` / `StorageKey` enum:

```rust
ContractVersion,
StorageVersion,
CodeHash,
PendingUpgrade,
MigrationRegistry,
MigrationCursor(u32, u32),
MigrationBatch(u32, u32),
```

### 2. Error Additions

Add these error codes (use unique values >= 10):

```rust
UpgradeAlreadyScheduled,
NoPendingUpgrade,
CodeHashMismatch,
MigrationPathNotFound,
MigrationInProgress,
```

### 3. Create `upgrade.rs`

Copy `contracts/yield_vault/src/upgrade.rs` as a template and:

- Replace `VaultError` with your contract's error type
- Replace `DataKey` with your contract's storage key enum
- Replace `YieldVault` with your contract struct name
- Replace `require_admin` / `require_init` with your auth helpers

### 4. Wire into `lib.rs`

```rust
mod upgrade;
```

### 5. Implement Migration Logic

Override `migrate_oneshot` and `migrate_batch` in your `upgrade.rs`:

```rust
fn migrate_oneshot(
    env: &Env,
    from_version: u32,
    to_version: u32,
) -> Result<(), MyError> {
    // Read old-format keys, transform, write new-format keys
    Ok(())
}

fn migrate_batch(
    env: &Env,
    from_version: u32,
    to_version: u32,
    cursor: Bytes,
    limit: u32,
) -> Result<Option<Bytes>, MyError> {
    // Iterate persistent keys starting from cursor
    // Process up to `limit` entries
    // Return new cursor or None when done
    Ok(None)
}
```

### 6. Governance Proposals

The `optimistic_governance` contract can already propose calls to any contract.
To schedule an upgrade via governance:

```rust
// Governance proposal payload:
//   target: yield_vault contract ID
//   function: Symbol::new(&env, "schedule_upgrade")
//   args: [governance, wasm_hash, expected_hash, migration_id]
```

### 7. CI Integration

Add your contract to the `paths` trigger in `.github/workflows/upgrade-ci.yml`.

## Verification Checklist

- [ ] New storage keys are documented in `docs/contracts/storage-layout-upgrade.md`
- [ ] `register_migration_edge` is called for each allowed version transition
- [ ] Migration is tested with a fixture-to-target simulation
- [ ] SDK `checkAndThrow` detects incompatible versions before tx submission
- [ ] Events are emitted for every upgrade lifecycle step
