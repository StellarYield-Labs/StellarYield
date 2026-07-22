//! Central, documented tolerance table.
//!
//! Issue #83 requires tolerances "in economic units and basis points, not
//! only raw integer difference," each justified per financial operation.
//! Every differential test pulls its tolerance from here rather than
//! inlining a magic number, and `docs/differential-verification.md` renders
//! this same table for the verification report.

use num_bigint::BigInt;

#[derive(Debug, Clone, Copy)]
pub struct Tolerance {
    pub name: &'static str,
    /// Relative tolerance in basis points (1 bps = 0.01%).
    pub bps: u32,
    /// Absolute floor in the operation's own fixed-point units, below which
    /// a difference is always accepted regardless of bps (guards against
    /// bps comparisons being meaningless near zero).
    pub abs_floor: i128,
    pub rationale: &'static str,
}

impl Tolerance {
    pub const fn new(
        name: &'static str,
        bps: u32,
        abs_floor: i128,
        rationale: &'static str,
    ) -> Self {
        Self {
            name,
            bps,
            abs_floor,
            rationale,
        }
    }

    /// `actual` (production output) vs `expected` (reference model output),
    /// both integers at the same fixed-point scale.
    pub fn check(&self, actual: i128, expected: i128) -> bool {
        let diff = actual.abs_diff(expected);
        if (diff as i128) <= self.abs_floor {
            return true;
        }
        let base = actual.unsigned_abs().max(expected.unsigned_abs()).max(1);
        // diff/base <= bps/10_000  <=>  diff*10_000 <= bps*base, computed in
        // BigInt so it can't overflow for near-i128::MAX magnitudes.
        let lhs = BigInt::from(diff) * BigInt::from(10_000u32);
        let rhs = BigInt::from(self.bps) * BigInt::from(base);
        lhs <= rhs
    }

    pub fn deviation_bps(&self, actual: i128, expected: i128) -> f64 {
        let diff = actual.abs_diff(expected) as f64;
        let base = (actual.unsigned_abs().max(expected.unsigned_abs()).max(1)) as f64;
        (diff / base) * 10_000.0
    }
}

// ── StableSwap ─────────────────────────────────────────────────────────────

pub const STABLESWAP_D: Tolerance = Tolerance::new(
    "stableswap.compute_d (balanced to moderate imbalance, ratio up to 50:1)",
    25,
    1,
    "Production's Newton loop truncates an integer division on every one of up to \
     NEWTON_ITERS=255 steps; empirically (10k+ generated cases while building this \
     harness) that compounds to single-digit bps drift even at modest imbalance once \
     the amplification coefficient is non-trivial (observed ~4-5 bps at a 50:1 ratio, \
     amp ~31k). 25 bps gives that observed drift real margin without masking a \
     regression.",
);

pub const STABLESWAP_D_IMBALANCED: Tolerance = Tolerance::new(
    "stableswap.compute_d (extreme imbalance, ratio up to 1000:1)",
    1_000,
    500,
    "Empirically measured while building this harness across 10k+ generated cases: \
     under extreme reserve imbalance combined with a non-trivial amplification \
     coefficient, production's Newton loop's per-iteration truncating division \
     compounds substantially faster (observed up to ~556 bps at a ~875:1 ratio, amp \
     ~4140) than in the moderate-imbalance regime STABLESWAP_D covers. Near the \
     MIN_RESERVE boundary the *relative* error grows further still (observed ~1957 \
     bps at x=1,y=1000) purely because the absolute rounding unit is a larger \
     fraction of a tiny D — hence the 500-unit absolute floor alongside 1000 bps: \
     treat this regime's accuracy as materially weaker than the rest of the \
     invariant solve, bounded in raw-unit terms near zero rather than bps.",
);

pub const STABLESWAP_Y: Tolerance = Tolerance::new(
    "stableswap.compute_y / swap output",
    2,
    1,
    "Output amount is derived from compute_y, compounding compute_d's rounding once \
     more; 2 bps covers two rounds of integer truncation on top of the D tolerance.",
);

pub const STABLESWAP_FEE: Tolerance = Tolerance::new(
    "stableswap.compute_dynamic_fee",
    1,
    0,
    "Closed-form linear formula (no iteration); the only source of drift is integer \
     division truncation in FEE_PRECISION (1e7) units, bounded at 1 bps.",
);

// ── CLMM ─────────────────────────────────────────────────────────────────

/// Production approximates `sqrt_price_x96` as *linear* in tick
/// (`Q96 + Q96*|tick|/10000`), not `sqrt(1.0001^tick)`. Even the
/// first-order Taylor slope of the true curve near tick 0 is
/// `0.00005*tick`, half of production's `0.0001*tick` slope — so unlike a
/// typical "small-angle" approximation, this one is already measurably off
/// within a few dozen ticks, not just at the extremes. Measured while
/// building this harness: ~5 bps at tick=10, ~25 bps at tick=50, ~460 bps at
/// tick=1000, and many orders of magnitude at tick=MAX_TICK (887,272) — at
/// which point production's `u128` `sqrt_price_x96` can't represent the true
/// value at all (see `reference::clmm::true_sqrt_price_x96`). This tolerance
/// covers only the "recommended usable range" documented in
/// docs/differential-verification.md; `CLMM_SQRT_PRICE_FAR_FROM_ZERO` locks
/// in (rather than hides) the blow-up beyond it.
pub const CLMM_SQRT_PRICE: Tolerance = Tolerance::new(
    "clmm.get_sqrt_ratio_at_tick (|tick| <= 50, recommended usable range)",
    30,
    0,
    "Measured ~25 bps deviation at the |tick|=50 edge of the recommended range; 30 \
     bps gives that measurement margin without hiding a regression.",
);

