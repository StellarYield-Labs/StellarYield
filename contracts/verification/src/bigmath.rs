//! Shared arbitrary-precision helpers for the reference models.
//!
//! These operate on `BigRational`/`BigInt`, a different numeric domain than
//! any production contract's fixed-point `i128`/`u128` math — there is no
//! shared helper code between production and reference here.

use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{One, Signed, Zero};

use crate::Convergence;

pub fn int(v: i128) -> BigRational {
    BigRational::from_integer(BigInt::from(v))
}

pub fn uint(v: u128) -> BigRational {
    BigRational::from_integer(BigInt::from(v))
}

pub fn two() -> BigRational {
    int(2)
}

/// Arbitrary-precision square root of a non-negative rational, accurate to
/// `precision_bits` bits of the result's magnitude. Implemented via
/// `BigInt::sqrt` (integer Newton's method) on a rescaled numerator — an
/// independent construction from the fixed-point `isqrt` used in
/// `contracts/clmm_core` / `contracts/options`.
pub fn sqrt_rational(x: &BigRational, precision_bits: u32) -> BigRational {
    if x.numer().is_zero() {
        return BigRational::zero();
    }
    assert!(!x.numer().is_negative(), "sqrt of negative rational");
    let scale = BigInt::from(1u8) << precision_bits;
    let numer_scaled = x.numer() * &scale * &scale;
    let n = &numer_scaled / x.denom();
    let root = n.sqrt();
    BigRational::new(root, scale)
}

/// Generic bisection solver used by the StableSwap reference model. Distinct
/// from production's Newton–Raphson update rule: bisection only needs a sign
/// change on `f` across `[lo, hi]`, converges monotonically, and its
/// convergence criterion (bracket width <= `epsilon`) is explicit rather than
/// implicit in a fixed iteration count.
pub fn bisect<F: Fn(&BigRational) -> BigRational>(
    mut lo: BigRational,
    mut hi: BigRational,
    epsilon: &BigRational,
    max_iters: u32,
    f: F,
) -> Convergence<BigRational> {
    let sign_lo = f(&lo).numer().sign();
    for i in 0..max_iters {
        let mid = (&lo + &hi) / two();
        let f_mid = f(&mid);
        if f_mid.is_zero() || (&hi - &lo) <= *epsilon {
            return Convergence::Converged {
                value: mid,
                iters: i + 1,
            };
        }
        if f_mid.numer().sign() == sign_lo {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Convergence::NotConverged {
        last: (&lo + &hi) / two(),
        iters: max_iters,
    }
}

/// Expands `hi` by repeated doubling until `f(hi)` changes sign relative to
/// `f(lo)` (or hits zero), so callers don't have to hand-derive an analytic
/// upper bound for every invariant equation — just a reasonable starting
/// guess. Returns `None` if no sign change is found within `max_doublings`.
pub fn expand_bracket_hi<F: Fn(&BigRational) -> BigRational>(
    lo: &BigRational,
    mut hi: BigRational,
    f: &F,
    max_doublings: u32,
) -> Option<BigRational> {
    let sign_lo = f(lo).numer().sign();
    for _ in 0..max_doublings {
        let s = f(&hi).numer().sign();
        if s != sign_lo {
            return Some(hi);
        }
        hi = &hi * two() + one();
    }
    None
}

/// Rounds a rational to the nearest integer (round-half-away-from-zero),
/// matching how the production contracts truncate/round fixed-point results
/// to `i128`/`u128` closely enough for tolerance comparison.
pub fn round_to_i128(x: &BigRational) -> i128 {
    let one_half = BigRational::new(BigInt::from(1), BigInt::from(2));
    let rounded = if x.is_negative() {
        x - &one_half
    } else {
        x + &one_half
    };
    let truncated = rounded.trunc();
    let digits = truncated.to_integer().to_string();
    digits.parse::<i128>().unwrap_or_else(|_| {
        if x.is_negative() {
            i128::MIN
        } else {
            i128::MAX
        }
    })
}

pub fn round_to_u128(x: &BigRational) -> u128 {
    let one_half = BigRational::new(BigInt::from(1), BigInt::from(2));
    let rounded = x + &one_half;
    let truncated = rounded.trunc();
    let digits = truncated.to_integer().to_string();
    digits.parse::<u128>().unwrap_or(u128::MAX)
}

pub fn one() -> BigRational {
    BigRational::one()
}
