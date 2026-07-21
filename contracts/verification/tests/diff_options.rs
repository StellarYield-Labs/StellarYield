//! Differential + property tests for `contracts/options`.
//!
//! Several inputs well within the contract's own parameter types were found,
//! while building this harness, to break required properties or panic. Root
//! cause: `exp()`'s 10-term Taylor series, applied directly at the input
//! with no range reduction, is only reliable for arguments up to ~2 in
//! magnitude and is badly *wrong-signed* below about -4
//! (`exp_is_wrong_signed_below_negative_4`). Since `normal_cdf` calls
//! `exp(-1.702*x)` and `ln` bisects against `exp(mid)` as its monotonic
//! comparator, this single defect cascades into: `normal_cdf` diverging in
//! the "valley" between where `exp()` is accurate and where it clamps
//! (`normal_cdf_deviation_grows_in_the_mid_range`); `black_scholes_call`
//! violating the required "bounded by spot" property outside a narrow
//! domain (`premium_can_exceed_spot_at_extreme_iv_and_tenor`); an unclamped
//! multiplication overflow for extreme `d1` (`normal_cdf_panics_on_extreme_d1`);
//! and `strike=0` dividing by zero instead of erroring
//! (`strike_of_zero_panics_instead_of_erroring`, unrelated to `exp()` but
//! found the same way). Per this harness's scope (verification only, no
//! production math changes), these are recorded as named characterization
//! tests and reported in docs/differential-verification.md. The
//! differential/property tests below use a narrow "moderate" domain (see the
//! `MIN_IV`/`MAX_IV`/`MIN_T`/`MAX_T` comment) chosen specifically to keep
//! `d1`/`d2` inside `exp()`'s accurate range, so they measure ordinary
//! approximation error, not these separately-tracked defects.

use options::math::{black_scholes_call, normal_cdf as production_normal_cdf, ONE};
use soroban_sdk::Env;

use verification::reference::options as refmodel;
use verification::tolerance::{OPTIONS_NORMAL_CDF, OPTIONS_PREMIUM};
use verification::vectors::{amount_i128, case_count, rng_for_seed};

// "Moderate" domain, chosen empirically (see `exp_is_wrong_signed_below_negative_4`):
// production's exp() is only reliably accurate for arguments up to ~2 in
// magnitude, and normal_cdf feeds it `-1.702 * d1`. `d1 = (ln(S/K) +
// 0.5*iv^2*T) / (iv*sqrt(T))` — critically, its *denominator* shrinks
// independently of moneyness whenever `iv*sqrt(T)` is small, so a tight
// moneyness ratio alone isn't enough: MIN_IV/MIN_T are raised together so
// `iv*sqrt(T) >= ~0.35` always, keeping `d1` roughly within [-2, 2] even at
// the edges of this domain. This ends up a materially narrower "safe"
// domain (near-the-money, moderate-to-high vol, half-year-plus tenor) than
// a Black-Scholes implementation should have; see the module doc comment
// and docs/differential-verification.md.
const MIN_IV: i128 = ONE / 2; // 50%
const MAX_IV: i128 = ONE; // 100%
const MIN_T: i128 = ONE / 2; // 6 months
const MAX_T: i128 = ONE; // 1 year
const MIN_PRICE: i128 = 1;
const MAX_PRICE: i128 = 1_000_000 * ONE;

fn to_f64(scaled: i128) -> f64 {
    scaled as f64 / ONE as f64
}

fn from_f64(real: f64) -> i128 {
    (real * ONE as f64).round() as i128
}

/// Generates a (spot, strike) pair within `pct`% of each other (e.g.
/// `pct=10` allows up to 10% moneyness either side) — see the domain
/// comment above for why moneyness alone isn't sufficient to keep `d1`
/// small, but it's still one necessary component.
fn near_the_money_pair(rng: &mut impl rand::RngCore, pct: i128) -> (i128, i128) {
    let spot = amount_i128(rng, MIN_PRICE, MAX_PRICE, &[]);
    let band = (spot * pct / 100).max(1);
    let strike_min = (spot - band).max(MIN_PRICE);
    let strike_max = (spot + band).min(MAX_PRICE);
    let strike = amount_i128(rng, strike_min, strike_max, &[spot]);
    (spot, strike)
}

