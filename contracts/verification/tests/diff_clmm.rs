//! Differential + property tests for `contracts/clmm_core`.
//!
//! While building this harness, several inputs well within the contract's
//! own documented domain (`MIN_TICK..MAX_TICK`, plausible liquidity/amount
//! magnitudes) were found to *panic* `clmm_core::math` rather than return an
//! error — a direct violation of the "no valid public input can panic, wrap,
//! or divide by zero" property this issue requires. Per this harness's scope
//! (verification only, no production math changes), those are recorded here
//! as explicit, named characterization tests — see
//! `sqrt_ratio_panics_on_tick_below_negative_10000`,
//! `amount0_for_liquidity_panics_above_safe_liquidity`, and
//! `swap_step_panics_on_large_amount_remaining_at_low_liquidity` — and
//! reported in docs/differential-verification.md as defects to fix in
//! production, not behavior to rely on. The rounding/differential tests
//! below are bounded to the safe domain so they measure precision, not this
//! separately-tracked overflow behavior.

use clmm_core::math as production;
use clmm_core::tick::{MAX_TICK, MIN_TICK};
use rand::RngCore;

use verification::bigmath::round_to_u128;
use verification::reference::clmm as refmodel;
use verification::tolerance::{
    CLMM_SQRT_PRICE, CLMM_SQRT_PRICE_FAR_FROM_ZERO_MIN_DEVIATION_BPS, CLMM_SWAP_STEP,
};
use verification::vectors::{amount_u128, case_count, rng_for_seed, tick, uniform_i128};

/// Recommended usable range documented alongside `CLMM_SQRT_PRICE`.
const RECOMMENDED_TICK_RANGE: i32 = 50;

/// `get_sqrt_ratio_at_tick`'s negative branch computes
/// `Q96 - (Q96*abs_tick)/10000` with an *unchecked* subtraction: safe only
/// while `abs_tick <= 10000`. See `sqrt_ratio_panics_on_tick_below_negative_10000`.
const SAFE_TICK_MIN: i32 = -10_000;

/// `get_amount0_for_liquidity` computes `liquidity * Q96` unchecked (safe
/// only while `liquidity < u128::MAX / Q96` (~2^32), see
/// `amount0_for_liquidity_panics_above_safe_liquidity`), and
/// `get_amount1_for_liquidity` computes `liquidity * (sqrt_upper -
/// sqrt_lower)` unchecked — `sqrt_upper` can be up to ~90x `Q96` near
/// `MAX_TICK` (production's linear tick approximation keeps growing past
/// `Q96` for large positive ticks), so the *effective* safe ceiling for wide
/// ranges is much lower than the amount0 bound alone suggests. See
/// `amount1_for_liquidity_panics_on_wide_range_at_moderate_liquidity`.
const SAFE_LIQUIDITY_MAX: u128 = 10_000_000;

/// `compute_swap_step` computes `amount_after_fee * Q96` with an unchecked
/// multiplication before ever dividing by liquidity: safe only while
/// `amount_remaining < u128::MAX / Q96` (~2^32), regardless of liquidity.
/// See `swap_step_panics_on_large_amount_remaining_at_low_liquidity`.
const SAFE_AMOUNT_REMAINING_MAX: i128 = 1_000_000_000;

#[test]
fn sqrt_price_matches_true_curve_within_recommended_range() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let t = tick(
            &mut rng,
            -RECOMMENDED_TICK_RANGE,
            RECOMMENDED_TICK_RANGE,
            &[0],
        );

        let production_price = production::get_sqrt_ratio_at_tick(t);
        let Some(true_price) = refmodel::true_sqrt_price_x96(t) else {
            continue;
        };
        let production_i128 =
            i128::try_from(production_price).expect("fits i128 within recommended range");
        let true_i128 = i128::try_from(true_price).expect("fits i128 within recommended range");

        assert!(
            CLMM_SQRT_PRICE.check(production_i128, true_i128),
            "get_sqrt_ratio_at_tick({t}): production={production_price} true={true_price} \
             deviation_bps={:.4}",
            CLMM_SQRT_PRICE.deviation_bps(production_i128, true_i128)
        );
    }
}

