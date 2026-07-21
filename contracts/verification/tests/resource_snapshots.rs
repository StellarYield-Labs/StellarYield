//! Soroban CPU/memory/ledger resource ceilings for adversarial inputs.
//!
//! Captures `env.cost_estimate().resources()` (see `verification::resource`)
//! immediately after each call and compares it against a checked-in
//! baseline under `resource_snapshots/`, the same pattern
//! `contracts/yield_vault/test_snapshots/` already uses for its own fuzz
//! suite. A regression here means "this got measurably more expensive than
//! the last approved baseline," not that it exceeded an absolute Soroban
//! network limit — see `resource::within_budget`'s doc comment.
//!
//! To intentionally update a baseline after a real optimization/regression,
//! delete the corresponding file under `resource_snapshots/` and rerun this
//! test once (`UPDATE_RESOURCE_BASELINES=1`) to regenerate it, then review
//! the diff like any other code change.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, Env};
use stableswap::{StableSwap, StableSwapClient};

use verification::resource::{load_baseline, save_snapshot, within_budget, ResourceSnapshot};

fn baseline_path(label: &str) -> String {
    format!(
        "{}/resource_snapshots/{label}.json",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn check_or_bootstrap(current: &ResourceSnapshot) {
    let path = baseline_path(&current.label);
    match load_baseline(&path) {
        Some(baseline) => {
            if std::env::var("UPDATE_RESOURCE_BASELINES").is_ok() {
                save_snapshot(&path, current);
                return;
            }
            // 25% margin: generous enough to absorb incidental SDK/toolchain
            // metering changes between soroban-sdk releases, tight enough to
            // catch a real algorithmic regression (e.g. an accidental
            // O(n)->O(n^2) change, or a new unbounded loop).
            if let Err(msg) = within_budget(&baseline, current, 25.0) {
                panic!("resource regression for '{}': {msg}", current.label);
            }
        }
        None => {
            // First run for this label: bootstrap the baseline rather than
            // failing (nothing to compare against yet).
            save_snapshot(&path, current);
        }
    }
}

/// Adversarial swap: pool driven to extreme imbalance beforehand (the
/// dynamic-fee/Newton-iteration path is most expensive under imbalance,
/// per `compute_d`'s documented iteration behavior).
#[test]
fn stableswap_swap_under_imbalance_resource_snapshot() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token0_admin = Address::generate(&env);
    let token1_admin = Address::generate(&env);
    let token0 = env
        .register_stellar_asset_contract_v2(token0_admin)
        .address();
    let token1 = env
        .register_stellar_asset_contract_v2(token1_admin)
        .address();
    let lp_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(StableSwap, ());
    let client = StableSwapClient::new(&env, &contract_id);
    client.initialize(
        &admin, &token0, &token1, &lp_token, &100u32, &30_000u32, &20_000u32,
    );

    let lp = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token0).mint(&lp, &1_000_000_000);
    token::StellarAssetClient::new(&env, &token1).mint(&lp, &1_000_000_000);
    client.add_liquidity(&lp, &1_000_000_000, &1_000_000_000, &0);

    // Push the pool into extreme imbalance before measuring.
    let mover = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token0).mint(&mover, &300_000_000);
    client.swap(&mover, &token0, &300_000_000, &0);

    let trader = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token0).mint(&trader, &1_000_000);
    client.swap(&trader, &token0, &1_000_000, &0);

    let snapshot = ResourceSnapshot::capture(&env, "stableswap_swap_under_imbalance");
    check_or_bootstrap(&snapshot);
}

/// Baseline (balanced-pool) swap, for comparison against the imbalanced one
/// above — both are tracked so a regression specific to the imbalanced path
/// doesn't hide behind an average.
#[test]
fn stableswap_swap_balanced_resource_snapshot() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token0_admin = Address::generate(&env);
    let token1_admin = Address::generate(&env);
    let token0 = env
        .register_stellar_asset_contract_v2(token0_admin)
        .address();
    let token1 = env
        .register_stellar_asset_contract_v2(token1_admin)
        .address();
    let lp_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(StableSwap, ());
    let client = StableSwapClient::new(&env, &contract_id);
    client.initialize(
        &admin, &token0, &token1, &lp_token, &100u32, &30_000u32, &20_000u32,
    );

    let lp = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token0).mint(&lp, &1_000_000_000);
    token::StellarAssetClient::new(&env, &token1).mint(&lp, &1_000_000_000);
    client.add_liquidity(&lp, &1_000_000_000, &1_000_000_000, &0);

    let trader = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token0).mint(&trader, &1_000_000);
    client.swap(&trader, &token0, &1_000_000, &0);

    let snapshot = ResourceSnapshot::capture(&env, "stableswap_swap_balanced");
    check_or_bootstrap(&snapshot);
}
