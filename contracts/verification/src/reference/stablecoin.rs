//! Independent stablecoin interest/collateral reference model. Each
//! production function (`contracts/stablecoin_manager/src/math.rs`) chains
//! 1-2 truncating integer divisions to avoid overflow; this recomputes the
//! same closed-form relationship as one exact `BigRational` expression, so
//! the only expected drift is that truncation.

use num_rational::BigRational;

use crate::bigmath::int;

pub const SCALAR_18: i128 = 1_000_000_000_000_000_000;
pub const SECONDS_PER_YEAR: i128 = 31_536_000;

/// `index_last * (1 + rate_per_year * elapsed / SECONDS_PER_YEAR / SCALAR_18)`,
/// i.e. simple (non-compounding-within-call) per-update accrual, matching
/// production's `calculate_index` contract exactly (same inputs, same
/// non-compounding model — compounding only emerges from repeated calls).
pub fn calculate_index(index_last: i128, rate_per_year: i128, elapsed: u64) -> BigRational {
    if elapsed == 0 {
        return int(index_last);
    }
    let elapsed_rate = int(rate_per_year) * int(elapsed as i128) / int(SECONDS_PER_YEAR);
    let interest = int(index_last) * elapsed_rate / int(SCALAR_18);
    int(index_last) + interest
}

pub fn calculate_debt(debt_shares: i128, index: i128) -> BigRational {
    int(debt_shares) * int(index) / int(SCALAR_18)
}

pub fn calculate_collateral_value(
    collateral: i128,
    vault_assets: i128,
    vault_shares: i128,
    price_usd: i128,
) -> BigRational {
    if vault_shares == 0 {
        return int(0);
    }
    int(collateral) * int(vault_assets) * int(price_usd) / (int(vault_shares) * int(10_000_000))
}

/// Collateralization ratio in basis points (10_000 = 100%); `u32::MAX` when
/// debt is zero, matching production's sentinel for "no debt".
pub fn calculate_cr(collateral_value: i128, debt_value: i128) -> BigRational {
    if debt_value == 0 {
        return int(u32::MAX as i128);
    }
    int(collateral_value) * int(10_000) / int(debt_value)
}