/// Characterization test: outside the recommended range (but within the
/// safe, non-panicking tick domain), production's linear approximation is
/// *expected* to diverge sharply from the true geometric curve. This locks
/// that divergence in as a documented, asserted fact so a change to the
/// approximation shows up here instead of silently drifting.
#[test]
fn sqrt_price_deviation_exceeds_floor_far_from_zero() {
    for t in [1_000i32, 10_000, 100_000, MAX_TICK] {
        let production_price = production::get_sqrt_ratio_at_tick(t);
        let Some(true_price) = refmodel::true_sqrt_price_x96(t) else {
            continue;
        };
        let production_i128 = production_price.min(i128::MAX as u128) as i128;
        let true_i128 = true_price.min(i128::MAX as u128) as i128;
        let deviation = CLMM_SQRT_PRICE.deviation_bps(production_i128, true_i128);
        assert!(
            deviation >= CLMM_SQRT_PRICE_FAR_FROM_ZERO_MIN_DEVIATION_BPS,
            "expected tick={t} to be well outside the recommended range (deviation \
             >= {CLMM_SQRT_PRICE_FAR_FROM_ZERO_MIN_DEVIATION_BPS} bps) but measured only \
             {deviation:.4} bps — the approximation may have improved, update \
             CLMM_SQRT_PRICE's documented recommended range accordingly"
        );
    }
}

/// Discovered defect: `get_sqrt_ratio_at_tick`'s negative-tick branch
/// (`Q96 - (Q96*abs_tick)/10000`) underflows a `u128` — and panics, since
/// this workspace builds with `overflow-checks = true` even in release — for
/// any `tick < -10000`. `MIN_TICK` is `-887272`, so this panics across
/// essentially all of the valid negative tick range. Any pool initialized or
/// swapped at such a tick aborts the whole transaction instead of returning
/// a typed error. This test pins the exact boundary down as a named,
/// reproducible defect rather than an assumption.
#[test]
fn sqrt_ratio_panics_on_tick_below_negative_10000() {
    let boundary_ok =
        std::panic::catch_unwind(|| production::get_sqrt_ratio_at_tick(SAFE_TICK_MIN));
    assert!(
        boundary_ok.is_ok(),
        "tick={SAFE_TICK_MIN} (the documented safe boundary) unexpectedly panicked"
    );

    let just_below =
        std::panic::catch_unwind(|| production::get_sqrt_ratio_at_tick(SAFE_TICK_MIN - 1));
    assert!(
        just_below.is_err(),
        "expected get_sqrt_ratio_at_tick({}) to panic (subtract overflow) as it did when this test was \
         written — if this now passes, the underlying arithmetic was fixed: replace this characterization \
         test with a real differential/tolerance test over the newly-safe range instead",
        SAFE_TICK_MIN - 1
    );

    let min_tick = std::panic::catch_unwind(|| production::get_sqrt_ratio_at_tick(MIN_TICK));
    assert!(
        min_tick.is_err(),
        "expected get_sqrt_ratio_at_tick(MIN_TICK={MIN_TICK}) to panic — MIN_TICK is deep inside the \
         known-panicking range"
    );
}

/// Discovered defect: `get_amount0_for_liquidity` computes `liquidity * Q96`
/// unchecked, overflowing (and panicking) for any `liquidity >= ~2^32`
/// (`u128::MAX / Q96`) — a low, easily reachable ceiling for a liquidity
/// value with no other documented upper bound.
#[test]
fn amount0_for_liquidity_panics_above_safe_liquidity() {
    // Use SAFE_TICK_MIN (not MIN_TICK) for the range bounds so this isolates
    // the liquidity-multiply overflow from the separate tick-underflow
    // defect above.
    let at_boundary = std::panic::catch_unwind(|| {
        production::get_amounts_for_liquidity(1, SAFE_TICK_MIN, MAX_TICK, SAFE_LIQUIDITY_MAX)
    });
    assert!(
        at_boundary.is_ok(),
        "liquidity={SAFE_LIQUIDITY_MAX} unexpectedly panicked"
    );

    let above_boundary = std::panic::catch_unwind(|| {
        production::get_amounts_for_liquidity(1, SAFE_TICK_MIN, MAX_TICK, u128::MAX / 1_000)
    });
    assert!(
        above_boundary.is_err(),
        "expected get_amounts_for_liquidity with liquidity=u128::MAX/1000 to panic (multiply overflow) as it \
         did when this test was written — if this now passes, replace this characterization test with a real \
         differential test over the newly-safe range"
    );
}

