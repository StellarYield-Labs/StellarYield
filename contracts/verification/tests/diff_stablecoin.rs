//! Differential + property tests for `contracts/stablecoin_manager`.
//!
//! Two defects found while building this harness:
//! `calculate_index`/`calculate_debt`/`calculate_collateral_value` multiply
//! unchecked before dividing, overflowing for combinations of index growth,
//! rate, elapsed time, and amount that are individually plausible (see
//! `calculate_index_panics_on_large_rate_elapsed_and_index_combo`). Worse:
//! `calculate_cr` casts its result to `u32` with `as u32`, which *silently
//! wraps* instead of panicking or erroring when the true ratio exceeds
//! `u32::MAX` bps (~429,496,729%) — a real "no valid input wraps" violation
//! caught by a monotonicity check, not a panic (see
//! `calculate_cr_silently_wraps_instead_of_saturating`). The general tests
//! below use bounds picked to stay under these overflow/wrap thresholds.

use stablecoin_manager::math::{
    calculate_collateral_value, calculate_cr, calculate_debt, calculate_index,
};

use verification::bigmath::round_to_i128;
use verification::reference::stablecoin as refmodel;
use verification::tolerance::{STABLECOIN_CR, STABLECOIN_INDEX};
use verification::vectors::{amount_i128, case_count, rng_for_seed};

const SCALAR_18: i128 = 1_000_000_000_000_000_000;
const MAX_INDEX: i128 = 10 * SCALAR_18; // 10x cumulative growth
const MAX_RATE: i128 = SCALAR_18 / 5; // up to 20% APR
const MAX_ELAPSED: u64 = 365 * 24 * 60 * 60; // 1 year
const MAX_AMOUNT: i128 = 10_000_000_000; // 1e10 raw units
const MAX_PRICE_USD: i128 = 100_000_000_000; // $10,000 at 1e7 scale

#[test]
fn calculate_index_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let index_last = amount_i128(&mut rng, 1, MAX_INDEX, &[SCALAR_18]);
        let rate = amount_i128(&mut rng, 0, MAX_RATE, &[0]);
        let elapsed = verification::vectors::uniform_u128(&mut rng, 0, MAX_ELAPSED as u128) as u64;

        let production = calculate_index(index_last, rate, elapsed);
        let expected = round_to_i128(&refmodel::calculate_index(index_last, rate, elapsed));

        assert!(
            STABLECOIN_INDEX.check(production, expected),
            "calculate_index(index_last={index_last}, rate={rate}, elapsed={elapsed}): production={production} \
             expected={expected} deviation_bps={:.4}",
            STABLECOIN_INDEX.deviation_bps(production, expected)
        );
        assert!(
            production >= index_last,
            "index decreased: index_last={index_last} -> {production} (rate={rate}, elapsed={elapsed}), \
             rate is non-negative so the index must never decrease"
        );
    }
}

#[test]
fn calculate_debt_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let debt_shares = amount_i128(&mut rng, 0, MAX_AMOUNT, &[0]);
        let index = amount_i128(&mut rng, 1, MAX_INDEX, &[SCALAR_18]);

        let production = calculate_debt(debt_shares, index);
        let expected = round_to_i128(&refmodel::calculate_debt(debt_shares, index));

        assert!(
            STABLECOIN_INDEX.check(production, expected),
            "calculate_debt(debt_shares={debt_shares}, index={index}): production={production} \
             expected={expected}"
        );
        assert!(
            production >= 0,
            "calculate_debt returned negative debt: {production}"
        );
    }
}

#[test]
fn calculate_collateral_value_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let vault_shares = amount_i128(&mut rng, 1, MAX_AMOUNT, &[]);
        let collateral = amount_i128(&mut rng, 0, vault_shares, &[0, vault_shares]);
        let vault_assets = amount_i128(&mut rng, 0, MAX_AMOUNT, &[]);
        let price_usd = amount_i128(&mut rng, 0, MAX_PRICE_USD, &[]);

        let production =
            calculate_collateral_value(collateral, vault_assets, vault_shares, price_usd);
        let expected = round_to_i128(&refmodel::calculate_collateral_value(
            collateral,
            vault_assets,
            vault_shares,
            price_usd,
        ));

        assert!(
            STABLECOIN_INDEX.check(production, expected),
            "calculate_collateral_value(collateral={collateral}, vault_assets={vault_assets}, \
             vault_shares={vault_shares}, price_usd={price_usd}): production={production} expected={expected}"
        );
    }
}

