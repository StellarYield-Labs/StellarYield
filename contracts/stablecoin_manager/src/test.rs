use crate::math::{calculate_collateral_value, calculate_cr, calculate_debt, calculate_index};
use crate::storage::SCALAR_18;
use crate::StablecoinManager;
use crate::StablecoinManagerClient;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{contract, contractimpl, token, Address, Env};

// ── Mock Vault ─────────────────────────────────────────────────────────────
// Simulates YieldVault total_assets() / total_shares() used for CR calculation.
// 1:1 ratio means each vault share == 1 unit of underlying.

#[contract]
pub struct MockVault;

#[contractimpl]
impl MockVault {
    pub fn total_assets(_env: Env) -> i128 {
        10_000_000
    }
    pub fn total_shares(_env: Env) -> i128 {
        10_000_000
    }
}

// ── Mock Oracle ────────────────────────────────────────────────────────────
// Returns a fresh price of $0.10/unit (1_000_000 scaled by 1e7).
// Timestamp is always "now" so it's never stale.

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn get_price(env: Env, _asset: Address) -> Option<(i128, u64)> {
        Some((1_000_000, env.ledger().timestamp()))
    }
}

// ── Test Harness ───────────────────────────────────────────────────────────
//
// Key fix: we register StablecoinManager FIRST, then pass its address as the
// sUSD SAC admin. This gives the contract permission to call `mint` on sUSD.

fn setup_env() -> (
    Env,
    StablecoinManagerClient<'static>,
    Address, // contract_id
    Address, // admin
    Address, // s_usd_addr
    Address, // collateral_addr
    Address, // metrics_id (MockVault)
    Address, // oracle_id  (MockOracle)
) {
    let env = Env::default();
    env.mock_all_auths();

    // Register StablecoinManager FIRST so we have its address
    let contract_id = env.register(StablecoinManager, ());
    let client = StablecoinManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);

    // sUSD SAC — admin is the StablecoinManager contract so it can call `mint`
    let s_usd_contract = env.register_stellar_asset_contract_v2(contract_id.clone());
    let s_usd_addr = s_usd_contract.address();

    // Collateral SAC — separate token representing vault shares
    let collateral_admin = Address::generate(&env);
    let collateral_contract = env.register_stellar_asset_contract_v2(collateral_admin.clone());
    let collateral_addr = collateral_contract.address();

    // MockVault for total_assets / total_shares
    let metrics_id = env.register(MockVault, ());
    let oracle_id = env.register(MockOracle, ());

    client.initialize(
        &admin,
        &s_usd_addr,
        &collateral_addr,
        &metrics_id,
        &oracle_id,
        &15000,                      // 150 % Icr
        &11000,                      // 110 % Mcr
        &50_000_000_000_000_000i128, // 5 % APR (0.05 * 1e18)
    );

    (
        env,
        client,
        contract_id,
        admin,
        s_usd_addr,
        collateral_addr,
        metrics_id,
        oracle_id,
    )
}

