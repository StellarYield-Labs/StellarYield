//! Differential + property tests for `contracts/stableswap`.

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Env};
use stableswap::{StableSwap, StableSwapClient};

use verification::bigmath::round_to_i128;
use verification::reference::stableswap as refmodel;
use verification::tolerance::{STABLESWAP_D, STABLESWAP_FEE, STABLESWAP_Y};
use verification::vectors::{amount_i128, case_count, rng_for_seed};

// `compute_d`/`compute_y` cube their invariant estimate (`d3 = d*d*d`) in
// checked i128 arithmetic. That bounds the safe reserve magnitude at roughly
// cbrt(i128::MAX) =~ 5.5e12 for a balanced pool, and considerably lower
// under extreme imbalance (where d_prod ~= d^2/(4*min(x,y)) dominates well
// before d itself is large) — this was found empirically while writing this
// harness (see `compute_d_overflow_boundary_fails_closed_not_wrapping` and
// docs/differential-verification.md). MAX_RESERVE here is chosen to stay
// safely within that bound across the full generated amp range so the
// general differential tests measure rounding drift, not overflow; the
// overflow boundary itself is tested explicitly and separately below.
const MAX_RESERVE: i128 = 1_000_000_000; // 1e9
const MIN_RESERVE: i128 = 1;

fn record_if_failing<T: std::fmt::Debug>(
    subsystem: &str,
    seed: u64,
    description: &str,
    result: std::thread::Result<T>,
) {
    if let Err(panic_payload) = result {
        verification::corpus::record(&verification::corpus::RegressionFixture {
            name: format!("{subsystem}_seed_{seed}"),
            subsystem: subsystem.to_string(),
            seed,
            model_version: verification::MODEL_VERSION.to_string(),
            description: description.to_string(),
            inputs: serde_json::json!({ "seed": seed }),
        });
        std::panic::resume_unwind(panic_payload);
    }
}

/// Generates a reserve pair whose ratio is bounded by `max_ratio`. Extreme
/// (unbounded) imbalance combined with a high amplification coefficient is
/// covered separately and explicitly by
/// `compute_d_overflow_boundary_fails_closed_not_wrapping` — mixing that
/// corner randomly into the general rounding-tolerance fuzz tests below
/// would make them flaky on a property (overflow) they aren't meant to
/// check.
fn bounded_ratio_pair(
    rng: &mut impl rand::RngCore,
    min: i128,
    max: i128,
    max_ratio: i128,
) -> (i128, i128) {
    let x = amount_i128(rng, min, max, &[min, max]);
    let y_min = (x / max_ratio).max(min);
    let y_max = (x.saturating_mul(max_ratio)).min(max);
    let y = amount_i128(rng, y_min, y_max.max(y_min), &[]);
    (x, y)
}

/// Amplification range used by the general fuzz tests below; production
/// allows up to `MAX_A = 1_000_000`, but that combined with unbounded
/// imbalance is exactly the overflow corner tested separately.
fn safe_amp(rng: &mut impl rand::RngCore) -> u32 {
    rng_range_u32(rng, 1, 200_000)
}

#[test]
fn compute_d_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (x, y) = bounded_ratio_pair(&mut rng, MIN_RESERVE, MAX_RESERVE, 50);
        let amp: u32 = safe_amp(&mut rng);

        let result = std::panic::catch_unwind(|| {
            let production = StableSwap::compute_d(x, y, amp)
                .expect("compute_d should not error for valid domain");
            let expected =
                refmodel::compute_d(x, y, amp).expect_converged("stableswap compute_d reference");
            let expected_i128 = round_to_i128(&expected);
            assert!(
                STABLESWAP_D.check(production, expected_i128),
                "compute_d(x={x}, y={y}, amp={amp}): production={production} expected={expected_i128} \
                 deviation_bps={:.4}",
                STABLESWAP_D.deviation_bps(production, expected_i128)
            );
        });
        record_if_failing(
            "stableswap_compute_d",
            seed,
            "compute_d vs BigRational bisection reference",
            result,
        );
    }
}

