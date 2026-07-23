//! Replays every fixture in `contracts/verification/regression/`.
//!
//! Each fixture pins a concrete, previously-discovered counterexample down
//! to its minimal reproducing inputs (see `verification::corpus`). This test
//! loads every fixture, dispatches on its `subsystem`, and re-asserts the
//! documented finding — so a fix that accidentally regresses (or a fix that
//! actually resolves a defect without updating its fixture) is caught
//! immediately rather than silently drifting out of coverage.
//!
//! This is also the harness's answer to "reproduce any failure from only
//! its logged seed and model version": every fixture here *is* exactly
//! that — a subsystem, a model version, and inputs, nothing else needed.

use clmm_core::math as clmm;
use options::math::{black_scholes_call, exp, ONE};
use soroban_sdk::Env;
use stablecoin_manager::math::calculate_cr;
use verification::corpus::{load_all, RegressionFixture};

#[test]
fn every_regression_fixture_still_reproduces() {
    let fixtures = load_all();
    assert!(
        !fixtures.is_empty(),
        "expected at least one regression fixture under contracts/verification/regression/"
    );

    for fixture in &fixtures {
        assert_eq!(
            fixture.model_version,
            verification::MODEL_VERSION,
            "fixture '{}' was recorded against a different model version ({}) than the current one ({}) — \
             re-derive it before trusting a replay mismatch as a real regression",
            fixture.name,
            fixture.model_version,
            verification::MODEL_VERSION
        );
        replay(fixture);
    }
}

fn replay(fixture: &RegressionFixture) {
    match fixture.subsystem.as_str() {
        "clmm_core" => replay_clmm(fixture),
        "options" => replay_options(fixture),
        "stablecoin_manager" => replay_stablecoin(fixture),
        other => panic!(
            "fixture '{}': no replay handler registered for subsystem '{other}'",
            fixture.name
        ),
    }
}

fn replay_clmm(fixture: &RegressionFixture) {
    match fixture.name.as_str() {
        "clmm_amount0_always_zero" => {
            let tick_lower = fixture.inputs["tick_lower"].as_i64().unwrap() as i32;
            let tick_upper = fixture.inputs["tick_upper"].as_i64().unwrap() as i32;
            let liquidity = fixture.inputs["liquidity"].as_u64().unwrap() as u128;
            let sqrt_lower = clmm::get_sqrt_ratio_at_tick(tick_lower);
            let (amount0, _amount1) = clmm::get_amounts_for_liquidity(
                sqrt_lower.saturating_sub(1).max(1),
                tick_lower,
                tick_upper,
                liquidity,
            );
            assert_eq!(
                amount0, 0,
                "fixture '{}' no longer reproduces (amount0={amount0} != 0) — the underlying defect may be \
                 fixed; remove this fixture and fold the case back into the normal differential tests",
                fixture.name
            );
        }
        "clmm_sqrt_ratio_negative_tick_underflow" => {
            let tick = fixture.inputs["tick"].as_i64().unwrap() as i32;
            let result = std::panic::catch_unwind(|| clmm::get_sqrt_ratio_at_tick(tick));
            assert!(
                result.is_err(),
                "fixture '{}' no longer reproduces (tick={tick} did not panic) — the underlying defect may be \
                 fixed; remove this fixture",
                fixture.name
            );
        }
        other => panic!("fixture '{other}': no clmm_core replay case registered"),
    }
}

fn replay_options(fixture: &RegressionFixture) {
    match fixture.name.as_str() {
        "options_exp_wrong_signed" => {
            let x = fixture.inputs["x_scaled"].as_i64().unwrap() as i128;
            let result = exp(x);
            assert!(
                result < 0,
                "fixture '{}' no longer reproduces (exp({x})={result} is no longer negative) — exp()'s Taylor \
                 series may have been fixed with proper range reduction; remove this fixture",
                fixture.name
            );
        }
        "options_premium_exceeds_spot" => {
            let spot = fixture.inputs["spot"].as_i64().unwrap() as i128;
            let strike = fixture.inputs["strike"].as_i64().unwrap() as i128;
            let t = fixture.inputs["t"].as_i64().unwrap() as i128;
            let iv = fixture.inputs["iv"].as_i64().unwrap() as i128;
            let env = Env::default();
            let premium = black_scholes_call(&env, spot, strike, t, iv);
            assert!(
                premium > spot,
                "fixture '{}' no longer reproduces (premium={premium} <= spot={spot}) — the bounded-by-spot \
                 property may have been restored; remove this fixture",
                fixture.name
            );
            let _ = ONE;
        }
        other => panic!("fixture '{other}': no options replay case registered"),
    }
}

fn replay_stablecoin(fixture: &RegressionFixture) {
    match fixture.name.as_str() {
        "stablecoin_cr_wraps_silently" => {
            let collateral_value = fixture.inputs["collateral_value"].as_i64().unwrap() as i128;
            let debt_value = fixture.inputs["debt_value"].as_i64().unwrap() as i128;
            let true_ratio_bps = (collateral_value * 10_000) / debt_value;
            let production = calculate_cr(collateral_value, debt_value);
            assert_ne!(
                production as i128, true_ratio_bps,
                "fixture '{}' no longer reproduces (calculate_cr returned the true unwrapped ratio) — the u32 \
                 cast may have been replaced with a saturating conversion; remove this fixture",
                fixture.name
            );
        }
        other => panic!("fixture '{other}': no stablecoin_manager replay case registered"),
    }
}
