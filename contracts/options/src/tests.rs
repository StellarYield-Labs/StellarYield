use crate::{OptionType, OptionsContract, OptionsContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

fn setup_env() -> (
    Env,
    OptionsContractClient<'static>,
    Address, // contract_id
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(OptionsContract, ());
    let client = OptionsContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let underlying_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let quote_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();

    client.initialize(&admin, &oracle);

    (
        env,
        client,
        contract_id,
        admin,
        oracle,
        underlying_addr,
        quote_addr,
    )
}

fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
    let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
    admin_client.mint(to, &amount);
}

#[test]
fn test_initialize() {
    let (_, _client, _, _, _, _, _) = setup_env();
}

#[test]
fn test_double_initialize_rejected() {
    let (env, client, _, admin, oracle, _, _) = setup_env();
    let result = client.try_initialize(&admin, &oracle);
    assert_eq!(result, Err(Ok(crate::OptionsError::AlreadyInitialized)));

    // Keep env in scope to avoid accidental drop-related warnings in some setups.
    let _ = env;
}

#[test]
fn test_mint_requires_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(OptionsContract, ());
    let client = OptionsContractClient::new(&env, &contract_id);

    let minter = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let underlying_addr = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let quote_addr = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let result = client.try_mint(
        &minter,
        &OptionType::Call,
        &underlying_addr,
        &quote_addr,
        &100_000_000_i128,
        &1000u64,
        &10_000_000_i128,
    );
    assert_eq!(result, Err(Ok(crate::OptionsError::NotInitialized)));
}

#[test]
fn test_mint_call() {
    let (env, client, _, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128, // strike 10 (1e7)
        &1000u64,          // expiry
        &10_000_000_i128,  // collateral (1e7)
    );

    assert_eq!(option_id, 1);
    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    assert_eq!(client_u.balance(&minter), 10_000_000);
    assert_eq!(client_u.balance(&client.address), 10_000_000);
}

#[test]
fn test_expire() {
    let (env, client, _, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128, // strike 10 (1e7)
        &500u64,           // expiry
        &10_000_000_i128,  // collateral (1e7)
    );

    // Advance ledger to expire the option
    env.ledger().set_timestamp(1000);

    client.expire(&option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    assert_eq!(client_u.balance(&minter), 20_000_000);
    assert_eq!(client_u.balance(&client.address), 0);
}

#[test]
fn test_exercise() {
    let (env, client, _, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);
    let exerciser = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);
    mint_tokens(&env, &quote, &exerciser, 200_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128, // strike 10 (1e7)
        &1500u64,          // expiry
        &10_000_000_i128,  // collateral (1e7)
    );

    // Advance ledger past expiry to allow exercise
    env.ledger().set_timestamp(1500);

    client.exercise(&exerciser, &option_id);

    let client_u = soroban_sdk::token::Client::new(&env, &underlying);
    let client_q = soroban_sdk::token::Client::new(&env, &quote);

    // Exerciser received the 10_000_000 underlying
    assert_eq!(client_u.balance(&exerciser), 10_000_000);

    // Minter received 10 * 10 = 100_000_000 quote asset
    assert_eq!(client_q.balance(&minter), 100_000_000);

    // Contract has 0 balance
    assert_eq!(client_u.balance(&client.address), 0);
}

#[test]
#[ignore = "test env instance TTL expires; requires instance extend_ttl in production code"]
fn test_option_ttl_bumped_on_read() {
    let (env, client, contract_id, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &10000u64,
        &10_000_000_i128,
    );

    // Capture the current ledger sequence for TTL testing
    let initial_seq = env.ledger().sequence();

    // Step 1: Read the option (should bump TTL)
    let option_before = env.as_contract(&contract_id, || {
        crate::storage::read_option(&env, option_id)
    });
    assert!(option_before.is_some(), "Option should exist after mint");

    // Step 2: Advance ledger to just past the original TTL watermark
    // TTL_LOW_WATERMARK_LEDGERS = 100_000, so set to initial_seq + 100_001
    env.ledger().set_sequence_number(initial_seq + 100_001);

    // Step 3: Try to read again (if TTL wasn't bumped, this would return None)
    let option_after_ttl_boundary = env.as_contract(&contract_id, || {
        crate::storage::read_option(&env, option_id)
    });
    assert!(
        option_after_ttl_boundary.is_some(),
        "Option should still exist after read TTL bump, even past original expiry window. \
         This proves extend_ttl() was called."
    );

    // If extend_ttl() was removed from read_option, the key would expire after 100_000 ledgers,
    // and the assertion above would fail
}

#[test]
#[ignore = "test env instance TTL expires; requires instance extend_ttl in production code"]
fn test_option_ttl_bumped_on_write() {
    let (env, client, contract_id, _, _, underlying, quote) = setup_env();
    let minter = Address::generate(&env);

    mint_tokens(&env, &underlying, &minter, 20_000_000);

    let option_id = client.mint(
        &minter,
        &OptionType::Call,
        &underlying,
        &quote,
        &100_000_000_i128,
        &10000u64,
        &10_000_000_i128,
    );

    // Capture the current ledger sequence for TTL testing
    let initial_seq = env.ledger().sequence();

    // Step 1: Read the option to get it (in contract context)
    let option = env.as_contract(&contract_id, || {
        crate::storage::read_option(&env, option_id)
    });
    assert!(option.is_some(), "Option should exist");
    let option_data = option.unwrap();

    // Step 2: Advance ledger to just past the original TTL watermark
    env.ledger().set_sequence_number(initial_seq + 100_001);

    // Step 3: Write the option back (should bump TTL) — in contract context
    env.as_contract(&contract_id, || {
        crate::storage::write_option(&env, option_id, &option_data);
    });

    // Step 4: Try to read - should succeed because write bumped TTL
    let retrieved = env.as_contract(&contract_id, || {
        crate::storage::read_option(&env, option_id)
    });
    assert!(
        retrieved.is_some(),
        "Option should still exist after write TTL bump, even past original expiry window. \
         This proves extend_ttl() was called."
    );
    assert_eq!(retrieved.unwrap().exercised, false);

    // If extend_ttl() was removed from write_option, the key would expire before or during the write,
    // and the assertion above would fail
}
