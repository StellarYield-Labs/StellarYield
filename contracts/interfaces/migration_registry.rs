/// Migration Registry — tracks allowed version edges and migration metadata
/// for all upgradeable contracts in the StellarYield protocol.
///
/// Each contract declares its migration graph here so that governance,
/// tooling, and external auditors can verify upgrade paths before execution.
use soroban_sdk::{contracttype, BytesN, Env, String, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RegistryEntryKind {
    OneShot,
    Batched,
    ReadCompatible,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationRegistryEdge {
    pub from_version: u32,
    pub to_version: u32,
    pub kind: RegistryEntryKind,
    pub migration_id: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUpgradeHistory {
    pub contract_name: String,
    pub current_storage_version: u32,
    pub current_wasm_hash: BytesN<32>,
    pub edges: Vec<MigrationRegistryEdge>,
}

pub const MIGRATION_REGISTRY_SLOT: soroban_sdk::Symbol = soroban_sdk::symbol_short!("mg_reg");

pub fn register_migration_edge(
    env: &Env,
    from_version: u32,
    to_version: u32,
    kind: RegistryEntryKind,
    migration_id: String,
) {
    let mut registry: Vec<MigrationRegistryEdge> = env
        .storage()
        .instance()
        .get(&MIGRATION_REGISTRY_SLOT)
        .unwrap_or(Vec::new(env));

    let edge = MigrationRegistryEdge {
        from_version,
        to_version,
        kind,
        migration_id,
    };
    registry.push_back(edge);
    env.storage()
        .instance()
        .set(&MIGRATION_REGISTRY_SLOT, &registry);
}

pub fn get_allowed_edges(env: &Env) -> Vec<MigrationRegistryEdge> {
    env.storage()
        .instance()
        .get(&MIGRATION_REGISTRY_SLOT)
        .unwrap_or(Vec::new(env))
}

pub fn is_valid_migration(env: &Env, from_version: u32, to_version: u32) -> bool {
    let registry: Vec<MigrationRegistryEdge> = env
        .storage()
        .instance()
        .get(&MIGRATION_REGISTRY_SLOT)
        .unwrap_or(Vec::new(env));

    for edge in registry.iter() {
        if edge.from_version == from_version && edge.to_version == to_version {
            return true;
        }
    }
    false
}
