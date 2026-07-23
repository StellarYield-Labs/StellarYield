use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::{SettlementContract, SettlementError, StorageKey};

#[path = "../../interfaces/upgrade.rs"]
mod upgrade_types;
use upgrade_types::{
    MigrationEdge, MigrationKind, MigrationStatus, PendingUpgrade, UPGRADE_TIMELOCK_SECONDS,
};

const CONTRACT_VERSION: u32 = 1_00_00;
const STORAGE_VERSION: u32 = 1;
const UPGRADE_TIMELOCK: u64 = UPGRADE_TIMELOCK_SECONDS;

impl SettlementContract {
    pub fn contract_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&StorageKey::ContractVersion)
            .unwrap_or(CONTRACT_VERSION)
    }

    pub fn storage_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&StorageKey::StorageVersion)
            .unwrap_or(STORAGE_VERSION)
    }

    pub fn schedule_upgrade(
        env: Env,
        governance: Address,
        wasm_hash: BytesN<32>,
        expected_current_hash: BytesN<32>,
        migration_id: u32,
    ) -> Result<(), SettlementError> {
        Self::require_admin(&env, &governance)?;

        if env.storage().instance().has(&StorageKey::PendingUpgrade) {
            return Err(SettlementError::UpgradeAlreadyScheduled);
        }

        let pending = PendingUpgrade {
            wasm_hash,
            scheduled_at: env.ledger().timestamp(),
            timelock_seconds: UPGRADE_TIMELOCK,
            migration_id,
            expected_current_hash,
        };

        env.storage()
            .instance()
            .set(&StorageKey::PendingUpgrade, &pending);

        env.events().publish(
            ("schedule_upgrade", governance),
            (
                pending.wasm_hash.clone(),
                pending.scheduled_at,
                pending.migration_id,
            ),
        );

        Ok(())
    }

    pub fn cancel_upgrade(env: Env, governance: Address) -> Result<(), SettlementError> {
        Self::require_admin(&env, &governance)?;

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&StorageKey::PendingUpgrade)
            .ok_or(SettlementError::NoPendingUpgrade)?;

        env.storage().instance().remove(&StorageKey::PendingUpgrade);

        env.events()
            .publish(("cancel_upgrade", governance), (pending.wasm_hash,));

        Ok(())
    }

    pub fn execute_upgrade(env: Env, governance: Address) -> Result<(), SettlementError> {
        Self::require_admin(&env, &governance)?;

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&StorageKey::PendingUpgrade)
            .ok_or(SettlementError::NoPendingUpgrade)?;

        let current_time = env.ledger().timestamp();
        if current_time < pending.scheduled_at + pending.timelock_seconds {
            return Err(SettlementError::TimelockActive);
        }

        let stored_hash: Option<BytesN<32>> = env
            .storage()
            .instance()
            .get(&StorageKey::CodeHash);

        if let Some(ref h) = stored_hash {
            if *h != pending.expected_current_hash {
                return Err(SettlementError::CodeHashMismatch);
            }
        }

        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash.clone());

        env.storage()
            .instance()
            .set(&StorageKey::CodeHash, &pending.wasm_hash);

        env.storage().instance().remove(&StorageKey::PendingUpgrade);

        env.events().publish(
            ("execute_upgrade", governance),
            (pending.wasm_hash,),
        );

        Ok(())
    }

    pub fn migrate(
        env: Env,
        governance: Address,
        from_version: u32,
        to_version: u32,
        cursor: Option<Bytes>,
        limit: u32,
    ) -> Result<Option<Bytes>, SettlementError> {
        Self::require_admin(&env, &governance)?;

        let edge = Self::lookup_migration_edge(env.clone(), from_version, to_version)?;

        match edge.kind {
            MigrationKind::ReadCompatible => {
                env.storage()
                    .instance()
                    .set(&StorageKey::StorageVersion, &to_version);
                env.events()
                    .publish(("migrate", governance), (from_version, to_version));
                Ok(None)
            }
            MigrationKind::OneShot => {
                Self::migrate_oneshot(&env, from_version, to_version)?;
                env.storage()
                    .instance()
                    .set(&StorageKey::StorageVersion, &to_version);
                env.events()
                    .publish(("migrate", governance), (from_version, to_version));
                Ok(None)
            }
            MigrationKind::Batched => {
                let batch_key = StorageKey::MigrationBatch(from_version, to_version);

                let is_first = !env.storage().instance().has(&batch_key);

                let mut progress: MigrationStatus = env
                    .storage()
                    .instance()
                    .get(&batch_key)
                    .unwrap_or(MigrationStatus {
                        is_active: true,
                        from_version,
                        to_version,
                        progress: 0,
                        total_batches: 1,
                        cursor: None,
                    });

                if is_first {
                    env.storage()
                        .instance()
                        .set(&StorageKey::MigrationActive, &true);
                }

                let next_cursor = Self::migrate_batch(
                    &env,
                    from_version,
                    to_version,
                    cursor.unwrap_or(Bytes::new(&env)),
                    limit,
                )?;

                progress.progress += 1;

                if next_cursor.is_none() {
                    progress.is_active = false;
                    env.storage()
                        .instance()
                        .set(&StorageKey::StorageVersion, &to_version);
                    env.storage().instance().remove(&batch_key);
                    env.storage().instance().remove(&StorageKey::MigrationActive);
                } else {
                    progress.cursor = next_cursor.clone();
                    env.storage().instance().set(&batch_key, &progress);
                }

                env.events().publish(
                    ("migrate_batch", governance),
                    (from_version, to_version, progress.progress, next_cursor.is_none()),
                );

                Ok(next_cursor)
            }
        }
    }

    pub fn migration_status(env: Env) -> MigrationStatus {
        let is_active = env.storage().instance().has(&StorageKey::MigrationActive);
        if !is_active {
            return MigrationStatus {
                is_active: false,
                from_version: Self::storage_version(env.clone()),
                to_version: Self::storage_version(env),
                progress: 0,
                total_batches: 0,
                cursor: None,
            };
        }

        env.storage()
            .instance()
            .get(&StorageKey::MigrationBatch(0, 0))
            .unwrap_or(MigrationStatus {
                is_active: true,
                from_version: Self::storage_version(env.clone()),
                to_version: Self::storage_version(env),
                progress: 0,
                total_batches: 1,
                cursor: None,
            })
    }

    pub fn register_migration_edge(
        env: Env,
        governance: Address,
        from_version: u32,
        to_version: u32,
        kind: MigrationKind,
    ) -> Result<(), SettlementError> {
        Self::require_admin(&env, &governance)?;

        let mut registry: soroban_sdk::Map<u32, soroban_sdk::Map<u32, MigrationEdge>> = env
            .storage()
            .instance()
            .get(&StorageKey::MigrationRegistry)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let mut from_map: soroban_sdk::Map<u32, MigrationEdge> = registry
            .get(from_version)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let edge = MigrationEdge {
            from_version,
            to_version,
            kind,
        };

        from_map.set(to_version, edge);
        registry.set(from_version, from_map);

        env.storage()
            .instance()
            .set(&StorageKey::MigrationRegistry, &registry);

        env.events().publish(
            ("register_migration", governance),
            (from_version, to_version),
        );

        Ok(())
    }
}

impl SettlementContract {
    fn lookup_migration_edge(
        env: Env,
        from_version: u32,
        to_version: u32,
    ) -> Result<MigrationEdge, SettlementError> {
        let registry: soroban_sdk::Map<u32, soroban_sdk::Map<u32, MigrationEdge>> = env
            .storage()
            .instance()
            .get(&StorageKey::MigrationRegistry)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let from_map = registry
            .get(from_version)
            .ok_or(SettlementError::MigrationPathNotFound)?;

        from_map
            .get(to_version)
            .ok_or(SettlementError::MigrationPathNotFound)
    }

    fn migrate_oneshot(
        _env: &Env,
        _from_version: u32,
        _to_version: u32,
    ) -> Result<(), SettlementError> {
        Ok(())
    }

    fn migrate_batch(
        _env: &Env,
        _from_version: u32,
        _to_version: u32,
        _cursor: Bytes,
        _limit: u32,
    ) -> Result<Option<Bytes>, SettlementError> {
        Ok(None)
    }
}