#[test]
fn normal_cdf_matches_high_precision_reference_within_documented_tolerance() {
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        // |x| <= 1: normal_cdf calls exp(-1.702*x), and exp() is only
        // reliably accurate for arguments up to ~2 in magnitude (see
        // `exp_is_wrong_signed_below_negative_4`) — |x|<=1 keeps
        // |1.702*x| <= 1.702, safely inside that.
        let x = amount_i128(&mut rng, -ONE, ONE, &[0]);

        let production = production_normal_cdf(x);
        let expected = from_f64(refmodel::normal_cdf(to_f64(x)));

        assert!(
            OPTIONS_NORMAL_CDF.check(production, expected),
            "normal_cdf({x}): production={production} expected={expected} deviation_bps={:.4}",
            OPTIONS_NORMAL_CDF.deviation_bps(production, expected)
        );
        assert!(
            (0..=ONE).contains(&production),
            "normal_cdf({x}) = {production} is outside [0, ONE]"
        );
    }
}

/// Characterization test: `normal_cdf` clamps its `exp()` call away entirely
/// once `|1.702*x| > 10` (returning exactly 0 or `ONE`), which happens to be
/// fairly accurate since the true CDF is also near 0/1 out there. The
/// genuinely bad region is the "valley" in between — moderate `|x|` (roughly
/// 2-4) where `exp()` is neither clamped nor accurate (see
/// `exp_is_wrong_signed_below_negative_4`). This locks in that mid-range
/// divergence rather than leaving it unmeasured.
#[test]
fn normal_cdf_deviation_grows_in_the_mid_range() {
    let mut max_deviation = 0.0f64;
    for x in [-3 * ONE, -2 * ONE, 2 * ONE, 3 * ONE] {
        let production = production_normal_cdf(x);
        let expected = from_f64(refmodel::normal_cdf(to_f64(x)));
        let deviation = OPTIONS_NORMAL_CDF.deviation_bps(production, expected);
        max_deviation = max_deviation.max(deviation);
    }
    assert!(
        max_deviation >= 500.0,
        "expected mid-range (|x| in [2,3]) deviation to be well outside the moderate-domain tolerance \
         (>= 500 bps) but measured only {max_deviation:.4} bps — the approximation may have improved; update \
         this test and docs/differential-verification.md accordingly"
    );
}

#[test]
fn premium_matches_reference_black_scholes_within_documented_tolerance() {
    let env = Env::default();
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (spot, strike) = near_the_money_pair(&mut rng, 10);
        let t = amount_i128(&mut rng, MIN_T, MAX_T, &[]);
        let iv = amount_i128(&mut rng, MIN_IV, MAX_IV, &[]);

        let production = black_scholes_call(&env, spot, strike, t, iv);
        let expected = from_f64(refmodel::black_scholes_call(
            to_f64(spot),
            to_f64(strike),
            to_f64(t),
            to_f64(iv),
        ));

        assert!(
            OPTIONS_PREMIUM.check(production, expected),
            "black_scholes_call(spot={spot}, strike={strike}, t={t}, iv={iv}): production={production} \
             expected={expected} deviation_bps={:.4}",
            OPTIONS_PREMIUM.deviation_bps(production, expected)
        );
    }
}

/// Expired options (`t <= 0`) use the exact intrinsic-value rule
/// (`max(spot - strike, 0)`) in both production and the reference — not an
/// approximation — so this must match exactly, not just within tolerance.
#[test]
fn expired_option_premium_equals_intrinsic_value_exactly() {
    let env = Env::default();
    for (spot, strike) in [
        (100 * ONE, 90 * ONE),  // ITM
        (90 * ONE, 100 * ONE),  // OTM
        (100 * ONE, 100 * ONE), // ATM
        (0, 0),
        (1, 1),
    ] {
        let production = black_scholes_call(&env, spot, strike, 0, ONE);
        let expected = (spot - strike).max(0);
        assert_eq!(
            production, expected,
            "expired option premium(spot={spot}, strike={strike})"
        );
    }
}

/// Option call premium is non-negative for any input in the moderate domain.
#[test]
fn premium_is_never_negative() {
    let env = Env::default();
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (spot, strike) = near_the_money_pair(&mut rng, 10);
        let t = amount_i128(&mut rng, MIN_T, MAX_T, &[]);
        let iv = amount_i128(&mut rng, MIN_IV, MAX_IV, &[]);
        let premium = black_scholes_call(&env, spot, strike, t, iv);
        assert!(
            premium >= 0,
            "black_scholes_call(spot={spot},strike={strike},t={t},iv={iv}) = {premium} < 0"
        );
    }
}

/// Option call premium is bounded above by spot (a call can never be worth
/// more than the underlying itself) in the moderate domain — see
/// `premium_can_exceed_spot_at_extreme_iv_and_tenor` for where this breaks.
#[test]
fn premium_is_bounded_by_spot() {
    let env = Env::default();
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (spot, strike) = near_the_money_pair(&mut rng, 10);
        let t = amount_i128(&mut rng, MIN_T, MAX_T, &[]);
        let iv = amount_i128(&mut rng, MIN_IV, MAX_IV, &[]);
        let premium = black_scholes_call(&env, spot, strike, t, iv);
        assert!(
            premium <= spot,
            "black_scholes_call(spot={spot},strike={strike},t={t},iv={iv}) = {premium} > spot={spot}"
        );
    }
}