/// Debt floor for the general CR tests below: `calculate_cr` casts its
/// `collateral_value*10000/debt_value` result to `u32` (see the module doc
/// comment), so debt values far below collateral silently wrap instead of
/// producing a huge-but-correct ratio. This floor keeps the ratio under
/// `u32::MAX` bps; `calculate_cr_silently_wraps_instead_of_saturating`
/// covers what happens below it.
fn safe_debt_floor(collateral_value: i128) -> i128 {
    (collateral_value / 100_000).max(1)
}

#[test]
fn calculate_cr_matches_reference_within_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let collateral_value = amount_i128(&mut rng, 0, MAX_AMOUNT, &[0]);
        let debt_value = amount_i128(
            &mut rng,
            safe_debt_floor(collateral_value),
            MAX_AMOUNT,
            &[0],
        );

        let production = calculate_cr(collateral_value, debt_value) as i128;
        let expected = round_to_i128(&refmodel::calculate_cr(collateral_value, debt_value))
            .min(u32::MAX as i128);

        assert!(
            STABLECOIN_CR.check(production, expected),
            "calculate_cr(collateral_value={collateral_value}, debt_value={debt_value}): production={production} \
             expected={expected}"
        );
    }
}

/// Collateralization ratio must be non-decreasing in collateral value
/// (holding debt fixed) — more collateral never makes a position riskier.
#[test]
fn cr_is_monotonic_non_decreasing_in_collateral() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let collateral_lo = amount_i128(&mut rng, 0, MAX_AMOUNT / 2, &[]);
        let collateral_hi = collateral_lo + amount_i128(&mut rng, 0, MAX_AMOUNT / 2, &[]);
        let debt_value = amount_i128(&mut rng, safe_debt_floor(collateral_hi), MAX_AMOUNT, &[]);

        let cr_lo = calculate_cr(collateral_lo, debt_value);
        let cr_hi = calculate_cr(collateral_hi, debt_value);
        assert!(
            cr_hi >= cr_lo,
            "CR decreased as collateral increased: collateral {collateral_lo}->{collateral_hi} gave CR \
             {cr_lo}->{cr_hi} (debt_value={debt_value})"
        );
    }
}

/// Collateralization ratio must be non-increasing in debt value (holding
/// collateral fixed) — more debt never makes a position safer.
#[test]
fn cr_is_monotonic_non_increasing_in_debt() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let collateral_value = amount_i128(&mut rng, 1, MAX_AMOUNT, &[]);
        let debt_lo = amount_i128(
            &mut rng,
            safe_debt_floor(collateral_value),
            MAX_AMOUNT / 2,
            &[],
        );
        let debt_hi = debt_lo + amount_i128(&mut rng, 0, MAX_AMOUNT / 2, &[]);

        let cr_lo = calculate_cr(collateral_value, debt_lo);
        let cr_hi = calculate_cr(collateral_value, debt_hi);
        assert!(
            cr_hi <= cr_lo,
            "CR increased as debt increased: debt {debt_lo}->{debt_hi} gave CR {cr_lo}->{cr_hi} \
             (collateral_value={collateral_value})"
        );
    }
}

/// Interest accrual (`calculate_index`) must never make a position's debt
/// solvency assessment jump backwards in time: index is non-decreasing in
/// elapsed time for a non-negative rate, so replaying two accruals in
/// sequence must produce an index >= either individual accrual.
#[test]
fn index_accrual_is_monotonic_in_elapsed_time() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let index_last = amount_i128(&mut rng, 1, MAX_INDEX, &[SCALAR_18]);
        let rate = amount_i128(&mut rng, 0, MAX_RATE, &[]);
        let elapsed_lo =
            verification::vectors::uniform_u128(&mut rng, 0, MAX_ELAPSED as u128 / 2) as u64;
        let elapsed_hi = elapsed_lo
            + verification::vectors::uniform_u128(&mut rng, 0, MAX_ELAPSED as u128 / 2) as u64;

        let index_lo = calculate_index(index_last, rate, elapsed_lo);
        let index_hi = calculate_index(index_last, rate, elapsed_hi);
        assert!(
            index_hi >= index_lo,
            "index decreased as elapsed time increased: elapsed {elapsed_lo}->{elapsed_hi} gave index \
             {index_lo}->{index_hi} (index_last={index_last}, rate={rate})"
        );
    }
}

