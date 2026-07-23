//! Independent CLMM reference model.
//!
//! `contracts/clmm_core/src/math.rs` documents its own tick<->price
//! conversion as a "simplified approximation... for production, use full
//! Uniswap V3 math or lookup tables" — a *linear* function of tick, not the
//! true geometric `1.0001^tick` curve. This model computes the true curve
//! (via `f64`, ~15-17 significant decimal digits — see note on
//! [`true_sqrt_price_x96`] for why arbitrary-precision rationals aren't used
//! here) so the differential tests can measure and bound how far the linear
//! approximation drifts, rather than assert near-equality with it.
//!
//! For the amount/liquidity and swap-step formulas (which are *not*
//! approximations of a different curve, just integer arithmetic that
//! production does with truncating division), this model recomputes the
//! same textbook Uniswap V3 formulas exactly in `BigRational`, giving a
//! tight rounding-only differential check independent of the tick-price
//! approximation above.

use num_bigint::BigInt;
use num_rational::BigRational;

use crate::bigmath::{int, uint};

pub const Q96_F64: f64 = 79_228_162_514_264_337_593_543_950_336.0; // 2^96

/// True price (not sqrt) at a tick, via the real geometric formula.
/// `f64` gives ~15-17 significant decimal digits, which is already far more
/// precise than production's linear approximation is trying to be — the
/// exponent `tick` can be up to ~887,272 in magnitude, and computing
/// `1.0001^tick` as an *exact* rational would produce numerators/denominators
/// with hundreds of thousands of decimal digits, which is not tractable to
/// compute per test case at the volumes this harness runs. `f64` is the
/// standard, appropriate precision for a transcendental exponential of this
/// kind (the same choice real Uniswap-math test suites make).
pub fn true_price(tick: i32) -> f64 {
    1.0001_f64.powi(tick)
}

/// True `sqrt(price) * 2^96`, as a `u128` when representable.
///
/// Note: this contract's `sqrt_price_x96` is a `u128` (Q64.96 packed into
/// 128 bits), whereas real Uniswap V3 uses a 160-bit `sqrt_price_x96` to
/// cover its full `[MIN_TICK, MAX_TICK]` range. `MIN_TICK`/`MAX_TICK` here
/// (±887,272) were carried over from Uniswap V3 but do not actually fit in
/// `u128` at the extremes — this model reports `None` when the true value
/// overflows `u128` rather than silently truncating, which is itself a
/// documented finding (see docs/differential-verification.md) about the
/// representable tick range, not a bug in this reference model.
pub fn true_sqrt_price_x96(tick: i32) -> Option<u128> {
    let price = true_price(tick);
    let scaled = price.sqrt() * Q96_F64;
    if !scaled.is_finite() || scaled < 0.0 || scaled >= u128::MAX as f64 {
        return None;
    }
    Some(scaled as u128)
}

/// Inverse of [`true_sqrt_price_x96`]: true tick for a given `sqrt_price_x96`.
pub fn true_tick_at_sqrt_price(sqrt_price_x96: u128) -> i32 {
    let sqrt_price = sqrt_price_x96 as f64 / Q96_F64;
    let price = sqrt_price * sqrt_price;
    (price.ln() / 1.0001_f64.ln()).floor() as i32
}

fn big_u128(v: u128) -> BigInt {
    BigInt::from(v)
}

/// Exact (no truncation) recomputation of production's `amount0` formula:
/// `liquidity * (1/sqrt_lower - 1/sqrt_upper) * Q96`, i.e.
/// `liquidity*Q96/sqrt_lower - liquidity*Q96/sqrt_upper`.
pub fn amount0_for_liquidity_exact(
    sqrt_lower: u128,
    sqrt_upper: u128,
    liquidity: u128,
) -> BigRational {
    let (lo, hi) = if sqrt_lower <= sqrt_upper {
        (sqrt_lower, sqrt_upper)
    } else {
        (sqrt_upper, sqrt_lower)
    };
    if lo == 0 {
        return BigRational::from_integer(BigInt::from(0));
    }
    let l = uint(liquidity);
    let q96 = BigRational::from_integer(BigInt::from(1u8) << 96);
    let term_lo = &l * &q96 / BigRational::from_integer(big_u128(lo));
    let term_hi = &l * &q96 / BigRational::from_integer(big_u128(hi));
    term_lo - term_hi
}

/// Exact recomputation of production's `amount1` formula:
/// `liquidity * (sqrt_upper - sqrt_lower) / Q96`.
pub fn amount1_for_liquidity_exact(
    sqrt_lower: u128,
    sqrt_upper: u128,
    liquidity: u128,
) -> BigRational {
    let (lo, hi) = if sqrt_lower <= sqrt_upper {
        (sqrt_lower, sqrt_upper)
    } else {
        (sqrt_upper, sqrt_lower)
    };
    let l = uint(liquidity);
    let q96 = BigRational::from_integer(BigInt::from(1u8) << 96);
    let delta = BigRational::from_integer(big_u128(hi) - big_u128(lo));
    l * delta / q96
}

pub struct SwapStepExact {
    pub sqrt_price_next: BigRational,
    pub amount_in: BigRational,
    pub amount_out: BigRational,
    pub fee_amount: BigRational,
}

/// Exact recomputation of production's (documented-as-simplified)
/// `compute_swap_step`, without the integer truncation at each division.
pub fn compute_swap_step_exact(
    sqrt_price_current: u128,
    sqrt_price_target: u128,
    liquidity: u128,
    amount_remaining: i128,
    fee_bps: u32,
) -> SwapStepExact {
    let q96 = BigRational::from_integer(BigInt::from(1u8) << 96);
    let zero_for_one = sqrt_price_current >= sqrt_price_target;
    let amount_remaining_abs = uint(amount_remaining.unsigned_abs());
    let fee_amount = &amount_remaining_abs * int(fee_bps as i128) / int(10_000);
    let amount_after_fee = &amount_remaining_abs - &fee_amount;
    let liquidity_r = uint(liquidity).max(int(1));
    let price_delta = &amount_after_fee * &q96 / &liquidity_r;

    let current = BigRational::from_integer(big_u128(sqrt_price_current));
    let target = BigRational::from_integer(big_u128(sqrt_price_target));
    let mut sqrt_price_next = if zero_for_one {
        (&current - &price_delta).max(BigRational::from_integer(BigInt::from(0)))
    } else {
        &current + &price_delta
    };
    sqrt_price_next = if zero_for_one {
        sqrt_price_next.max(target.clone())
    } else {
        sqrt_price_next.min(target)
    };

    let amount_out = &liquidity_r * &price_delta / &q96;

    SwapStepExact {
        sqrt_price_next,
        amount_in: amount_after_fee,
        amount_out,
        fee_amount,
    }
}
