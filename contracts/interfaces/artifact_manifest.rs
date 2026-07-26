/// Artifact Manifest — binds a compiled Wasm blob to its provenance so
/// governance can verify what it is approving before scheduling an upgrade.
use soroban_sdk::{contracttype, BytesN, String, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactManifestV1 {
    /// SHA-256 of the compiled Wasm blob.
    pub wasm_hash: BytesN<32>,
    /// Rust toolchain version (e.g. "nightly-2025-03-15").
    pub rust_toolchain: String,
    /// Git commit SHA from which this artifact was built.
    pub source_commit: BytesN<32>,
    /// SHA-256 of the contract spec (Soroban spec JSON).
    pub contract_spec_hash: BytesN<32>,
    /// SHA-256 of the migration plan that must be applied
    /// when upgrading to this artifact.
    pub migration_plan_hash: BytesN<32>,
    /// Human-readable contract name for identification.
    pub contract_name: String,
    /// Semver version of the contract logic (not storage).
    pub contract_version: String,
}

impl ArtifactManifestV1 {
    pub fn digest(&self) -> BytesN<32> {
        todo!("Off-chain: compute SHA-256 of the canonical encoding of this struct")
    }
}

/// Off-chain helper to compute the canonical JSON encoding of an artifact
/// manifest for reproducible build verification.
pub fn compute_manifest_digest(manifest: &ArtifactManifestV1) -> [u8; 32] {
    let _ = manifest;
    todo!("Off-chain digest computation — use the Rust soroban-auth or a native SHA-256 impl")
}
