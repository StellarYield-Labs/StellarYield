use soroban_sdk::{contracttype, Address, BytesN, Symbol, Val, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    VeYieldToken,
    ChallengeWindow,
    Proposal(u64),
    ProposalCount,
    IsInitialized,
    AllowedAction(Address, Symbol),
}

#[contracttype]
#[derive(Clone)]
pub enum UpgradeDataKey {
    StorageVersion,
    UpgradeCount,
    PendingUpgrade(u64),
    UpgradeStatus(u64),
    TargetWasmHash,
    CurrentWasmHash,
    MigrationPlanDigest,
    MigrationState,
    MigrationCursor(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Pending,
    Challenged,
    Executable,
    Executed,
    Failed,
    Cancelled,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub contract_id: Address,
    pub function: Symbol,
    pub args: Vec<Val>,
    pub action_hash: BytesN<32>,
    pub execution_time: u64,
    pub expiry_time: u64,
    pub status: ProposalStatus,
}