/// Not a "should stay small" tolerance — a floor the deviation is expected
/// to *exceed* outside the recommended range, asserted so a future change to
/// the approximation (for better or worse) shows up as a test change instead
/// of silent drift. See `CLMM_SQRT_PRICE`.
pub const CLMM_SQRT_PRICE_FAR_FROM_ZERO_MIN_DEVIATION_BPS: f64 = 400.0;

pub const CLMM_SWAP_STEP: Tolerance = Tolerance::new(
    "clmm.compute_swap_step / get_amounts_for_liquidity (exact rounding check, fixed sqrt-price inputs)",
    5,
    2,
    "Given the SAME sqrt-price inputs production itself was called with (i.e. not \
     compounding CLMM_SQRT_PRICE's approximation error), these formulas are plain \
     truncating integer division with no iteration; 5 bps covers that truncation. The \
     2-unit absolute floor covers single-tick-spacing ranges where the result itself \
     is only a few hundred raw units, so a single truncated unit reads as tens of bps.",
);

// ── Options ────────────────────────────────────────────────────────────────

pub const OPTIONS_NORMAL_CDF: Tolerance = Tolerance::new(
    "options.normal_cdf (logistic approximation, |x| <= 1)",
    400,
    0,
    "Production approximates N(x) with a logistic function (N(x) ~= 1/(1+e^-1.702x)). \
     Even restricted to |x|<=1 (the only region where the *separate*, more severe \
     exp()-accuracy defect is not also in play — see \
     `exp_is_wrong_signed_below_negative_4` / `normal_cdf_deviation_grows_in_the_mid_range` \
     in tests/diff_options.rs), the logistic-vs-normal shape mismatch itself measures \
     ~370 bps against the Abramowitz & Stegun 7.1.26 high-precision reference \
     (abs error <= 1.5e-7). 400 bps gives that measurement margin.",
);

pub const OPTIONS_PREMIUM: Tolerance = Tolerance::new(
    "options.black_scholes_call premium (near-the-money, moderate-to-high vol/tenor)",
    700,
    1_000,
    "Compounds the normal_cdf approximation error twice (N(d1), N(d2)) plus the \
     bisection-based ln/exp used in production; even within the narrow domain \
     tests/diff_options.rs restricts itself to (needed to keep d1/d2 inside exp()'s \
     accurate range), measured deviation reached ~620 bps. 700 bps with a 1000-unit \
     (1e9 = ONE scale => 0.0000001 of the underlying) absolute floor for near-zero \
     premiums (deep OTM/expired options).",
);

// ── Perpetuals ─────────────────────────────────────────────────────────────

pub const PERP_PNL: Tolerance = Tolerance::new(
    "perpetuals.calculate_pnl",
    1,
    1,
    "Pure integer multiply/divide by PRICE_SCALE (1e7); only source of drift is a \
     single truncating division, bounded at 1 bps or 1 raw unit.",
);

pub const PERP_LIQUIDATION_PRICE: Tolerance = Tolerance::new(
    "perpetuals.calculate_liquidation_price",
    5,
    1,
    "Two chained divisions (min_margin, then price_delta); 5 bps covers compounded \
     truncation across both.",
);

pub const PERP_FUNDING: Tolerance = Tolerance::new(
    "perpetuals.funding accrual",
    10,
    1,
    "Funding payment depends on OI skew and elapsed time, both truncating integer \
     divisions; 10 bps for the compounded rounding across the funding-rate and \
     payment-application steps.",
);

pub const PERP_OPEN_INTEREST: Tolerance = Tolerance::new(
    "perpetuals.open_interest vs aggregate notional",
    5,
    1,
    "Open interest is updated incrementally on every open/close; reference \
     recomputes it from scratch as the sum of live position notionals. 5 bps \
     covers per-position rounding accumulated across a sequence.",
);

// ── Stablecoin ─────────────────────────────────────────────────────────────

pub const STABLECOIN_INDEX: Tolerance = Tolerance::new(
    "stablecoin_manager.calculate_index",
    1,
    1,
    "Simple (non-compounding-within-call) per-update interest accrual, scaled by \
     1e18; single truncating division chain, bounded at 1 bps.",
);

pub const STABLECOIN_CR: Tolerance = Tolerance::new(
    "stablecoin_manager.calculate_cr",
    1,
    1,
    "Collateral ratio is a single division in basis-point units (10_000 = 100%); \
     1 bps covers truncation.",
);

pub const ALL: &[Tolerance] = &[
    STABLESWAP_D,
    STABLESWAP_D_IMBALANCED,
    STABLESWAP_Y,
    STABLESWAP_FEE,
    CLMM_SQRT_PRICE,
    CLMM_SWAP_STEP,
    OPTIONS_NORMAL_CDF,
    OPTIONS_PREMIUM,
    PERP_PNL,
    PERP_LIQUIDATION_PRICE,
    PERP_FUNDING,
    PERP_OPEN_INTEREST,
    STABLECOIN_INDEX,
    STABLECOIN_CR,
];