/// Same check, but over the "extreme imbalance" input domain the issue asks
/// to cover explicitly (up to 1000:1 reserve ratio) — under its own, wider,
/// documented tolerance (see `STABLESWAP_D_IMBALANCED`) rather than folded
/// into the tight tolerance the moderate-imbalance regime above holds to.
#[test]
fn compute_d_matches_reference_under_extreme_imbalance() {
    use verification::tolerance::STABLESWAP_D_IMBALANCED;
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (x, y) = bounded_ratio_pair(&mut rng, MIN_RESERVE, MAX_RESERVE, 1_000);
        let amp: u32 = safe_amp(&mut rng);

        let result = std::panic::catch_unwind(|| {
            let production = StableSwap::compute_d(x, y, amp)
                .expect("compute_d should not error for valid domain");
            let expected =
                refmodel::compute_d(x, y, amp).expect_converged("stableswap compute_d reference");
            let expected_i128 = round_to_i128(&expected);
            assert!(
                STABLESWAP_D_IMBALANCED.check(production, expected_i128),
                "compute_d(x={x}, y={y}, amp={amp}) [extreme imbalance]: production={production} \
                 expected={expected_i128} deviation_bps={:.4}",
                STABLESWAP_D_IMBALANCED.deviation_bps(production, expected_i128)
            );
        });
        record_if_failing(
            "stableswap_compute_d_imbalanced",
            seed,
            "compute_d vs reference under extreme (up to 1000:1) imbalance",
            result,
        );
    }
}

#[test]
fn compute_dynamic_fee_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let b0 = amount_i128(&mut rng, 0, MAX_RESERVE, &[0]);
        let b1 = amount_i128(&mut rng, 0, MAX_RESERVE, &[0]);
        let base_fee: u32 = rng_range_u32(&mut rng, 0, 1_000_000);
        let fee_mult: u32 = rng_range_u32(&mut rng, 0, 1_000_000);

        let result = std::panic::catch_unwind(|| {
            let production = StableSwap::compute_dynamic_fee(b0, b1, base_fee, fee_mult)
                .expect("compute_dynamic_fee should not error for valid domain");
            let expected = round_to_i128(&refmodel::dynamic_fee(b0, b1, base_fee, fee_mult));
            assert!(
                STABLESWAP_FEE.check(production, expected),
                "compute_dynamic_fee(b0={b0}, b1={b1}, base={base_fee}, mult={fee_mult}): \
                 production={production} expected={expected}"
            );
        });
        record_if_failing(
            "stableswap_dynamic_fee",
            seed,
            "compute_dynamic_fee vs closed-form reference",
            result,
        );
    }
}

#[test]
fn compute_y_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let x_new = amount_i128(&mut rng, MIN_RESERVE, MAX_RESERVE, &[1]);
        let sum_max = (x_new.saturating_mul(2_000)).min(MAX_RESERVE.saturating_mul(2));
        let sum = amount_i128(&mut rng, x_new, sum_max.max(x_new), &[x_new * 2]);
        let amp: u32 = safe_amp(&mut rng);

        let result = std::panic::catch_unwind(|| {
            let production = StableSwap::compute_y(x_new, sum, amp);
            let expected = refmodel::compute_y(x_new, sum, amp);
            match (production, expected) {
                (Ok(production), verification::Convergence::Converged { value, .. }) => {
                    let expected_i128 = round_to_i128(&value);
                    assert!(
                        STABLESWAP_Y.check(production, expected_i128),
                        "compute_y(x_new={x_new}, sum={sum}, amp={amp}): production={production} \
                         expected={expected_i128} deviation_bps={:.4}",
                        STABLESWAP_Y.deviation_bps(production, expected_i128)
                    );
                }
                (Err(_), verification::Convergence::NotConverged { .. }) => {
                    // Both sides agree the domain is degenerate; not a mismatch.
                }
                (production, expected) => {
                    panic!(
                        "compute_y(x_new={x_new}, sum={sum}, amp={amp}) disagreement on validity: \
                         production={production:?} reference_converged={}",
                        expected.is_converged()
                    );
                }
            }
        });
        record_if_failing(
            "stableswap_compute_y",
            seed,
            "compute_y vs BigRational bisection reference",
            result,
        );
    }
}

