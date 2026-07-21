//! Independent differential + property verification harness for StellarYield's
//! AMM, options, perpetual, and stablecoin math (issue #83).
//!
//! This crate is deliberately kept outside the contract crates it verifies:
//! reference models here are separate implementations (different algorithms,
//! different numeric domains — `BigRational`/`f64` instead of scaled `i128`)
//! rather than the production formulas re-exported under a new name.

pub mod bigmath;
pub mod corpus;
pub mod reference;
pub mod resource;
pub mod tolerance;
pub mod vectors;

/// Bumped whenever a reference model's algorithm, precision, or domain
/// changes in a way that could change expected values for a given seed.
/// Regression fixtures record the model version they were captured under.
pub const MODEL_VERSION: &str = "verification-model-v1";

/// Result of an iterative reference-model solve. Production's Newton loops
/// (e.g. `stableswap::compute_d`) return their last iterate unconditionally;
/// this harness does not — a reference solve that fails to converge within
/// its declared iteration bound is a hard failure, not a best-effort value
/// (issue #83: "fail closed on non-convergence instead of accepting the last
/// iterative value").
#[derive(Debug, Clone)]
pub enum Convergence<T> {
    Converged { value: T, iters: u32 },
    NotConverged { last: T, iters: u32 },
}

impl<T> Convergence<T> {
    pub fn is_converged(&self) -> bool {
        matches!(self, Convergence::Converged { .. })
    }

    pub fn iters(&self) -> u32 {
        match self {
            Convergence::Converged { iters, .. } => *iters,
            Convergence::NotConverged { iters, .. } => *iters,
        }
    }

    /// Unwraps the converged value, panicking (failing the test closed)
    /// otherwise.
    pub fn expect_converged(self, context: &str) -> T {
        match self {
            Convergence::Converged { value, .. } => value,
            Convergence::NotConverged { iters, .. } => panic!(
                "{context}: reference model did not converge within {iters} iterations \
                 (failing closed rather than accepting the last iterate)"
            ),
        }
    }
}
