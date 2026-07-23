//! Permanent regression corpus.
//!
//! When a differential or property check fails, the harness shrinks the
//! offending concrete inputs towards zero/boundaries while the failure
//! still reproduces (see [`shrink_i128`] / [`shrink_u128`]), then records a
//! `RegressionFixture` JSON file under `contracts/verification/regression/`.
//! `tests/regression_replay.rs` loads every fixture in that directory and
//! replays it directly from its minimized `inputs`, so a fixed bug that
//! regresses is caught immediately without needing to re-run the generator.
//!
//! `seed` is kept for provenance (which generator seed originally surfaced
//! it) and `model_version` records which reference-model revision produced
//! the recorded failure — the "seed, input domain, expected value,
//! tolerance, model version" the issue asks a vector to carry.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegressionFixture {
    pub name: String,
    pub subsystem: String,
    pub seed: u64,
    pub model_version: String,
    pub description: String,
    /// Minimized concrete inputs, shaped however the owning test needs
    /// (subsystem-specific); replay deserializes this back into its own
    /// input struct.
    pub inputs: Value,
}

pub fn regression_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("regression")
}

pub fn record(fixture: &RegressionFixture) {
    let dir = regression_dir();
    std::fs::create_dir_all(&dir).expect("create regression dir");
    let path = dir.join(format!("{}.json", fixture.name));
    let data = serde_json::to_string_pretty(fixture).expect("serialize fixture");
    std::fs::write(path, data).expect("write regression fixture");
}

pub fn load_all() -> Vec<RegressionFixture> {
    let dir = regression_dir();
    let mut fixtures = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return fixtures;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let data = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
        let fixture: RegressionFixture =
            serde_json::from_str(&data).unwrap_or_else(|e| panic!("parse {path:?}: {e}"));
        fixtures.push(fixture);
    }
    fixtures.sort_by(|a, b| a.name.cmp(&b.name));
    fixtures
}

/// Shrinks a single failing `i128` input towards `0` by binary search:
/// finds the smallest-magnitude value on the path from `0` to `value` for
/// which `still_fails` remains true, assuming (not guaranteed, but true for
/// every property in this crate) that failure doesn't get *less* likely as
/// magnitude shrinks towards a boundary. Intentionally simple — documented
/// as the current minimization strategy, not a general delta-debugger.
pub fn shrink_u128<F: Fn(u128) -> bool>(value: u128, still_fails: F) -> u128 {
    if value == 0 || !still_fails(value) {
        return value;
    }
    // Invariant maintained throughout: still_fails(hi) == true.
    let mut lo: u128 = 0;
    let mut hi: u128 = value;
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if still_fails(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    hi
}

/// Same idea as [`shrink_u128`] but for signed magnitudes: shrinks `value`'s
/// absolute value towards zero (keeping its sign) while `still_fails`
/// remains true.
pub fn shrink_i128<F: Fn(i128) -> bool>(value: i128, still_fails: F) -> i128 {
    if value == 0 {
        return value;
    }
    let sign: i128 = if value < 0 { -1 } else { 1 };
    let magnitude = value.unsigned_abs();
    let shrunk = shrink_u128(magnitude, |m| still_fails(sign * (m as i128)));
    sign * (shrunk as i128)
}