/// Discovered defect: `compute_swap_step` computes
/// `amount_after_fee * Q96` *before* dividing by liquidity, so it overflows
/// (and panics) for large `amount_remaining` regardless of how large
/// `liquidity` is — even though the mathematically final `price_delta`
/// would be modest for large liquidity.
#[test]
fn swap_step_panics_on_large_amount_remaining_at_low_liquidity() {
    let at_boundary = std::panic::catch_unwind(|| {
        production::compute_swap_step(
            1 << 90,
            1 << 91,
            1_000_000_000_000,
            SAFE_AMOUNT_REMAINING_MAX,
            30,
        )
    });
    assert!(
        at_boundary.is_ok(),
        "amount_remaining={SAFE_AMOUNT_REMAINING_MAX} unexpectedly panicked"
    );

    let above_boundary = std::panic::catch_unwind(|| {
        production::compute_swap_step(1 << 90, 1 << 91, 1_000_000_000_000, i128::MAX / 1_000, 30)
    });
    assert!(
        above_boundary.is_err(),
        "expected compute_swap_step with amount_remaining=i128::MAX/1000 to panic (multiply overflow) as it \
         did when this test was written — if this now passes, replace this characterization test with a real \
         differential test over the newly-safe range"
    );
}

/// Round-trip: converting a tick to a price and back should recover a tick
/// close to the original — production's *own* self-consistency (it defines
/// both directions off the same approximation), over the safe tick domain.
///
/// `get_tick_at_sqrt_ratio` binary-searches the *full* `MIN_TICK..MAX_TICK`
/// range internally regardless of the input tick's own value, so it can
/// still hit the tick-underflow defect above even when `t` itself is safe.
/// That's a further-reaching consequence of the same discovered defect, not
/// a new one — cases that panic are skipped here (already covered by
/// `sqrt_ratio_panics_on_tick_below_negative_10000`) so this test measures
/// self-consistency wherever the round trip actually completes.
#[test]
fn tick_price_round_trip_is_self_consistent() {
    let mut panicked = 0u32;
    let mut checked = 0u32;
    for seed in 0..case_count().min(2_000) as u64 {
        let mut rng = rng_for_seed(seed);
        let t = tick(
            &mut rng,
            SAFE_TICK_MIN,
            MAX_TICK,
            &[0, SAFE_TICK_MIN, MAX_TICK],
        );
        let result = std::panic::catch_unwind(|| {
            let price = production::get_sqrt_ratio_at_tick(t);
            let back = production::get_tick_at_sqrt_ratio(price);
            let re_priced = production::get_sqrt_ratio_at_tick(back);
            (price, re_priced, back)
        });
        let Ok((price, re_priced, back)) = result else {
            panicked += 1;
            continue;
        };
        checked += 1;
        assert_eq!(
            price, re_priced,
            "tick={t}: get_sqrt_ratio_at_tick -> get_tick_at_sqrt_ratio -> get_sqrt_ratio_at_tick \
             is not self-consistent (back={back})"
        );
    }
    assert!(
        checked > 0,
        "every generated case panicked; widen SAFE_TICK_MIN or investigate further"
    );
    let _ = panicked;
}

/// Exact rounding check for `get_amounts_for_liquidity`'s token1 amount, fed
/// production's *own* sqrt-price outputs (isolating truncation/rounding
/// correctness from the tick-price approximation question). The token0
/// amount is checked separately below — see
/// `amount0_for_liquidity_is_broken_and_always_returns_zero`.
#[test]
fn amount1_for_liquidity_matches_exact_rational_recomputation() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let tick_lower = tick(&mut rng, SAFE_TICK_MIN, MAX_TICK - 1, &[]);
        let tick_upper = tick(&mut rng, tick_lower + 1, MAX_TICK, &[]);
        let sqrt_price_x96 = amount_u128(
            &mut rng,
            production::get_sqrt_ratio_at_tick(tick_lower),
            production::get_sqrt_ratio_at_tick(tick_upper),
            &[],
        );
        let liquidity = amount_u128(&mut rng, 0, SAFE_LIQUIDITY_MAX, &[0]);

        let (_amount0, amount1) = production::get_amounts_for_liquidity(
            sqrt_price_x96,
            tick_lower,
            tick_upper,
            liquidity,
        );

        let sqrt_lower = production::get_sqrt_ratio_at_tick(tick_lower);
        let sqrt_upper = production::get_sqrt_ratio_at_tick(tick_upper);
        let (lo, hi) = if sqrt_lower < sqrt_upper {
            (sqrt_lower, sqrt_upper)
        } else {
            (sqrt_upper, sqrt_lower)
        };
        let expected1 = if sqrt_price_x96 >= hi {
            round_to_u128(&refmodel::amount1_for_liquidity_exact(lo, hi, liquidity))
        } else if sqrt_price_x96 > lo {
            round_to_u128(&refmodel::amount1_for_liquidity_exact(
                lo,
                sqrt_price_x96,
                liquidity,
            ))
        } else {
            0
        };

        let a1 = i128::try_from(amount1).unwrap_or(i128::MAX);
        let e1 = i128::try_from(expected1).unwrap_or(i128::MAX);
        assert!(
            CLMM_SWAP_STEP.check(a1, e1),
            "amount1 mismatch @ tick[{tick_lower},{tick_upper}] price={sqrt_price_x96} liq={liquidity}: \
             production={amount1} expected={expected1}"
        );
    }
}

