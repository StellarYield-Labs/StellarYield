#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, symbol_short, Address, BytesN, Env, Symbol, Val, Vec,
};

mod storage;
mod upgrade;

#[cfg(test)]
mod test;

use storage::{DataKey, Proposal, ProposalStatus};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ProposalNotFound = 4,
    ChallengeWindowActive = 5,
    ProposalDisputed = 6,
    ProposalAlreadyExecuted = 7,
    InsufficientVotingPower = 8,
    ChallengeWindowExpired = 9,
    ActionNotAllowed = 10,
    ProposalExpired = 11,
    ProposalCancelled = 12,
    ProposalNotExecutable = 13,
    UpgradeAlreadyScheduled = 14,
    NoPendingUpgrade = 15,
    CodeHashMismatch = 16,
    MigrationPathNotFound = 17,
    MigrationInProgress = 18,
    Migrating = 19,
}

// Interface for ve_tokenomics (veYIELD)
mod ve_yield {
    use soroban_sdk::{contractclient, Address, Env};

    #[contractclient(name = "VeYieldClient")]
    #[allow(dead_code)]
    pub trait VeYieldInterface {
        fn get_voting_power(env: Env, user: Address) -> i128;
    }
}

#[contract]
pub struct OptimisticGovernance;

#[contractimpl]
impl OptimisticGovernance {
    /// Initialize the contract with an admin and the ve_tokenomics address.
    pub fn initialize(
        env: Env,
        admin: Address,
        ve_yield_token: Address,
        challenge_window: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::IsInitialized) {
            return Err(Error::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::VeYieldToken, &ve_yield_token);
        env.storage()
            .instance()
            .set(&DataKey::ChallengeWindow, &challenge_window);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::IsInitialized, &true);

