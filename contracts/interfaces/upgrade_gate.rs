//! Fencing logic — gates state-changing methods during an incompatible
//! migration so that users cannot read or write a partially-migrated schema.

use soroban_sdk::Env;

pub trait UpgradeGate {
    fn require_operational(env: &Env) -> Result<(), u32>;
    fn is_operational(env: &Env) -> bool;
}

/// Marker: a contract that *has* been migrated to the upgrade framework
/// will have a `StorageVersion` key at this slot. Absence of this key
/// means the contract predates the framework (v0 semantics).
pub const LEGACY_STORAGE_SENTINEL: u32 = 0;