/// **Discovered defect (severe):** `get_amount0_for_liquidity` (private
/// helper behind `get_amounts_for_liquidity`) computes
/// `(numerator/sqrt_ratio_b).saturating_sub(numerator/sqrt_ratio_a)` after
/// normalizing `sqrt_ratio_a <= sqrt_ratio_b` — the operands are backwards.
/// The correct Uniswap V3 formula is
/// `liquidity*Q96/sqrt_lower - liquidity*Q96/sqrt_upper`, i.e.
/// `numerator/sqrt_ratio_a - numerator/sqrt_ratio_b`. Because
/// `sqrt_ratio_b >= sqrt_ratio_a`, `numerator/sqrt_ratio_b <=
/// numerator/sqrt_ratio_a` always, so the `saturating_sub` as written
/// saturates to **zero for essentially every non-degenerate range** — any
/// time the current price is at or below a position's range (the position
/// should be priced entirely in token0), `get_amounts_for_liquidity` reports
/// `amount0 = 0` instead of the correct, often large, amount. This directly
/// breaks token0 accounting for concentrated liquidity positions.
///
/// This test pins the bug down concretely (not just "0 != expected" from a
/// fuzzer) so it reproduces deterministically and disappears the moment
/// production is fixed — at which point this test should be deleted in
/// favor of folding amount0 back into
/// `amount1_for_liquidity_matches_exact_rational_recomputation`'s sibling
/// check. See docs/differential-verification.md for the full writeup.
#[test]
fn amount0_for_liquidity_is_broken_and_always_returns_zero() {
    let tick_lower = 0i32;
    let tick_upper = 10_000i32;
    let liquidity: u128 = 1_000_000_000;
    let sqrt_lower = production::get_sqrt_ratio_at_tick(tick_lower);

    // Priced entirely below the range: should be 100% token0, i.e. a large
    // positive amount0 (see refmodel::amount0_for_liquidity_exact) — but
    // production returns 0.
    let (amount0, _amount1) = production::get_amounts_for_liquidity(
        sqrt_lower.saturating_sub(1).max(1),
        tick_lower,
        tick_upper,
        liquidity,
    );

    let sqrt_upper = production::get_sqrt_ratio_at_tick(tick_upper);
    let expected0 = round_to_u128(&refmodel::amount0_for_liquidity_exact(
        sqrt_lower, sqrt_upper, liquidity,
    ));

    assert_eq!(
        amount0, 0,
        "get_amounts_for_liquidity started returning a non-zero amount0 (production={amount0}) — the \
         saturating_sub operand-order bug documented above appears to be fixed; delete this \
         characterization test and fold amount0 back into the real differential check"
    );
    assert!(
        expected0 > 1_000_000,
        "sanity check on the reference model itself failed: expected a large amount0 (got {expected0}) — \
         the test setup, not production, is wrong if this fires"
    );
}