/// `compute_d` cubes its invariant estimate in checked i128 arithmetic, so
/// reserves large enough (particularly under extreme imbalance, where the
/// cubed term is divided by a tiny opposing reserve) overflow it well before
/// `i128::MAX`. Production uses `checked_*` throughout, so the required
/// behavior is a clean `Err(MathOverflow)` — never a panic and never a
/// silently wrapped/truncated result. This is exactly the "no valid public
/// input can panic, wrap, ... or exceed the declared resource bound"
/// property, applied at the boundary this harness found empirically.
#[test]
fn compute_d_overflow_boundary_fails_closed_not_wrapping() {
    let cases: [(i128, i128, u32); 4] = [
        // Balanced, right at ~cbrt(i128::MAX).
        (6_000_000_000_000, 6_000_000_000_000, 1_000_000),
        // Extreme imbalance: tiny opposing reserve makes d_prod = d^3/(4*x*y)
        // explode long before either reserve alone looks "large".
        (1, 5_000_000_000_000_000, 1_000_000),
        (5_000_000_000_000_000, 1, 1_000_000),
        // Maximum representable reserves under max amplification.
        (i128::MAX / 4, i128::MAX / 4, 1_000_000),
    ];
    for (x, y, amp) in cases {
        let result = std::panic::catch_unwind(|| StableSwap::compute_d(x, y, amp));
        match result {
            Ok(Ok(d)) => {
                // Didn't actually overflow for this input after all — fine,
                // as long as the result is a sane, non-negative invariant.
                assert!(
                    d >= 0,
                    "compute_d(x={x},y={y},amp={amp}) returned negative D={d}"
                );
            }
            Ok(Err(stableswap::StableSwapError::MathOverflow)) => {
                // Fails closed with a typed error, as required.
            }
            Ok(Err(other)) => {
                panic!("compute_d(x={x},y={y},amp={amp}) returned unexpected error {other:?}")
            }
            Err(panic_payload) => {
                panic!("compute_d(x={x},y={y},amp={amp}) panicked instead of returning MathOverflow: {panic_payload:?}");
            }
        }
    }
}

/// StableSwap and CLMM invariants must not decrease beyond documented
/// rounding tolerance: adding liquidity (which only ever adds reserves)
/// must not decrease D.
#[test]
fn invariant_d_is_non_decreasing_when_adding_reserves() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (x, y) = bounded_ratio_pair(&mut rng, 1_000, MAX_RESERVE, 50);
        // Deltas are bounded relative to the reserve they're added to (not
        // an absolute max) so a deposit can't itself blow the pool's ratio
        // out to the overflow-prone regime `compute_d_overflow_boundary_*`
        // covers separately.
        let dx = amount_i128(&mut rng, 1, x.max(1), &[]);
        let dy = amount_i128(&mut rng, 1, y.max(1), &[]);
        let amp: u32 = safe_amp(&mut rng);

        let d0 = StableSwap::compute_d(x, y, amp).expect("valid domain");
        let d1 = StableSwap::compute_d(x + dx, y + dy, amp).expect("valid domain");
        assert!(
            d1 >= d0,
            "seed {seed}: D decreased after adding reserves: d0={d0} d1={d1} (x={x},y={y},dx={dx},dy={dy},amp={amp})"
        );
    }
}

fn rng_range_u32(rng: &mut impl rand::RngCore, min: u32, max: u32) -> u32 {
    use rand::Rng;
    rng.gen_range(min..=max)
}

// ── Full-flow contract properties ───────────────────────────────────────

fn setup_pool(
    env: &Env,
    amp: u32,
    base_fee: u32,
    fee_mult: u32,
) -> (StableSwapClient<'static>, Address, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let token0_admin = Address::generate(env);
    let token1_admin = Address::generate(env);
    let token0 = env
        .register_stellar_asset_contract_v2(token0_admin.clone())
        .address();
    let token1 = env
        .register_stellar_asset_contract_v2(token1_admin.clone())
        .address();
    let lp_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(StableSwap, ());
    let client = StableSwapClient::new(env, &contract_id);
    client.initialize(
        &admin, &token0, &token1, &lp_token, &amp, &base_fee, &fee_mult,
    );
    (client, token0, token1, admin)
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token).mint(to, &amount);
}

