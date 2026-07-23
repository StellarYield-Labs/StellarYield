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
    // Upgrade / migration keys
    ContractVersion,
    StorageVersion,
    CodeHash,
    PendingUpgrade,
    MigrationRegistry,
    MigrationCursor(u32, u32),
    MigrationBatch(u32, u32),
    MigrationEdges,
    MigrationActive,
    // Allowlist of (contract, function) pairs that governance is permitted
    // to invoke. Arbitrary contract calls outside this set are rejected at
    // propose-time so a compromised or malicious proposer cannot bypass
    // protocol controls via generic invocation.
    AllowedAction(Address, Symbol),
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
    /// sha256 of the canonical GovernanceAction payload reviewed off-chain.
    /// Must match the hash produced by server/src/governance/actionSchema.ts
    /// for the same logical action, so what was reviewed is byte-for-byte
    /// what executes.
    pub action_hash: BytesN<32>,
    pub execution_time: u64,
    pub expiry_time: u64,
    pub status: ProposalStatus,
}
