//! Independent perpetual futures reference model (PnL, liquidation price,
//! open interest). Computed as single exact `BigRational` expressions
//! instead of production's multi-step truncating-integer-division chains
//! (`contracts/perpetuals/src/lib.rs`), so tolerance reflects only the
//! rounding production's chain of divisions introduces.
//!
//! Funding and margin math in production are Env/storage-coupled (they read
//! risk parameters from contract storage), so this harness verifies those
//! through the contract's public entry points directly (black-box,
//! `tests/diff_perpetuals.rs`) rather than duplicating a storage-coupled
//! reference model here.

use num_rational::BigRational;

use crate::bigmath::int;

pub const PRICE_SCALE: i128 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

/// Exact PnL: `size * (current - entry) / PRICE_SCALE` for longs, negated
/// for shorts — production computes this as two separately-truncated
/// notionals subtracted from each other; this is the single untruncated
/// value both should be within [`crate::tolerance::PERP_PNL`] of.
pub fn pnl(side: Side, size: i128, entry_price: i128, current_price: i128) -> BigRational {
    let diff = int(current_price) - int(entry_price);
    let signed = match side {
        Side::Long => diff,
        Side::Short => -diff,
    };
    int(size) * signed / int(PRICE_SCALE)
}

/// Exact liquidation price, mirroring production's algebra
/// (`margin + size*(liq_price-entry) = notional*min_margin_ratio`) as one
/// rational expression instead of production's three chained divisions.
pub fn liquidation_price(
    side: Side,
    entry_price: i128,
    margin: i128,
    notional: i128,
    min_margin_ratio_bps: u32,
) -> BigRational {
    let min_margin = int(notional) * int(min_margin_ratio_bps as i128) / int(10_000);
    let price_buffer = int(margin) - min_margin;
    let price_delta = price_buffer * int(PRICE_SCALE) / int(notional);
    match side {
        Side::Long => int(entry_price) - price_delta,
        Side::Short => int(entry_price) + price_delta,
    }
}

/// Recomputes aggregate open interest from scratch as the sum of live
/// position notionals, for comparison against production's incrementally
/// maintained `long_oi`/`short_oi` counters.
pub fn open_interest_from_positions(
    positions: &[(Side, i128, i128)],
) -> (BigRational, BigRational) {
    let mut long = BigRational::from_integer(0.into());
    let mut short = BigRational::from_integer(0.into());
    for (side, size, entry_price) in positions {
        let notional = int(*size) * int(*entry_price) / int(PRICE_SCALE);
        match side {
            Side::Long => long += notional,
            Side::Short => short += notional,
        }
    }
    (long, short)
}
