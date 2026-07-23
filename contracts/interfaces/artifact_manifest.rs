use soroban_sdk::{contracttype, Bytes, String, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactManifest {
    pub contract_name: Symbol,
    pub wasm_hash: Bytes,
    pub rust_toolchain: String,
    pub source_commit: String,
    pub contract_spec_hash: Bytes,
    pub migration_plan_hash: Bytes,
}
