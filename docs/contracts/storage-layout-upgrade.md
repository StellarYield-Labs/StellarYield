# Upgrade-Related Storage Layout

Every upgradeable contract reserves the following persistent keys:

## Standard Keys

| Key | Type | Description |
|-----|------|-------------|
| `ContractVersion` | `u32` | `MMmmpp` encoded (e.g., `1_00_00` = v1.0.0) |
| `StorageVersion` | `u32` | Monotonically increasing storage schema version |
| `CodeHash` | `BytesN<32>` | Sha256 of the deployed Wasm blob |
| `PendingUpgrade` | `PendingUpgrade` | Active scheduled upgrade (max 1) |
| `MigrationRegistry` | `Map<u32, Map<u32, MigrationEdge>>` | Allowed version transitions |
| `MigrationCursor(v_from, v_to)` | `Bytes` | Fencing marker for batched migration |
| `MigrationBatch(v_from, v_to)` | `MigrationStatus` | Progress of ongoing batched migration |

## PendingUpgrade

```rust
struct PendingUpgrade {
    wasm_hash: BytesN<32>,
    scheduled_at: u64,
    timelock_seconds: u64,
    migration_id: u32,
    expected_current_hash: BytesN<32>,
}
```

## Migration Status

```rust
struct MigrationStatus {
    is_active: bool,
    from_version: u32,
    to_version: u32,
    progress: u32,
    total_batches: u32,
    cursor: Option<Bytes>,
}
```

## Guarantees

- At most one pending upgrade exists at a time.
- `StorageVersion` is updated only after a migration completes.
- `CodeHash` records the last successfully upgraded Wasm hash.
- Migration fencing keys prevent replay of completed batches.
