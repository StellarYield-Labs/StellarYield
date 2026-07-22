//! Soroban resource metering for adversarial inputs.
//!
//! Wraps `Env::cost_estimate().resources()` (soroban-sdk testutils, enabled
//! by default on every `Env::default()`) into a serializable snapshot, and
//! compares it against a checked-in baseline the way
//! `contracts/yield_vault/test_snapshots/` already does for its own fuzz
//! suite.

use serde::{Deserialize, Serialize};
use soroban_sdk::Env;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceSnapshot {
    pub label: String,
    pub instructions: i64,
    pub mem_bytes: i64,
    pub read_entries: u32,
    pub write_entries: u32,
    pub read_bytes: u32,
    pub write_bytes: u32,
    pub contract_events_size_bytes: u32,
}

impl ResourceSnapshot {
    /// Captures the resources metered during the *last* top-level contract
    /// invocation on `env`. Call immediately after the call under test.
    pub fn capture(env: &Env, label: &str) -> Self {
        let res = env.cost_estimate().resources();
        Self {
            label: label.to_string(),
            instructions: res.instructions,
            mem_bytes: res.mem_bytes,
            read_entries: res.read_entries,
            write_entries: res.write_entries,
            read_bytes: res.read_bytes,
            write_bytes: res.write_bytes,
            contract_events_size_bytes: res.contract_events_size_bytes,
        }
    }
}

/// A discovered regression here means "this call got more expensive than the
/// last approved baseline by more than the allowed margin" — not that it
/// exceeded an absolute Soroban network limit (those are far higher than
/// anything these contracts approach). `margin_pct` is the approved slack
/// before that counts as a regression.
pub fn within_budget(
    baseline: &ResourceSnapshot,
    current: &ResourceSnapshot,
    margin_pct: f64,
) -> Result<(), String> {
    let checks: [(&str, i64, i64); 2] = [
        ("instructions", baseline.instructions, current.instructions),
        ("mem_bytes", baseline.mem_bytes, current.mem_bytes),
    ];
    for (name, base, cur) in checks {
        let allowed = (base as f64) * (1.0 + margin_pct / 100.0);
        if (cur as f64) > allowed {
            return Err(format!(
                "{} regression for '{}': baseline={} current={} allowed<=~{:.0} ({}% margin)",
                name, current.label, base, cur, allowed, margin_pct
            ));
        }
    }
    if current.read_entries > baseline.read_entries
        || current.write_entries > baseline.write_entries
    {
        return Err(format!(
            "ledger read/write entry count regression for '{}': baseline reads={} writes={} \
             current reads={} writes={}",
            current.label,
            baseline.read_entries,
            baseline.write_entries,
            current.read_entries,
            current.write_entries
        ));
    }
    Ok(())
}

pub fn load_baseline(path: &str) -> Option<ResourceSnapshot> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn save_snapshot(path: &str, snapshot: &ResourceSnapshot) {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = serde_json::to_string_pretty(snapshot).expect("serialize snapshot");
    std::fs::write(path, data).expect("write snapshot");
}