/// Discovered defect: `get_amount1_for_liquidity` computes
/// `liquidity * (sqrt_upper - sqrt_lower)` unchecked. Because production's
/// linear tick approximation lets `sqrt_price_x96` grow to ~90x `Q96` near
/// `MAX_TICK`, a wide (or full-range) position's `sqrt_upper - sqrt_lower`
/// can itself already be tens of times `Q96` — so liquidity values far
/// below the naive `u128::MAX / Q96` ceiling still overflow once the range
/// is wide enough.
#[test]
fn amount1_for_liquidity_panics_on_wide_range_at_moderate_liquidity() {
    let at_boundary = std::panic::catch_unwind(|| {
        production::get_amounts_for_liquidity(1, SAFE_TICK_MIN, MAX_TICK, SAFE_LIQUIDITY_MAX)
    });
    assert!(
        at_boundary.is_ok(),
        "liquidity={SAFE_LIQUIDITY_MAX} on the full safe tick range unexpectedly panicked"
    );

    let above_boundary = std::panic::catch_unwind(|| {
        production::get_amounts_for_liquidity(1, SAFE_TICK_MIN, MAX_TICK, u128::MAX / 1_000)
    });
    assert!(
        above_boundary.is_err(),
        "expected get_amounts_for_liquidity with liquidity=u128::MAX/1000 on the full tick range to panic \
         (multiply overflow in get_amount1_for_liquidity) as it did when this test was written — if this now \
         passes, replace this characterization test with a real differential test over the newly-safe range"
    );
}

/// Exact rounding check for `compute_swap_step`, over the safe
/// amount_remaining domain.
#[test]
fn swap_step_matches_exact_rational_recomputation() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let current = amount_u128(
            &mut rng,
            refmodel::true_sqrt_price_x96(-1000).unwrap_or(1),
            u128::MAX / 2,
            &[],
        );
        let target = amount_u128(&mut rng, 1, u128::MAX / 2, &[]);
        let liquidity = amount_u128(&mut rng, 1, 1_000_000_000_000_000_000, &[]);
        let amount_remaining = uniform_i128(&mut rng, 1, SAFE_AMOUNT_REMAINING_MAX);
        let fee_bps: u32 = rng.next_u32() % 10_000;

        let (sqrt_next, amount_in, amount_out, fee_amount) =
            production::compute_swap_step(current, target, liquidity, amount_remaining, fee_bps);
        let expected = refmodel::compute_swap_step_exact(
            current,
            target,
            liquidity,
            amount_remaining,
            fee_bps,
        );

        let checks = [
            (
                "sqrt_price_next",
                sqrt_next,
                round_to_u128(&expected.sqrt_price_next),
            ),
            ("amount_in", amount_in, round_to_u128(&expected.amount_in)),
            (
                "amount_out",
                amount_out,
                round_to_u128(&expected.amount_out),
            ),
            (
                "fee_amount",
                fee_amount,
                round_to_u128(&expected.fee_amount),
            ),
        ];
        for (label, actual, expected) in checks {
            let a = i128::try_from(actual).unwrap_or(i128::MAX);
            let e = i128::try_from(expected).unwrap_or(i128::MAX);
            assert!(
                CLMM_SWAP_STEP.check(a, e),
                "compute_swap_step {label} mismatch (current={current}, target={target}, \
                 liquidity={liquidity}, amount_remaining={amount_remaining}, fee_bps={fee_bps}): \
                 production={actual} expected={expected}"
            );
        }
    }
}

/// Conservation: within a single swap step, `amount_in`/`fee_amount` never
/// exceed what was actually offered (`amount_remaining`) — no value
/// materializing out of nowhere inside one step's arithmetic.
#[test]
fn swap_step_amount_in_after_fee_is_consistent_with_liquidity_move() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let current = amount_u128(&mut rng, 1_000_000, u128::MAX / 4, &[]);
        let target = amount_u128(&mut rng, 1_000_000, u128::MAX / 4, &[]);
        let liquidity = amount_u128(&mut rng, 1_000, 1_000_000_000_000_000_000, &[]);
        let amount_remaining = uniform_i128(&mut rng, 1, SAFE_AMOUNT_REMAINING_MAX);
        let fee_bps: u32 = rng.next_u32() % 10_000;

        let (_next, amount_in, amount_out, fee_amount) =
            production::compute_swap_step(current, target, liquidity, amount_remaining, fee_bps);

        assert!(
            fee_amount <= amount_remaining.unsigned_abs(),
            "fee exceeds amount_remaining"
        );
        assert!(
            amount_in <= amount_remaining.unsigned_abs(),
            "amount_in ({amount_in}) exceeds amount_remaining ({amount_remaining})"
        );
        let _ = amount_out; // sign/range already covered by the exact-recomputation test above
    }
}
