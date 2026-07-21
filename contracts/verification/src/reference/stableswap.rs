//! Independent StableSwap reference model.
//!
//! Production (`contracts/stableswap/src/lib.rs`) solves the n=2 Curve
//! invariant with a hand-derived Newton–Raphson update rule running a fixed
//! `NEWTON_ITERS` iterations in `i128`. This model solves the *same*
//! invariant equation with bisection over `BigRational`, which needs no
//! derived update formula (only a sign change on the residual) and has an
//! explicit, checkable convergence criterion instead of a fixed iteration
//! count. It is a different algorithm operating in a different numeric
//! domain, not the production formula copied under a new name.
//!
//! Invariant (n=2): `4*A*(x+y) + D == 4*A*D + D^3 / (4*x*y)`.

use num_rational::BigRational;
use num_traits::Zero;

use crate::bigmath::{expand_bracket_hi, int, one, sqrt_rational, two};
use crate::Convergence;

const MAX_ITERS: u32 = 300;

fn residual_d(x: &BigRational, y: &BigRational, amp: &BigRational, d: &BigRational) -> BigRational {
    let four_a = int(4) * amp;
    let d3 = d * d * d;
    let four_xy = int(4) * x * y;
    &four_a * (x + y) + d - &four_a * d - d3 / four_xy
}

/// Solves for the invariant `D` given reserves `x`, `y` and amplification
/// `amp`. Mirrors `stableswap::compute_d`'s contract (same inputs, same
/// invariant), independent solving method.
pub fn compute_d(x: i128, y: i128, amp: u32) -> Convergence<BigRational> {
    let x_r = int(x);
    let y_r = int(y);
    let amp_r = int(amp as i128);
    let f = |d: &BigRational| residual_d(&x_r, &y_r, &amp_r, d);

    let lo = BigRational::zero();
    let guess_hi = int(4) * (&x_r + &y_r) + int(8);
    let Some(hi) = expand_bracket_hi(&lo, guess_hi, &f, 128) else {
        return Convergence::NotConverged {
            last: BigRational::zero(),
            iters: 0,
        };
    };
    let epsilon = BigRational::new(1.into(), 2.into());
    crate::bigmath::bisect(lo, hi, &epsilon, MAX_ITERS, f)
}

/// Solves for reserve `y` given the new opposite reserve `x_new` and an
/// invariant value `d`. Production's `compute_y` takes `sum = x + y` and
/// uses it *directly* as an approximation of `D` (documented in production
/// as "Recompute D from current sum (approximation: use sum as proxy for
/// D)") rather than solving for the true D first. This reference model
/// mirrors that exact contract — callers pass the same `d` production would
/// (i.e. the pre-swap `sum`) — so the comparison is apples-to-apples with
/// what `compute_y` actually promises, not a hypothetical "more correct"
/// version of it.
pub fn compute_y(x_new: i128, d: i128, amp: u32) -> Convergence<BigRational> {
    let x_r = int(x_new);
    let d_r = int(d);
    let amp_r = int(amp as i128);

    // The true (real-valued) root can legitimately sit below y=1 when `d`
    // and `x_new` are both tiny (production would then round it to 0 or 1) —
    // start the bracket at a small fraction rather than 1 so that region is
    // actually covered instead of silently reported as non-convergent.
    let lo = BigRational::new(1.into(), 1_000_000.into());
    // A safe starting guess: y large enough that the linear 4*A*y term
    // dominates D^3/(4*x*y); expand_bracket_hi will grow it further if not.
    let d3_over_16ax = {
        let d3 = &d_r * &d_r * &d_r;
        d3 / (int(16) * &amp_r * &x_r)
    };
    let sqrt_bound = sqrt_rational(&d3_over_16ax.max(BigRational::zero()), 128);
    let guess_hi = sqrt_bound * two() + &d_r + &x_r + one();

    let f = move |y: &BigRational| residual_d(&x_r, y, &amp_r, &d_r);
    let Some(hi) = expand_bracket_hi(&lo, guess_hi, &f, 128) else {
        return Convergence::NotConverged {
            last: BigRational::zero(),
            iters: 0,
        };
    };
    let epsilon = BigRational::new(1.into(), 2.into());
    crate::bigmath::bisect(lo, hi, &epsilon, MAX_ITERS, f)
}

/// Dynamic fee: closed-form (no iteration), computed exactly in rationals.
/// `fee_precision` is the same scaling base production uses (1e7 in
/// `FEE_PRECISION`).
pub fn dynamic_fee(
    balance0: i128,
    balance1: i128,
    base_fee: u32,
    fee_multiplier: u32,
) -> BigRational {
    let total = balance0 + balance1;
    if total == 0 {
        return int(base_fee as i128);
    }
    let diff = int((balance0 - balance1).abs());
    let imbalance_ratio = diff / int(total);
    int(base_fee as i128) + imbalance_ratio * int(fee_multiplier as i128)
}
