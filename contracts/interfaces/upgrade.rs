use soroban_sdk::{contracttype, Bytes, BytesN};

/// Standard pending upgrade descriptor stored by upgradeable contracts.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub scheduled_at: u64,
    pub timelock_seconds: u64,
    pub migration_id: u32,
    pub expected_current_hash: BytesN<32>,
}

/// Snapshot of an ongoing or completed migration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationStatus {
    pub is_active: bool,
    pub from_version: u32,
    pub to_version: u32,
    pub progress: u32,
    pub total_batches: u32,
    pub cursor: Option<Bytes>,
}

/// How a migration between two storage versions must be executed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationKind {
    /// Single transaction, no cursor needed.
    OneShot,
    /// Resumable via cursor; caller invokes `migrate` repeatedly.
    Batched,
    /// No storage transformation required; old and new layouts coexist.
    ReadCompatible,
}

/// One directed edge in a contract's migration graph.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationEdge {
    pub from_version: u32,
    pub to_version: u32,
    pub kind: MigrationKind,
}

/// Default timelock for scheduled upgrades (7 days).
pub const UPGRADE_TIMELOCK_SECONDS: u64 = 604_800;
