use soroban_sdk::{Address, BytesN, Env, String, Vec};

pub const UPGRADE_INTERFACE_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MigrationStepKind {
    OneShot,
    Batched,
    ReadCompatible,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationEdge {
    pub from_version: u32,
    pub to_version: u32,
    pub kind: MigrationStepKind,
    pub migration_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposal {
    pub network: String,
    pub contract_id: Address,
    pub current_wasm_hash: BytesN<32>,
    pub target_wasm_hash: BytesN<32>,
    pub migration_plan_digest: BytesN<32>,
    pub execution_time: u64,
    pub expiry_time: u64,
    pub migration_id: String,
    pub proposed_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpgradeStatus {
    None,
    Scheduled(UpgradeProposal),
    Ready(UpgradeProposal),
    Executing(UpgradeProposal),
    Completed(BytesN<32>),
    Failed(BytesN<32>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationChunk {
    pub cursor: u64,
    pub limit: u32,
    pub applied: u32,
}

pub trait MigratableContract {
    fn contract_version(env: Env) -> String;
    fn storage_version(env: Env) -> u32;
    fn schedule_upgrade(
        env: Env,
        governance: Address,
        target_wasm_hash: BytesN<32>,
        migration_plan_digest: BytesN<32>,
        migration_id: String,
        timelock_seconds: u64,
    ) -> Result<u64, u32>;
    fn cancel_upgrade(env: Env, governance: Address, proposal_id: u64) -> Result<(), u32>;
    fn execute_upgrade(env: Env, governance: Address, proposal_id: u64) -> Result<(), u32>;
    fn migrate(
        env: Env,
        from_version: u32,
        to_version: u32,
        cursor: u64,
        limit: u32,
    ) -> Result<MigrationChunk, u32>;
    fn migration_status(env: Env) -> Option<UpgradeStatus>;
    fn is_migrating(env: Env) -> bool;
}