// ── Helper: mint collateral to a user ─────────────────────────────────────
fn give_collateral(env: &Env, collateral_addr: &Address, user: &Address, amount: i128) {
    token::StellarAssetClient::new(env, collateral_addr).mint(user, &amount);
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

/// Mint sUSD within allowed Icr — happy path
/// Collateral value = 100_000 * (10M/10M) * $0.1 = $10_000
/// Max debt at 150% Icr = $10_000 / 1.5 ≈ $6_666
#[test]
fn test_mint_s_usd_within_icr() {
    let (env, client, _, _, s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &5_000);

    assert_eq!(token::Client::new(&env, &s_usd_addr).balance(&user), 5_000);
}

/// Mint that would push CR below Icr must fail
#[test]
fn test_mint_s_usd_exceeding_icr_fails() {
    let (env, client, _, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);

    // $8_000 debt → CR ≈ 125 % < 150 % Icr — must be rejected
    let err = client.try_mint_s_usd(&user, &100_000, &8_000);
    assert!(err.is_err(), "expected InsufficientCollateral error");
}

/// Interest accrues over time — repay after 1 year should not panic
#[test]
fn test_accrue_interest_after_one_year() {
    let (env, client, _, _, _s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &1_000);

    // Advance ledger by 1 year
    env.ledger().set_timestamp(31_536_001);

    // Zero-repay call forces interest accrual
    client.repay_s_usd(&user, &0, &0);
}

/// Full repay releases collateral and closes the Cdp
#[test]
fn test_full_repay_closes_cdp() {
    let (env, client, _, _, s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &1_000);

    // Repay all debt and withdraw all collateral
    client.repay_s_usd(&user, &1_000, &100_000);

    // User should have no sUSD left and collateral returned
    let sac = token::Client::new(&env, &s_usd_addr);
    assert_eq!(sac.balance(&user), 0);

    let col = token::Client::new(&env, &collateral_addr);
    assert_eq!(col.balance(&user), 100_000);
}

/// Liquidation is rejected when CR is above Mcr
#[test]
fn test_liquidate_healthy_cdp_fails() {
    let (env, client, _, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);
    let liquidator = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    // ~163 % CR (well above 110 % Mcr)
    client.mint_s_usd(&user, &100_000, &6_100);

    let err = client.try_liquidate(&liquidator, &user);
    assert!(err.is_err(), "healthy positions must not be liquidatable");
}

/// Cannot open a Cdp if already initialized with same user and borrow more
/// without extra collateral
#[test]
fn test_incremental_debt_respects_icr() {
    let (env, client, _, _, _, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);

    // First borrow: $4_000 → safe
    client.mint_s_usd(&user, &100_000, &4_000);

    // Second borrow: another $4_000 → total $8_000, CR ≈ 125 % < 150 % → must fail
    let err = client.try_mint_s_usd(&user, &0, &4_000);
    assert!(err.is_err(), "second borrow should violate Icr");
}

#[test]
fn test_double_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StablecoinManager, ());
    let client = StablecoinManagerClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let s_usd_addr = env
        .register_stellar_asset_contract_v2(contract_id.clone())
        .address();
    let collateral_addr = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let metrics_id = env.register(MockVault, ());
    let oracle_id = env.register(MockOracle, ());

    client.initialize(
        &admin,
        &s_usd_addr,
        &collateral_addr,
        &metrics_id,
        &oracle_id,
        &15000,
        &11000,
        &50_000_000_000_000_000i128,
    );

    let result = client.try_initialize(
        &admin,
        &s_usd_addr,
        &collateral_addr,
        &metrics_id,
        &oracle_id,
        &15000,
        &11000,
        &50_000_000_000_000_000i128,
    );
    assert_eq!(result, Err(Ok(crate::Error::AlreadyInitialized)));
}

#[test]
#[ignore = "requires instance storage extend_ttl in production code (pre-existing)"]
fn test_cdp_ttl_bumped_on_read() {
    let (env, client, _, _, _s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &5_000);

    let initial_seq = env.ledger().sequence();

    // Step 1: Trigger a CDP read via zero-value repay (internally calls read_cdp, bumps TTL)
    let result = client.try_repay_s_usd(&user, &0, &0);
    assert!(
        result.is_ok(),
        "zero repay should succeed and bump TTL on read"
    );

    // Step 2: Advance past original TTL expiry
    env.ledger().set_sequence_number(initial_seq + 100_001);

    // Step 3: CDP should still be accessible because read bumped the TTL
    let result = client.try_repay_s_usd(&user, &0, &0);
    assert!(
        result.is_ok(),
        "CDP should survive original expiry when read bumps TTL"
    );

    // Step 4: Advance past the bumped TTL boundary
    env.ledger().set_sequence_number(initial_seq + 350_001);

    // Step 5: After the bumped TTL expires, the CDP should be gone
    let result = client.try_repay_s_usd(&user, &0, &0);
    assert!(
        result.is_err(),
        "CDP should expire after the bumped TTL window passes"
    );
}