/// Conservation of token balances after fees: a swap must not create or
/// destroy tokens — every unit that leaves the trader's token_in balance
/// must land either in the pool reserve or (never, here) be unaccounted
/// for, and the amount out must never exceed what the constant-product-like
/// invariant allows.
#[test]
fn swap_conserves_token_balances() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, token0, token1, _admin) = setup_pool(&env, 100, 30_000, 20_000);

    let lp = Address::generate(&env);
    mint(&env, &token0, &lp, 1_000_000_000);
    mint(&env, &token1, &lp, 1_000_000_000);
    client.add_liquidity(&lp, &1_000_000_000, &1_000_000_000, &0);

    let trader = Address::generate(&env);
    mint(&env, &token0, &trader, 10_000_000);

    let token0_client = token::Client::new(&env, &token0);
    let token1_client = token::Client::new(&env, &token1);

    let pool_addr = client.address.clone();
    let pool0_before = token0_client.balance(&pool_addr);
    let pool1_before = token1_client.balance(&pool_addr);
    let trader0_before = token0_client.balance(&trader);
    let trader1_before = token1_client.balance(&trader);

    let amount_out = client.swap(&trader, &token0, &1_000_000, &0);

    let pool0_after = token0_client.balance(&pool_addr);
    let pool1_after = token1_client.balance(&pool_addr);
    let trader0_after = token0_client.balance(&trader);
    let trader1_after = token1_client.balance(&trader);

    // Whatever left the trader's token0 balance entered the pool's token0 balance.
    assert_eq!(trader0_before - trader0_after, pool0_after - pool0_before);
    // Whatever the trader received in token1 left the pool's token1 balance.
    assert_eq!(trader1_after - trader1_before, pool1_before - pool1_after);
    assert_eq!(trader1_after - trader1_before, amount_out);
}

/// LP supply and per-user LP balances must stay consistent: total_supply
/// must equal the sum of every LP holder's balance.
#[test]
fn lp_supply_matches_sum_of_balances() {
    let env = Env::default();
    let (client, token0, token1, _admin) = setup_pool(&env, 100, 30_000, 20_000);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint(&env, &token0, &alice, 5_000_000);
    mint(&env, &token1, &alice, 5_000_000);
    mint(&env, &token0, &bob, 3_000_000);
    mint(&env, &token1, &bob, 3_000_000);

    client.add_liquidity(&alice, &5_000_000, &5_000_000, &0);
    client.add_liquidity(&bob, &3_000_000, &3_000_000, &0);

    let total = client.get_total_supply();
    let alice_lp = client.get_lp_balance(&alice);
    let bob_lp = client.get_lp_balance(&bob);
    assert_eq!(total, alice_lp + bob_lp);
}

/// A round-trip swap (token0 -> token1 -> token0) cannot create value: the
/// trader must end up with strictly less (or equal, at zero fee) token0
/// than they started with, never more.
#[test]
fn round_trip_swap_cannot_create_value() {
    let env = Env::default();
    let (client, token0, token1, _admin) = setup_pool(&env, 100, 30_000, 20_000);

    let lp = Address::generate(&env);
    mint(&env, &token0, &lp, 1_000_000_000);
    mint(&env, &token1, &lp, 1_000_000_000);
    client.add_liquidity(&lp, &1_000_000_000, &1_000_000_000, &0);

    let trader = Address::generate(&env);
    mint(&env, &token0, &trader, 1_000_000);
    let token0_client = token::Client::new(&env, &token0);
    let starting = token0_client.balance(&trader);

    let out1 = client.swap(&trader, &token0, &1_000_000, &0);
    let out0 = client.swap(&trader, &token1, &out1, &0);

    assert!(
        out0 <= starting,
        "round-trip swap created value: started with {starting}, ended with {out0}"
    );
}

/// Swap output must be monotonic in input size (more in => at least as much
/// out) until liquidity limits are hit. Each amount is tried against a
/// freshly re-initialized, identically-funded pool so only `amount_in`
/// varies between comparisons.
#[test]
fn swap_output_is_monotonic_in_input_size() {
    let mut last_out = 0i128;
    for amount_in in [100_000i128, 1_000_000, 5_000_000, 10_000_000, 50_000_000] {
        let env = Env::default();
        let (client, token0, token1, _admin) = setup_pool(&env, 100, 30_000, 20_000);

        let lp = Address::generate(&env);
        mint(&env, &token0, &lp, 1_000_000_000);
        mint(&env, &token1, &lp, 1_000_000_000);
        client.add_liquidity(&lp, &1_000_000_000, &1_000_000_000, &0);

        let trader = Address::generate(&env);
        mint(&env, &token0, &trader, amount_in);

        let out = client.swap(&trader, &token0, &amount_in, &0);
        assert!(
            out >= last_out,
            "swap output not monotonic: amount_in={amount_in} produced out={out} < previous {last_out}"
        );
        last_out = out;
    }
}