        Ok(())
    }

    /// Register a (contract, function) pair as callable by governance
    /// proposals. Only the admin may extend the allowlist. Generic
    /// arbitrary invocation is impossible unless the target has been
    /// explicitly allowlisted here.
    pub fn allow_action(
        env: Env,
        caller: Address,
        contract_id: Address,
        function: Symbol,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        caller.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            return Err(Error::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::AllowedAction(contract_id, function), &true);

        Ok(())
    }

    /// Remove a (contract, function) pair from the allowlist.
    pub fn revoke_action(
        env: Env,
        caller: Address,
        contract_id: Address,
        function: Symbol,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        caller.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            return Err(Error::Unauthorized);
        }

        env.storage()
            .instance()
            .remove(&DataKey::AllowedAction(contract_id, function));

        Ok(())
    }

    pub fn is_action_allowed(env: Env, contract_id: Address, function: Symbol) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::AllowedAction(contract_id, function))
            .unwrap_or(false)
    }

    /// Submit a proposal with a payload to be executed after the challenge
    /// window. `action_hash` must be the sha256 of the canonical
    /// GovernanceAction reviewed off-chain (see actionSchema.ts) so that the
    /// action executed on-chain is byte-for-byte the action that was
    /// reviewed. `expiry_window` bounds how long the proposal remains
    /// executable once its challenge window ends.
    pub fn propose(
        env: Env,
        proposer: Address,
        contract_id: Address,
        function: Symbol,
        args: Vec<Val>,
        action_hash: BytesN<32>,
        expiry_window: u64,
    ) -> Result<u64, Error> {
        Self::require_init(&env)?;
        Self::require_not_migrating(&env)?;
        proposer.require_auth();

        // Check if proposer is admin
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if proposer != admin {
            return Err(Error::Unauthorized);
        }

        // Enforce the on-chain allowlist. Generic arbitrary invocation must
        // not bypass protocol controls.
        let allowed: bool = env
            .storage()
            .instance()
            .get(&DataKey::AllowedAction(
                contract_id.clone(),
                function.clone(),
            ))
            .unwrap_or(false);
        if !allowed {
            return Err(Error::ActionNotAllowed);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;

        let challenge_window: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ChallengeWindow)
            .unwrap();
        let execution_time = env.ledger().timestamp() + challenge_window;
        let expiry_time = execution_time + expiry_window;

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            contract_id,
            function,
            args,
            action_hash: action_hash.clone(),
            execution_time,
            expiry_time,
            status: ProposalStatus::Pending,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        env.events().publish(
            (symbol_short!("propose"), proposer),
            (proposal_id, execution_time, action_hash),
        );

        Ok(proposal_id)
    }

    /// Dispute a proposal, freezing its execution.
    /// Requires non-zero veYIELD voting power.
    pub fn dispute(env: Env, disputer: Address, proposal_id: u64) -> Result<(), Error> {
        Self::require_init(&env)?;
        Self::require_not_migrating(&env)?;
        disputer.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Pending {
            return Err(Error::ProposalAlreadyExecuted);
        }

        let current_time = env.ledger().timestamp();
        if current_time >= proposal.execution_time {
            return Err(Error::ChallengeWindowExpired);
        }

        // Check veYIELD voting power
        let ve_yield_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::VeYieldToken)
            .unwrap();
        let client = ve_yield::VeYieldClient::new(&env, &ve_yield_token);
        let voting_power = client.get_voting_power(&disputer);

        if voting_power <= 0 {
            return Err(Error::InsufficientVotingPower);
        }

        proposal.status = ProposalStatus::Challenged;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events()
            .publish((symbol_short!("dispute"), disputer), (proposal_id,));

        Ok(())
    }

    /// Resolve a challenged proposal. The admin may either reinstate it
    /// (clearing the challenge so it can execute again once its window
    /// reopens) or cancel it outright.
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        proposal_id: u64,
        reinstate: bool,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        caller.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            return Err(Error::Unauthorized);
        }

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Challenged {
            return Err(Error::ProposalNotFound);
        }

        if reinstate {
            let challenge_window: u64 = env
                .storage()
                .instance()
                .get(&DataKey::ChallengeWindow)
                .unwrap();
            let execution_time = env.ledger().timestamp() + challenge_window;
            proposal.execution_time = execution_time;
            proposal.status = ProposalStatus::Pending;
        } else {
            proposal.status = ProposalStatus::Cancelled;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events()
            .publish((symbol_short!("resolve"), proposal_id), (reinstate,));

        Ok(())
    }

    /// Cancel a pending proposal before its challenge window elapses.
    /// Only the original proposer or the admin may cancel.
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) -> Result<(), Error> {
        Self::require_init(&env)?;
        caller.require_auth();

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin && caller != proposal.proposer {
            return Err(Error::Unauthorized);
        }

        if proposal.status == ProposalStatus::Executed {
            return Err(Error::ProposalAlreadyExecuted);
        }
        if proposal.status == ProposalStatus::Cancelled {
            return Err(Error::ProposalCancelled);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events()
            .publish((symbol_short!("cancel"), proposal_id), ());

        Ok(())
    }

    /// Execute a proposal after the challenge window expires, if not
    /// disputed, cancelled, or past its expiry window.
    pub fn execute(env: Env, proposal_id: u64) -> Result<Val, Error> {
        Self::require_init(&env)?;
        Self::require_not_migrating(&env)?;

        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        match proposal.status {
            ProposalStatus::Challenged => return Err(Error::ProposalDisputed),
            ProposalStatus::Executed => return Err(Error::ProposalAlreadyExecuted),
            ProposalStatus::Cancelled => return Err(Error::ProposalCancelled),
            ProposalStatus::Expired => return Err(Error::ProposalExpired),
            ProposalStatus::Failed => return Err(Error::ProposalNotExecutable),
            ProposalStatus::Pending | ProposalStatus::Executable => {}
        }

        let current_time = env.ledger().timestamp();
        if current_time < proposal.execution_time {
            return Err(Error::ChallengeWindowActive);
        }

        if current_time > proposal.expiry_time {
            proposal.status = ProposalStatus::Expired;
            env.storage()
                .persistent()
                .set(&DataKey::Proposal(proposal_id), &proposal);
            return Err(Error::ProposalExpired);
        }

        // Re-verify the action is still allowlisted at execution time - an
        // admin may have revoked it between proposal and execution.
        let allowed: bool = env
            .storage()
            .instance()
            .get(&DataKey::AllowedAction(
                proposal.contract_id.clone(),
                proposal.function.clone(),
            ))
            .unwrap_or(false);
        if !allowed {
            proposal.status = ProposalStatus::Failed;
            env.storage()
                .persistent()
                .set(&DataKey::Proposal(proposal_id), &proposal);
            return Err(Error::ActionNotAllowed);
        }

        // Execute the payload
        let result: Val = env.invoke_contract(
            &proposal.contract_id,
            &proposal.function,
            proposal.args.clone(),
        );

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("execute"), proposal_id),
            (
                proposal.contract_id,
                proposal.function,
                proposal.action_hash,
            ),
        );

        Ok(result)
    }

    // ── Getters ───────────────────────────────────────────────────

    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    // ── Internal Helpers ──────────────────────────────────────────

    fn require_init(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::IsInitialized) {
            return Err(Error::NotInitialized);
        }
        Ok(())
    }

    fn require_not_migrating(env: &Env) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::MigrationActive) {
            return Err(Error::Migrating);
        }
        Ok(())
    }
}