/// Solvency-shaped property: debt computed from an accrued index is
/// non-decreasing as the index accrues (holding debt_shares fixed) — a
/// borrower's USD debt obligation never shrinks purely from time passing at
/// a non-negative rate.
#[test]
fn debt_is_non_decreasing_as_index_accrues() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let debt_shares = amount_i128(&mut rng, 1, MAX_AMOUNT, &[]);
        let index_last = amount_i128(&mut rng, 1, MAX_INDEX, &[SCALAR_18]);
        let rate = amount_i128(&mut rng, 0, MAX_RATE, &[]);
        let elapsed = verification::vectors::uniform_u128(&mut rng, 0, MAX_ELAPSED as u128) as u64;

        let debt_before = calculate_debt(debt_shares, index_last);
        let accrued_index = calculate_index(index_last, rate, elapsed);
        let debt_after = calculate_debt(debt_shares, accrued_index);

        assert!(
            debt_after >= debt_before,
            "debt decreased after interest accrual: {debt_before}->{debt_after} (debt_shares={debt_shares}, \
             index_last={index_last}, rate={rate}, elapsed={elapsed})"
        );
    }
}

/// Discovered defect: `calculate_index`'s `index_last * elapsed_rate`
/// (`contracts/stablecoin_manager/src/math.rs`) multiplies unchecked. A
/// long-lived market (large `index_last` from years of accrual) combined
/// with a high configured rate over a long unattended elapsed period —
/// individually plausible, not just adversarial extremes — overflows `i128`
/// and panics instead of returning an error.
#[test]
fn calculate_index_panics_on_large_rate_elapsed_and_index_combo() {
    let safe = std::panic::catch_unwind(|| calculate_index(MAX_INDEX, MAX_RATE, MAX_ELAPSED));
    assert!(
        safe.is_ok(),
        "calculate_index at the documented safe bounds unexpectedly panicked"
    );

    let extreme_index = 1_000_000 * SCALAR_18; // a market that has accrued 1,000,000x
    let extreme_rate = 5 * SCALAR_18; // 500% APR (misconfigured, but not type-invalid)
    let extreme_elapsed = 10 * 365 * 24 * 60 * 60u64; // 10 unattended years
    let extreme =
        std::panic::catch_unwind(|| calculate_index(extreme_index, extreme_rate, extreme_elapsed));
    assert!(
        extreme.is_err(),
        "expected calculate_index(index_last={extreme_index}, rate={extreme_rate}, elapsed={extreme_elapsed}) to \
         panic (multiply overflow) as it did when this test was written — if this now returns a value, replace \
         this characterization test with a real differential test over the newly-safe range"
    );
}

/// **Discovered defect (severe):** `calculate_cr` computes
/// `(collateral_value * 10000) / debt_value` as an `i128` and then casts the
/// result `as u32`. An `as` cast from `i128` to `u32` in Rust *truncates
/// silently* (keeps only the low 32 bits) rather than panicking or
/// saturating — so once the true ratio exceeds `u32::MAX` bps
/// (~429,496,729%, i.e. debt far smaller than collateral, which is exactly
/// what a *very healthy* position looks like), `calculate_cr` returns an
/// arbitrary, essentially random-looking small number instead of "very
/// safe." Any code that reads this CR to gate liquidation or borrowing
/// decisions would see a wildly wrong risk signal for what should be the
/// safest positions in the system.
#[test]
fn calculate_cr_silently_wraps_instead_of_saturating() {
    let collateral_value = 1_000_000_000_000i128; // healthy position: large collateral,
    let debt_value = 1i128; // tiny debt (e.g. almost fully repaid)
    let true_ratio_bps = (collateral_value * 10_000) / debt_value; // == 1e16, far beyond u32::MAX
    assert!(
        true_ratio_bps > u32::MAX as i128,
        "test setup sanity check: expected true_ratio_bps > u32::MAX"
    );

    let production = calculate_cr(collateral_value, debt_value);
    assert_ne!(
        production as i128, true_ratio_bps,
        "calculate_cr started returning the true (unwrapped) ratio — the u32 cast may have been replaced with \
         a saturating conversion; replace this characterization test with a real bounded/saturation assertion"
    );
    // Pin the exact wrapped value down so this is a reproducing regression,
    // not just "some wrong value": `10_000_000_000_000_000 as u32` wraps to
    // `1_000_000_000_000_000_000 % 2^32`.
    let expected_wrapped = (true_ratio_bps as u128 % (1u128 << 32)) as u32;
    assert_eq!(
        production, expected_wrapped,
        "calculate_cr's wrapped output changed shape — investigate before assuming this is the same defect"
    );
}