/// Absolute slack for monotonicity comparisons: at this fixed-point scale,
/// a single-unit-of-input change (e.g. `iv` changing by `1` out of `ONE` =
/// 1e9) can legitimately move the output by a few raw units purely from
/// truncating division in a *different* direction than the previous input's
/// truncation happened to land — not a real monotonicity violation. Real
/// violations found while building this harness were many orders of
/// magnitude larger than this.
const MONOTONIC_EPSILON: i128 = ONE / 1_000;

/// Premium must be non-decreasing in spot (holding strike/t/iv fixed), for
/// two spot values that stay near-the-money relative to strike.
#[test]
fn premium_is_monotonic_non_decreasing_in_spot() {
    let env = Env::default();
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let strike = amount_i128(&mut rng, MIN_PRICE, MAX_PRICE, &[]);
        let t = amount_i128(&mut rng, MIN_T, MAX_T, &[]);
        let iv = amount_i128(&mut rng, MIN_IV, MAX_IV, &[]);
        let band = (strike / 10).max(1);
        let spot_lo = amount_i128(&mut rng, (strike - band).max(MIN_PRICE), strike, &[]);
        let spot_hi =
            amount_i128(&mut rng, strike, (strike + band).min(MAX_PRICE), &[]).max(spot_lo);

        let premium_lo = black_scholes_call(&env, spot_lo, strike, t, iv);
        let premium_hi = black_scholes_call(&env, spot_hi, strike, t, iv);
        assert!(
            premium_hi >= premium_lo - MONOTONIC_EPSILON,
            "premium decreased as spot increased: spot {spot_lo}->{spot_hi} gave premium {premium_lo}->{premium_hi} \
             (strike={strike}, t={t}, iv={iv})"
        );
    }
}

/// Premium must be non-increasing in strike (holding spot/t/iv fixed), for
/// two strike values that stay near-the-money relative to spot.
#[test]
fn premium_is_monotonic_non_increasing_in_strike() {
    let env = Env::default();
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let spot = amount_i128(&mut rng, MIN_PRICE, MAX_PRICE, &[]);
        let t = amount_i128(&mut rng, MIN_T, MAX_T, &[]);
        let iv = amount_i128(&mut rng, MIN_IV, MAX_IV, &[]);
        let band = (spot / 10).max(1);
        let strike_lo = amount_i128(&mut rng, (spot - band).max(MIN_PRICE), spot, &[]);
        let strike_hi =
            amount_i128(&mut rng, spot, (spot + band).min(MAX_PRICE), &[]).max(strike_lo);

        let premium_lo = black_scholes_call(&env, spot, strike_lo, t, iv);
        let premium_hi = black_scholes_call(&env, spot, strike_hi, t, iv);
        assert!(
            premium_hi <= premium_lo + MONOTONIC_EPSILON,
            "premium increased as strike increased: strike {strike_lo}->{strike_hi} gave premium \
             {premium_lo}->{premium_hi} (spot={spot}, t={t}, iv={iv})"
        );
    }
}

/// Premium must be non-decreasing in implied volatility (holding
/// spot/strike/t fixed) — higher volatility never makes an option cheaper.
#[test]
fn premium_is_monotonic_non_decreasing_in_volatility() {
    let env = Env::default();
    for seed in 0..case_count() as u64 {
        let mut rng = rng_for_seed(seed);
        let (spot, strike) = near_the_money_pair(&mut rng, 10);
        let t = amount_i128(&mut rng, MIN_T, MAX_T, &[]);
        let iv_lo = amount_i128(&mut rng, MIN_IV, MAX_IV / 2, &[]);
        let iv_hi = iv_lo + amount_i128(&mut rng, 1, MAX_IV / 2, &[]);

        let premium_lo = black_scholes_call(&env, spot, strike, t, iv_lo);
        let premium_hi = black_scholes_call(&env, spot, strike, t, iv_hi);
        assert!(
            premium_hi >= premium_lo - MONOTONIC_EPSILON,
            "premium decreased as volatility increased: iv {iv_lo}->{iv_hi} gave premium \
             {premium_lo}->{premium_hi} (spot={spot}, strike={strike}, t={t})"
        );
    }
}

