//! Independent Black-Scholes reference model.
//!
//! `contracts/options/src/math.rs` approximates the normal CDF with a
//! logistic function (`N(x) ~= 1/(1+e^-1.702x)`), a documented closed-form
//! stand-in for the true CDF, and computes `exp`/`ln` via a fixed-point
//! Taylor series / bisection search. This model uses `f64` throughout with
//! the Abramowitz & Stegun 7.1.26 rational `erf` approximation (max absolute
//! error <= 1.5e-7) for the CDF and the standard library's `exp`/`ln`/`sqrt`
//! — a different approximation of a different function, evaluated with a
//! different numeric domain and precision, not production's logistic model
//! renamed.
//!
//! Mirrors production's assumption of a zero risk-free rate (production's
//! `black_scholes_call` never discounts the strike by `e^{-rT}`), so the two
//! are pricing the same contract rather than two different models.

/// High-precision standard normal CDF via Abramowitz & Stegun 7.1.26.
pub fn normal_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / std::f64::consts::SQRT_2))
}

fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();

    const A1: f64 = 0.254829592;
    const A2: f64 = -0.284496736;
    const A3: f64 = 1.421413741;
    const A4: f64 = -1.453152027;
    const A5: f64 = 1.061405429;
    const P: f64 = 0.3275911;

    let t = 1.0 / (1.0 + P * x);
    let y = 1.0 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * (-x * x).exp();
    sign * y
}

/// `spot`/`strike`/`t`/`iv` are all real (unscaled) values here — the
/// differential test converts production's `ONE`-scaled `i128` inputs to
/// `f64` before calling this, and the resulting premium back to `ONE`-scaled
/// fixed point for comparison.
pub fn black_scholes_call(spot: f64, strike: f64, t: f64, iv: f64) -> f64 {
    if t <= 0.0 {
        return (spot - strike).max(0.0);
    }
    if iv <= 0.0 || strike <= 0.0 {
        return (spot - strike).max(0.0);
    }

    let sqrt_t = t.sqrt();
    let d1 = ((spot / strike).ln() + 0.5 * iv * iv * t) / (iv * sqrt_t);
    let d2 = d1 - iv * sqrt_t;

    let n_d1 = normal_cdf(d1);
    let n_d2 = normal_cdf(d2);

    (spot * n_d1 - strike * n_d2).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_cdf_matches_known_values() {
        assert!((normal_cdf(0.0) - 0.5).abs() < 1e-9);
        // N(1.0) ~= 0.8413447460685429
        assert!((normal_cdf(1.0) - 0.8413447460685429).abs() < 1e-6);
        // N(-1.0) ~= 0.15865525393145707
        assert!((normal_cdf(-1.0) - 0.15865525393145707).abs() < 1e-6);
    }

    #[test]
    fn atm_call_is_roughly_half_spot_times_vol_time() {
        // Sanity check against a well-known closed-form ATM approximation
        // (Brenner-Subrahmanyam): C_ATM ~= 0.4 * S * iv * sqrt(T) for r=0.
        let spot = 100.0;
        let iv = 0.5;
        let t = 1.0;
        let call = black_scholes_call(spot, spot, t, iv);
        let approx = 0.4 * spot * iv * t.sqrt();
        assert!((call - approx).abs() / approx < 0.05);
    }
}