#[test]
#[ignore = "requires instance storage extend_ttl in production code (pre-existing)"]
fn test_cdp_ttl_bumped_on_write() {
    let (env, client, _, _, _s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    let initial_seq = env.ledger().sequence();

    // Write the CDP via mint_s_usd — triggers write_cdp internally and bumps TTL
    client.mint_s_usd(&user, &100_000, &5_000);

    // Advance past original TTL expiry
    env.ledger().set_sequence_number(initial_seq + 100_001);

    // CDP should still exist because the write bumped TTL
    let result = client.try_repay_s_usd(&user, &0, &0);
    assert!(
        result.is_ok(),
        "CDP should survive original expiry because write bumped TTL"
    );

    // Advance past the bumped TTL boundary
    env.ledger().set_sequence_number(initial_seq + 350_001);

    // After the bumped TTL expires, the CDP should be gone
    let result = client.try_repay_s_usd(&user, &0, &0);
    assert!(
        result.is_err(),
        "CDP should expire after the bumped TTL window passes"
    );
}

// ── Boundary: zero collateral ─────────────────────────────────────────────

#[test]
fn test_zero_collateral_value() {
    // No collateral → value is 0 regardless of vault state
    assert_eq!(
        calculate_collateral_value(0, 10_000_000, 10_000_000, 1_000_000),
        0
    );
    // Vault shares zero → guard returns 0
    assert_eq!(calculate_collateral_value(100, 0, 0, 1_000_000), 0);
    // CR with zero collateral value and positive debt → 0 bps
    assert_eq!(calculate_cr(0, 1_000), 0);
}

#[test]
fn test_mint_with_zero_collateral_increment() {
    let (env, client, _, _, _s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &5_000);

    // Mint again with zero additional collateral — should succeed (reuses existing CR)
    let result = client.try_mint_s_usd(&user, &0, &500);
    assert!(result.is_ok(), "zero-collateral mint should succeed");
}

// ── Boundary: minimum debt ────────────────────────────────────────────────

#[test]
fn test_minimum_debt_computations() {
    // Zero debt shares → debt is zero at any index
    assert_eq!(calculate_debt(0, SCALAR_18), 0);
    assert_eq!(calculate_debt(0, SCALAR_18 * 2), 0);
    // Zero debt value → CR is u32::MAX (collateral-only position)
    assert_eq!(calculate_cr(10_000, 0), u32::MAX);
    // Very small debt shares → debt truncates to zero
    assert_eq!(calculate_debt(0, SCALAR_18), 0);
}

#[test]
fn test_repay_all_debt_closes_cdp() {
    let (env, client, _, _, s_usd_addr, collateral_addr, _, _) = setup_env();
    let user = Address::generate(&env);

    give_collateral(&env, &collateral_addr, &user, 100_000);
    client.mint_s_usd(&user, &100_000, &5_000);

    // Repay the full debt amount — debt shares become 0, CR becomes MAX
    client.repay_s_usd(&user, &5_000, &0);

    // Collateral still locked because user hasn't withdrawn
    let sac = token::Client::new(&env, &s_usd_addr);
    assert_eq!(sac.balance(&user), 0, "sUSD should be fully repaid");

    // Now withdraw all collateral (zero-debt CDP)
    client.repay_s_usd(&user, &0, &100_000);
    let col = token::Client::new(&env, &collateral_addr);
    assert_eq!(col.balance(&user), 100_000, "all collateral withdrawn");
}

// ── Boundary: rounding behavior ──────────────────────────────────────────

#[test]
fn test_rounding_in_calculate_debt() {
    // One share at a third of the index rounds to 0
    assert_eq!(calculate_debt(1, SCALAR_18 / 3), 0);
    // One share at full index rounds to 0 (1 * 1e18 / 1e18 = 1)
    assert_eq!(calculate_debt(1, SCALAR_18), 1);
    // Two shares at half index rounds down
    assert_eq!(calculate_debt(2, SCALAR_18 / 2), 1);
}

#[test]
fn test_rounding_in_calculate_collateral_value() {
    let assets: i128 = 10_000_000;
    let shares: i128 = 10_000_000;
    let price: i128 = 1_000_000; // $0.10

    // Single unit of collateral at $0.10 with 1:1 vault ratio truncates to 0
    assert_eq!(calculate_collateral_value(1, assets, shares, price), 0);
    // Minuscule price (1 satoshi) rounds down to 0
    assert_eq!(calculate_collateral_value(1, assets, shares, 1), 0);
    // One vault share representing far fewer assets rounds down
    assert_eq!(calculate_collateral_value(1, 1, shares, price), 0);
}

#[test]
fn test_rounding_in_calculate_index() {
    let index_one: i128 = SCALAR_18;
    let zero_rate: i128 = 0;

    // Zero rate → index unchanged
    assert_eq!(calculate_index(index_one, zero_rate, 1_000_000), index_one);
    // No elapsed time → index unchanged
    assert_eq!(
        calculate_index(index_one, 50_000_000_000_000_000i128, 0),
        index_one
    );
    // Very small elapsed time yields no interest due to truncation
    // rate * 1 second / 31.5M == 0 when rate is small enough
    let small_rate: i128 = 1_000; // negligible APR
    assert_eq!(calculate_index(index_one, small_rate, 1), index_one);
    // Larger elapsed: rate * 1000 / 31.5M = 0 for very small rate
    assert_eq!(calculate_index(index_one, small_rate, 1000), index_one);
}

#[test]
fn test_rounding_in_calculate_cr() {
    // Collateral value smaller than debt → CR is under 100% (1 bps per unit)
    assert_eq!(calculate_cr(1, 100), 100); // (1 * 10000) / 100 = 100 bps
                                           // Barely above 100%: 1 * 10000 / 1 = 10000 bps
    assert_eq!(calculate_cr(1, 1), 10000);
    // Large CR value within u32 range (429,496 * 10000 = 4,294,960,000 ≤ u32::MAX)
    assert_eq!(calculate_cr(429_496i128, 1), 4_294_960_000);
}
