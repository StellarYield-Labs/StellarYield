# Upgrade & Migration Framework

## Overview

The StellarYield upgrade framework provides a standardized mechanism for
governance-scheduled Wasm upgrades with timelock, storage migration, and
artifact provenance verification across all upgradeable contracts.

## Core Concepts

### Upgrade Lifecycle

```
Governance schedules upgrade (schedule_upgrade)
  │
  ├── Timelock begins (configurable delay, default 7 days)
  │
  ├── Anyone may cancel during timelock
  │
  └── After timelock: execute_upgrade
        │
        ├── Validates current Wasm hash matches expected
        ├── Validates migration plan digest
        ├── Sets migration state
        │
        └── Admin/keeper runs migrate() in chunks
              │
              ├── Each chunk is idempotent (monotonic cursor)
              ├── Fencing prevents state changes during migration
              │
              └── complete_migration() → storage version updated
```

### Storage Versioning

Each contract stores a `StorageVersion` key during initialization. This version
number is bumped after each successful migration. Contracts use this to detect
legacy storage layouts and apply the correct read paths.

### Migration Fencing

State-changing methods check a migration gate at the start of execution. If a
migration is in progress (`is_migrating() == true`), the method reverts with
`MigrationInProgress`. This prevents partial reads/writes of incompatible
storage schemas.

### Resumable Batched Migrations

For contracts with large persistent maps (e.g., per-user share balances), the
`migrate()` function accepts a `cursor` and `limit` parameter. Each chunk is
applied atomically. The cursor is monotonic — replaying the same cursor is a
no-op.

## Interface

All upgradeable contracts expose the following entry points:

| Method | Auth | Description |
|--------|------|-------------|
| `contract_version()` | None | Returns contract name string |
| `storage_version()` | None | Returns current storage schema version |
| `upgrade(...)` | Governance | Schedule a Wasm upgrade with timelock |
| `cancel_upgrade(...)` | Governance | Cancel a pending upgrade |
| `execute_upgrade(...)` | Governance | Execute after timelock expires |
| `finalize_upgrade(...)` | Governance | Complete upgrade, bump version |
| `migrate(from, to, cursor, limit)` | Admin | Apply migration chunk |
| `complete_migration()` | Admin | Mark migration done |
| `migration_status()` | None | Get current migration state |
| `is_migrating()` | None | Check if migration in progress |

## Artifact Manifest

Every release build produces an artifact manifest:

```json
{
  "contract": "yield_vault",
  "wasm_hash": "sha256 of compiled Wasm",
  "rust_toolchain": "nightly-2025-03-15",
  "source_commit": "git commit SHA",
  "contract_spec_hash": "sha256 of Soroban spec JSON",
  "migration_plan_hash": "sha256 of migration plan",
  "contract_version": "1.0.0"
}
```

## Emergency Rollback

Rollback is always performed as a **forward upgrade** to a previous Wasm
artifact:

1. Locate the previous artifact manifest (stored in CI or release)
2. Schedule a new upgrade with the previous Wasm hash
3. Apply the reverse migration plan (v2 → v1)
4. Execute and verify

This ensures all rollbacks go through the same timelock and verification
process as forward upgrades.

## Security Invariants

1. Only the configured governance authority can schedule or execute an upgrade
2. The target Wasm and migration plan are immutable after the timelock begins
3. A migration step is idempotent and monotonic
4. User balances, total supply, admin authority, pause state, and processed
   nonces survive an upgrade exactly
5. An incompatible client refuses to submit a transaction before wallet signing
6. Upgrade and migration events contain enough data to reconstruct the full
   lifecycle from indexed events

## Adoption Path for New Contracts

1. Add the `#[path = "../../interfaces/upgrade_impl.rs"]` module reference
2. Define `CONTRACT_NAME`, `STORAGE_VERSION`, `UpgradeDataKey`, and error
   variants (see existing implementations for reference)
3. Add `require_operational()` gating to state-changing methods
4. Set `StorageVersion` during `initialize()`
5. Register the contract's migration edges in the migration registry
6. Add tests for upgrade scheduling, execution, and migration fencing
7. Add the contract to the CI upgrade simulation workflow

## Contracts Covered

| Contract | Status | Storage Version |
|----------|--------|-----------------|
| yield_vault | Implemented | v1 |
| settlement | Implemented | v1 |
| optimistic_governance | Implemented | v1 |
| All others | Adoption path documented | — |