/// Discovered defect: `black_scholes_call` divides `(spot * ONE) / strike`
/// unchecked — `strike = 0` panics instead of returning an error. Nothing in
/// `contracts/options` validates `strike > 0` before reaching the math
/// layer (`get_premium` passes arguments straight through).
#[test]
fn strike_of_zero_panics_instead_of_erroring() {
    let env = Env::default();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        black_scholes_call(&env, 100 * ONE, 0, ONE, ONE)
    }));
    assert!(
        result.is_err(),
        "expected black_scholes_call with strike=0 to panic (divide by zero) as it did when this test was \
         written — if this now passes (e.g. strike=0 is validated/rejected upstream), replace this \
         characterization test with a real error-path assertion"
    );
}

/// Discovered defect: `normal_cdf`'s `exponent = (-1.702 * x * ONE) / ONE`
/// (`contracts/options/src/math.rs`) multiplies with the raw `*` operator
/// before any range clamp is applied, so a large enough `x` (reachable when
/// `d1` blows up from a tiny `iv*sqrt(t)` denominator in
/// `black_scholes_call`) overflows `i128` and panics instead of clamping
/// first.
#[test]
fn normal_cdf_panics_on_extreme_d1() {
    let safe = std::panic::catch_unwind(|| production_normal_cdf(50 * ONE));
    assert!(safe.is_ok(), "normal_cdf(50*ONE) unexpectedly panicked");

    let extreme = std::panic::catch_unwind(|| production_normal_cdf(i128::MAX / 1_000));
    assert!(
        extreme.is_err(),
        "expected normal_cdf(i128::MAX/1000) to panic (multiply overflow before the range clamp) as it did \
         when this test was written — if this now passes, replace this characterization test with a real \
         differential test over the newly-safe range"
    );
}

/// Discovered defect: outside the moderate domain (very low `iv`/`t`, which
/// blows up `d1`/`d2`, combined with `exp()`'s 10-term Taylor series losing
/// accuracy near its own `[-10*ONE, 10*ONE]` clamp), `black_scholes_call`
/// can return a premium *larger than spot* — an arbitrage-violating,
/// unsound result, and a direct violation of the required "bounded by spot"
/// property. Recorded here as a concrete, reproducing example (found while
/// building this harness) rather than left as an unmeasured assumption.
#[test]
fn premium_can_exceed_spot_at_extreme_iv_and_tenor() {
    let env = Env::default();
    let spot = 611_088_150_089_906_703i128;
    let strike = 804_925_125_670_209_319i128;
    let t = 6_606_289_893i128;
    let iv = 1_742_719_244i128;
    let premium = black_scholes_call(&env, spot, strike, t, iv);
    assert!(
        premium > spot,
        "expected this recorded example to reproduce premium > spot (production={premium}, spot={spot}) — \
         if this now holds, the underlying exp()/normal_cdf accuracy issue may have been fixed; replace this \
         characterization test with a real bounded-domain assertion"
    );
}

/// **Discovered defect (root cause, severe):** `exp()`'s 10-term Taylor
/// series, evaluated directly at the input (no range reduction), diverges
/// badly for negative inputs below about -4 — badly enough to flip sign.
/// Measured while building this harness: `exp(-4) ~= -0.19` (true
/// `e^-4 ~= 0.0183`), `exp(-10) ~= -1413` (true `e^-10 ~= 0.0000454`). Since
/// `normal_cdf` calls `exp(-1.702 * x)` and `ln` bisects against `exp(mid)`
/// as its monotonic comparator over the full `[-10*ONE, 10*ONE]` range, this
/// single root cause is what drives most of this module's other findings
/// (`normal_cdf_deviation_grows_deep_in_the_tails`,
/// `premium_can_exceed_spot_at_extreme_iv_and_tenor`, and the generally
/// narrow "moderate domain" the differential tests above are restricted
/// to). A correct fixed-point `exp` needs range reduction (e.g.
/// `e^x = (e^(x/2^k))^(2^k)` for some small `x/2^k`) rather than a
/// fixed-length series applied directly at the full input magnitude.
#[test]
fn exp_is_wrong_signed_below_negative_4() {
    use options::math::{exp, ONE};
    let accurate = exp(-2 * ONE);
    let true_e_neg2 = 135_335_283i128; // e^-2 * ONE, ~0.135335283
    assert!(
        (accurate - true_e_neg2).abs() < ONE / 100,
        "exp(-2*ONE)={accurate} expected to be close to true e^-2 ({true_e_neg2}) — if this now fails because \
         exp() got even less accurate, that's consistent with (not contradicting) this finding"
    );

    let broken = exp(-4 * ONE);
    assert!(
        broken < 0,
        "expected exp(-4*ONE) to be negative (wrong-signed) as it was when this test was written \
         (got {broken}) — if this now holds correctly, exp()'s Taylor series was likely fixed with proper \
         range reduction; replace this characterization test and widen the differential tests' domain \
         accordingly"
    );
}
