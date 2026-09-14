//! Shared upgrade & migration implementation.
//!
//! Include via `#[path = "../../interfaces/upgrade_impl.rs"] mod upgrade_impl;`
//! in each upgradeable contract.

use soroban_sdk::{contracttype, symbol_short, Address, BytesN, Env, String};

use crate::{Error, UpgradeDataKey, CONTRACT_NAME, STORAGE_VERSION};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposal {
    pub id: u64,
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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UpgradeProposalStatus {
    None,
    Scheduled,
    Ready,
    Executing,
    Completed,
    Failed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationChunk {
    pub cursor: u64,
    pub limit: u32,
    pub applied: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationState {
    pub from_version: u32,
    pub to_version: u32,
    pub cursor: u64,
    pub total_applied: u32,
    pub complete: bool,
}

fn get_current_wasm_hash(env: &Env) -> BytesN<32> {
    env.storage()
        .instance()
        .get(&UpgradeDataKey::CurrentWasmHash)
        .unwrap_or(BytesN::from_array(env, &[0u8; 32]))
}

fn get_network(_env: &Env) -> String {
    String::from_str(_env, "stellaryield")
}

pub fn schedule_upgrade(
    env: &Env,
    governance: &Address,
    target_wasm_hash: BytesN<32>,
    migration_plan_digest: BytesN<32>,
    migration_id: String,
    timelock_seconds: u64,
) -> Result<u64, Error> {
    governance.require_auth();

    let count: u64 = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::UpgradeCount)
        .unwrap_or(0);
    let proposal_id = count + 1;
    let now = env.ledger().timestamp();
    let execution_time = now + timelock_seconds;
    let expiry_time = execution_time + 86400 * 7;

    let current_wasm_hash = get_current_wasm_hash(env);

    let proposal = UpgradeProposal {
        id: proposal_id,
        network: get_network(env),
        contract_id: env.current_contract_address(),
        current_wasm_hash,
        target_wasm_hash: target_wasm_hash.clone(),
        migration_plan_digest: migration_plan_digest.clone(),
        execution_time,
        expiry_time,
        migration_id: migration_id.clone(),
        proposed_at: now,
    };

    env.storage()
        .instance()
        .set(&UpgradeDataKey::PendingUpgrade(proposal_id), &proposal);
    env.storage()
        .instance()
        .set(&UpgradeDataKey::UpgradeCount, &proposal_id);
    env.storage().instance().set(
        &UpgradeDataKey::UpgradeStatus(proposal_id),
        &UpgradeProposalStatus::Scheduled,
    );

    env.events().publish(
        (symbol_short!("up_sch"), proposal_id),
        (
            proposal.current_wasm_hash,
            proposal.target_wasm_hash,
            proposal.execution_time,
            migration_plan_digest,
            migration_id,
        ),
    );

    Ok(proposal_id)
}

pub fn cancel_upgrade(env: &Env, governance: &Address, proposal_id: u64) -> Result<(), Error> {
    governance.require_auth();

    let status: UpgradeProposalStatus = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::UpgradeStatus(proposal_id))
        .ok_or(Error::UpgradeNotFound)?;

    match status {
        UpgradeProposalStatus::Scheduled | UpgradeProposalStatus::Ready => {
            env.storage().instance().set(
                &UpgradeDataKey::UpgradeStatus(proposal_id),
                &UpgradeProposalStatus::Failed,
            );
            env.storage()
                .instance()
                .remove(&UpgradeDataKey::PendingUpgrade(proposal_id));
            env.events()
                .publish((symbol_short!("up_can"), proposal_id), ());
            Ok(())
        }
        _ => Err(Error::UpgradeNotScheduled),
    }
}

pub fn execute_upgrade(env: &Env, governance: &Address, proposal_id: u64) -> Result<(), Error> {
    governance.require_auth();

    let status: UpgradeProposalStatus = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::UpgradeStatus(proposal_id))
        .ok_or(Error::UpgradeNotFound)?;

    if status != UpgradeProposalStatus::Scheduled && status != UpgradeProposalStatus::Ready {
        return Err(Error::UpgradeNotScheduled);
    }

    let proposal: UpgradeProposal = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::PendingUpgrade(proposal_id))
        .ok_or(Error::UpgradeNotFound)?;

    let now = env.ledger().timestamp();
    if now < proposal.execution_time {
        return Err(Error::TimelockActive);
    }
    if now > proposal.expiry_time {
        env.storage().instance().set(
            &UpgradeDataKey::UpgradeStatus(proposal_id),
            &UpgradeProposalStatus::Failed,
        );
        return Err(Error::ProposalExpired);
    }

    let current_hash = get_current_wasm_hash(env);
    if current_hash != proposal.current_wasm_hash {
        return Err(Error::WasmHashMismatch);
    }

    env.storage().instance().set(
        &UpgradeDataKey::UpgradeStatus(proposal_id),
        &UpgradeProposalStatus::Executing,
    );
    env.storage()
        .instance()
        .set(&UpgradeDataKey::TargetWasmHash, &proposal.target_wasm_hash);
    env.storage().instance().set(
        &UpgradeDataKey::MigrationPlanDigest,
        &proposal.migration_plan_digest,
    );

    env.events().publish(
        (symbol_short!("up_exe"), proposal_id),
        (proposal.target_wasm_hash, proposal.execution_time),
    );

    Ok(())
}

