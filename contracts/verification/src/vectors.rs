//! Deterministic, seeded test-vector generation.
//!
//! Every differential/property test iterates `case_count()` seeds
//! `0..case_count()`, derives a `ChaCha8Rng` from each seed, and regenerates
//! its inputs from that RNG. Nothing about a failing case needs to be
//! persisted to reproduce it — only `(seed, model_version, subsystem,
//! generator)`, which is exactly what `corpus::RegressionFixture` records.

use rand::{Rng, RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;

/// Number of generated cases to run per formula. PR CI leaves this at its
/// smoke default; the scheduled extended workflow sets
/// `VERIFICATION_CASES=10000`.
pub fn case_count() -> u32 {
    std::env::var("VERIFICATION_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(300)
}

pub fn rng_for_seed(seed: u64) -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(seed)
}

/// Draws an `i128` in `[min, max]`, weighted so boundary conditions
/// (near-zero, the max end of the range, and any caller-supplied
/// boundaries such as exact tick edges or liquidation thresholds) get real
/// coverage instead of being drowned out by uniform sampling of a huge
/// domain.
pub fn amount_i128(rng: &mut impl RngCore, min: i128, max: i128, boundaries: &[i128]) -> i128 {
    assert!(max >= min);
    let roll: u32 = rng.gen_range(0..100);
    if roll < 5 {
        return min;
    }
    if roll < 10 {
        return max;
    }
    if roll < 20 && !boundaries.is_empty() {
        let idx = rng.gen_range(0..boundaries.len());
        return boundaries[idx].clamp(min, max);
    }
    uniform_i128(rng, min, max)
}

/// Unbiased uniform sample over `[min, max]` for ranges that can span the
/// full `i128`/`u128` domain (rejection sampling on a `u128` span would be
/// fine too, but two `u64` draws avoids rejection loops near the domain
/// edges where `case_count()` is large).
pub fn uniform_i128(rng: &mut impl RngCore, min: i128, max: i128) -> i128 {
    let span = max.wrapping_sub(min) as u128;
    if span == 0 {
        return min;
    }
    let hi: u64 = rng.gen();
    let lo: u64 = rng.gen();
    let raw = ((hi as u128) << 64) | lo as u128;
    let offset = if span == u128::MAX {
        raw
    } else {
        raw % (span + 1)
    };
    min.wrapping_add(offset as i128)
}

pub fn uniform_u128(rng: &mut impl RngCore, min: u128, max: u128) -> u128 {
    assert!(max >= min);
    let span = max - min;
    if span == 0 {
        return min;
    }
    let hi: u64 = rng.gen();
    let lo: u64 = rng.gen();
    let raw = ((hi as u128) << 64) | lo as u128;
    let offset = if span == u128::MAX {
        raw
    } else {
        raw % (span + 1)
    };
    min + offset
}

pub fn amount_u128(rng: &mut impl RngCore, min: u128, max: u128, boundaries: &[u128]) -> u128 {
    let roll: u32 = rng.gen_range(0..100);
    if roll < 5 {
        return min;
    }
    if roll < 10 {
        return max;
    }
    if roll < 20 && !boundaries.is_empty() {
        let idx = rng.gen_range(0..boundaries.len());
        return boundaries[idx].clamp(min, max);
    }
    uniform_u128(rng, min, max)
}

/// Draws a tick, weighted towards `MIN_TICK`, `0`, `MAX_TICK`, and
/// caller-supplied exact boundaries (e.g. tick-spacing multiples).
pub fn tick(rng: &mut impl RngCore, min: i32, max: i32, boundaries: &[i32]) -> i32 {
    let roll: u32 = rng.gen_range(0..100);
    if roll < 10 {
        return min;
    }
    if roll < 20 {
        return max;
    }
    if roll < 25 {
        return 0.clamp(min, max);
    }
    if roll < 35 && !boundaries.is_empty() {
        let idx = rng.gen_range(0..boundaries.len());
        return boundaries[idx].clamp(min, max);
    }
    rng.gen_range(min..=max)
}

/// True occasionally so generated sequences include invalid/edge actions
/// (e.g. an expired option, a withdrawal larger than the balance) rather
/// than only well-formed ones.
pub fn sometimes(rng: &mut impl RngCore, probability_pct: u32) -> bool {
    rng.gen_range(0..100) < probability_pct
}
