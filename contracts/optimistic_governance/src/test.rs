use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, Env, IntoVal, Symbol,
};

// Mock Target Contract for execution
#[contract]
pub struct TargetContract;

#[contractimpl]
impl TargetContract {
    pub fn action(_env: Env, value: i128) -> i128 {
        value + 1
    }
}

mod mock_ve_yield {
    use soroban_sdk::{contract, contractimpl, Address, Env};
    #[contract]
    pub struct MockVeYield;

    #[contractimpl]
    impl MockVeYield {
        pub fn get_voting_power(_env: Env, _user: Address) -> i128 {
            100
        }
    }
}
use mock_ve_yield::MockVeYield;

mod no_power_ve_yield {
    use soroban_sdk::{contract, contractimpl, Address, Env};
    #[contract]
    pub struct NoPowerVeYield;

    #[contractimpl]
    impl NoPowerVeYield {
        pub fn get_voting_power(_env: Env, _user: Address) -> i128 {
            0
        }
    }
}
use no_power_ve_yield::NoPowerVeYield;

fn dummy_hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

const EXPIRY_WINDOW: u64 = 7 * 24 * 60 * 60; // 7 days

#[test]
fn test_governance_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window = 3 * 24 * 60 * 60; // 3 days
    client.initialize(&admin, &ve_yield, &challenge_window);

    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);

    // 1. Propose
    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let hash = dummy_hash(&env, 1);
    let proposal_id = client.propose(&admin, &target, &action_fn, &args, &hash, &EXPIRY_WINDOW);

    assert_eq!(proposal_id, 1);
    let proposal = client.get_proposal(&1).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Pending);
    assert_eq!(proposal.action_hash, hash);

    // 2. Try execute early (should fail)
    let result = client.try_execute(&1);
    assert!(result.is_err());

    // 3. Fast forward time
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);

    // 4. Execute
    let val = client.execute(&1);
    let result_val: i128 = val.into_val(&env);
    assert_eq!(result_val, 11);

    let proposal = client.get_proposal(&1).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Executed);
}

#[test]
fn test_propose_rejects_non_allowlisted_action() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    client.initialize(&admin, &ve_yield, &(3 * 24 * 60 * 60));

    // No allow_action call - target/function pair is not allowlisted.
    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let result = client.try_propose(
        &admin,
        &target,
        &Symbol::new(&env, "action"),
        &args,
        &dummy_hash(&env, 2),
        &EXPIRY_WINDOW,
    );

    assert_eq!(result, Err(Ok(Error::ActionNotAllowed)));
}

#[test]
fn test_revoke_action_blocks_future_proposals() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    client.initialize(&admin, &ve_yield, &(3 * 24 * 60 * 60));

    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);
    client.revoke_action(&admin, &target, &action_fn);

    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let result = client.try_propose(
        &admin,
        &target,
        &action_fn,
        &args,
        &dummy_hash(&env, 3),
        &EXPIRY_WINDOW,
    );

    assert_eq!(result, Err(Ok(Error::ActionNotAllowed)));
}

#[test]
fn test_cancel_proposal() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    client.initialize(&admin, &ve_yield, &(3 * 24 * 60 * 60));
    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);

    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let proposal_id = client.propose(
        &admin,
        &target,
        &action_fn,
        &args,
        &dummy_hash(&env, 4),
        &EXPIRY_WINDOW,
    );

    client.cancel(&admin, &proposal_id);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Cancelled);

    // Cannot execute a cancelled proposal even after the window elapses.
    env.ledger()
        .with_mut(|li| li.timestamp = 3 * 24 * 60 * 60 + 1);
    let result = client.try_execute(&proposal_id);
    match result {
        Err(Ok(Error::ProposalCancelled)) => (),
        _ => panic!("expected ProposalCancelled"),
    }
}

#[test]
fn test_proposal_expires_after_expiry_window() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);
    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);

    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let proposal_id = client.propose(
        &admin,
        &target,
        &action_fn,
        &args,
        &dummy_hash(&env, 5),
        &EXPIRY_WINDOW,
    );

    // Fast forward past both the challenge window and the expiry window.
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + EXPIRY_WINDOW + 1);

    let result = client.try_execute(&proposal_id);
    match result {
        Err(Ok(Error::ProposalExpired)) => (),
        _ => panic!("expected ProposalExpired"),
    }

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Expired);
}

#[test]
fn test_dispute_then_resolve_cancel() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);
    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);

    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let proposal_id = client.propose(
        &admin,
        &target,
        &action_fn,
        &args,
        &dummy_hash(&env, 6),
        &EXPIRY_WINDOW,
    );

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Challenged);

    // Admin resolves the dispute by cancelling.
    client.resolve_dispute(&admin, &proposal_id, &false);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Cancelled);

    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);
    let result = client.try_execute(&proposal_id);
    match result {
        Err(Ok(Error::ProposalCancelled)) => (),
        _ => panic!("expected ProposalCancelled"),
    }
}

#[test]
fn test_dispute() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let ve_yield = env.register(MockVeYield, ());
    let target = env.register(TargetContract, ());

    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    let challenge_window = 3 * 24 * 60 * 60;
    client.initialize(&admin, &ve_yield, &challenge_window);
    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);

    // Propose
    let args: Vec<Val> = vec![&env, 10i128.into_val(&env)];
    let proposal_id = client.propose(
        &admin,
        &target,
        &action_fn,
        &args,
        &dummy_hash(&env, 7),
        &EXPIRY_WINDOW,
    );

    // Dispute
    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);

    let proposal = client.get_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.status, ProposalStatus::Challenged);

    // Fast forward
    env.ledger()
        .with_mut(|li| li.timestamp = challenge_window + 1);

    // Try execute (should fail)
    let result = client.try_execute(&proposal_id);
    assert!(result.is_err());
}

#[test]
#[should_panic(expected = "HostError: Error(Contract, #8)")] // InsufficientVotingPower
fn test_dispute_no_power() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let ve_yield = env.register(NoPowerVeYield, ());
    let target = env.register(TargetContract, ());
    let gov_id = env.register(OptimisticGovernance, ());
    let client = OptimisticGovernanceClient::new(&env, &gov_id);

    client.initialize(&admin, &ve_yield, &(3 * 24 * 60 * 60));
    let action_fn = Symbol::new(&env, "action");
    client.allow_action(&admin, &target, &action_fn);

    let args: Vec<Val> = vec![&env, 0i128.into_val(&env)];
    let proposal_id = client.propose(
        &admin,
        &target,
        &action_fn,
        &args,
        &dummy_hash(&env, 8),
        &EXPIRY_WINDOW,
    );

    let disputer = Address::generate(&env);
    client.dispute(&disputer, &proposal_id);
}