pub fn finalize_upgrade(env: &Env, proposal_id: u64) -> Result<(), Error> {
    let target_wasm_hash: BytesN<32> = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::TargetWasmHash)
        .ok_or(Error::UpgradeNotFound)?;

    env.deployer()
        .update_current_contract_wasm(target_wasm_hash.clone());

    env.storage()
        .instance()
        .set(&UpgradeDataKey::CurrentWasmHash, &target_wasm_hash);
    env.storage().instance().set(
        &UpgradeDataKey::UpgradeStatus(proposal_id),
        &UpgradeProposalStatus::Completed,
    );
    env.storage()
        .instance()
        .remove(&UpgradeDataKey::TargetWasmHash);
    env.storage()
        .instance()
        .remove(&UpgradeDataKey::MigrationPlanDigest);

    let new_version = STORAGE_VERSION;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::StorageVersion, &new_version);

    env.events().publish(
        (symbol_short!("up_fin"), proposal_id),
        (target_wasm_hash, new_version),
    );

    Ok(())
}

pub fn migration_status(env: &Env) -> Option<MigrationState> {
    env.storage()
        .instance()
        .get(&UpgradeDataKey::MigrationState)
}

pub fn is_migrating(env: &Env) -> bool {
    if let Some(state) = migration_status(env) {
        !state.complete
    } else {
        false
    }
}

pub fn start_migration(env: &Env, from_version: u32, to_version: u32) -> Result<(), Error> {
    if is_migrating(env) {
        return Err(Error::MigrationInProgress);
    }

    let state = MigrationState {
        from_version,
        to_version,
        cursor: 0,
        total_applied: 0,
        complete: false,
    };

    env.storage()
        .instance()
        .set(&UpgradeDataKey::MigrationState, &state);

    env.events()
        .publish((symbol_short!("mig_str"),), (from_version, to_version));
    Ok(())
}

pub fn advance_migration(env: &Env, cursor: u64, limit: u32) -> Result<MigrationChunk, Error> {
    let mut state: MigrationState = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::MigrationState)
        .ok_or(Error::MigrationNotStarted)?;

    state.cursor = cursor;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::MigrationState, &state);

    let chunk = MigrationChunk {
        cursor,
        limit,
        applied: 0,
    };
    env.events()
        .publish((symbol_short!("mig_adv"),), (cursor, limit));
    Ok(chunk)
}

pub fn complete_migration(env: &Env) -> Result<(), Error> {
    let mut state: MigrationState = env
        .storage()
        .instance()
        .get(&UpgradeDataKey::MigrationState)
        .ok_or(Error::MigrationNotStarted)?;

    state.complete = true;
    env.storage()
        .instance()
        .set(&UpgradeDataKey::MigrationState, &state);
    env.storage()
        .instance()
        .set(&UpgradeDataKey::StorageVersion, &state.to_version);

    env.events().publish(
        (symbol_short!("mig_end"),),
        (state.from_version, state.to_version, state.total_applied),
    );

    Ok(())
}

pub fn contract_version(env: &Env) -> String {
    let _ = env;
    String::from_str(env, CONTRACT_NAME)
}

pub fn storage_version(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&UpgradeDataKey::StorageVersion)
        .unwrap_or(STORAGE_VERSION)
}

pub fn check_migration_gate(env: &Env) -> Result<(), Error> {
    if is_migrating(env) {
        return Err(Error::MigrationInProgress);
    }
    Ok(())
}
