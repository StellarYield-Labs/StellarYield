use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::{Error, OptimisticGovernance};
use crate::storage::DataKey;

#[path = "../../interfaces/upgrade.rs"]
mod upgrade_types;
use upgrade_types::{
    MigrationEdge, MigrationKind, MigrationStatus, PendingUpgrade, UPGRADE_TIMELOCK_SECONDS,
};

const CONTRACT_VERSION: u32 = 1_00_00;
const STORAGE_VERSION: u32 = 1;
const UPGRADE_TIMELOCK: u64 = UPGRADE_TIMELOCK_SECONDS;

impl OptimisticGovernance {

    pub fn contract_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .unwrap_or(CONTRACT_VERSION)
    }

    pub fn storage_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::StorageVersion)
            .unwrap_or(STORAGE_VERSION)
    }

    pub fn schedule_upgrade(
        env: Env,
        governance: Address,
        wasm_hash: BytesN<32>,
        expected_current_hash: BytesN<32>,
        migration_id: u32,
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        governance.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if governance != admin {
            return Err(Error::Unauthorized);
        }

        if env.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(Error::UpgradeAlreadyScheduled);
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
            .set(&DataKey::PendingUpgrade, &pending);

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

    pub fn cancel_upgrade(env: Env, governance: Address) -> Result<(), Error> {
        Self::require_init(&env)?;
        governance.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if governance != admin {
            return Err(Error::Unauthorized);
        }

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(Error::NoPendingUpgrade)?;

        env.storage().instance().remove(&DataKey::PendingUpgrade);

        env.events()
            .publish(("cancel_upgrade", governance), (pending.wasm_hash,));

        Ok(())
    }

    pub fn execute_upgrade(env: Env, governance: Address) -> Result<(), Error> {
        Self::require_init(&env)?;
        governance.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if governance != admin {
            return Err(Error::Unauthorized);
        }

        let pending: PendingUpgrade = env
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(Error::NoPendingUpgrade)?;

        let current_time = env.ledger().timestamp();
        if current_time < pending.scheduled_at + pending.timelock_seconds {
            return Err(Error::ChallengeWindowActive);
        }

        let stored_hash: Option<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::CodeHash);

        if let Some(ref h) = stored_hash {
            if *h != pending.expected_current_hash {
                return Err(Error::CodeHashMismatch);
            }
        }

        env.deployer()
            .update_current_contract_wasm(pending.wasm_hash.clone());

        env.storage()
            .instance()
            .set(&DataKey::CodeHash, &pending.wasm_hash);

        env.storage().instance().remove(&DataKey::PendingUpgrade);

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
    ) -> Result<Option<Bytes>, Error> {
        Self::require_init(&env)?;
        governance.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if governance != admin {
            return Err(Error::Unauthorized);
        }

        let edge = Self::lookup_migration_edge(env.clone(), from_version, to_version)?;

        match edge.kind {
            MigrationKind::ReadCompatible => {
                env.storage()
                    .instance()
                    .set(&DataKey::StorageVersion, &to_version);
                env.events()
                    .publish(("migrate", governance), (from_version, to_version));
                Ok(None)
            }
            MigrationKind::OneShot => {
                Self::migrate_oneshot(&env, from_version, to_version)?;
                env.storage()
                    .instance()
                    .set(&DataKey::StorageVersion, &to_version);
                env.events()
                    .publish(("migrate", governance), (from_version, to_version));
                Ok(None)
            }
            MigrationKind::Batched => {
                let batch_key = DataKey::MigrationBatch(from_version, to_version);

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
                        .set(&DataKey::MigrationActive, &true);
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
                        .set(&DataKey::StorageVersion, &to_version);
                    env.storage().instance().remove(&batch_key);
                    env.storage().instance().remove(&DataKey::MigrationActive);
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
        let is_active = env.storage().instance().has(&DataKey::MigrationActive);
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
            .get(&DataKey::MigrationBatch(0, 0))
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
    ) -> Result<(), Error> {
        Self::require_init(&env)?;
        governance.require_auth();

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if governance != admin {
            return Err(Error::Unauthorized);
        }

        let mut registry: soroban_sdk::Map<u32, soroban_sdk::Map<u32, MigrationEdge>> = env
            .storage()
            .instance()
            .get(&DataKey::MigrationRegistry)
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
            .set(&DataKey::MigrationRegistry, &registry);

        env.events().publish(
            ("register_migration", governance),
            (from_version, to_version),
        );

        Ok(())
    }
}

impl OptimisticGovernance {
    fn lookup_migration_edge(
        env: Env,
        from_version: u32,
        to_version: u32,
    ) -> Result<MigrationEdge, Error> {
        let registry: soroban_sdk::Map<u32, soroban_sdk::Map<u32, MigrationEdge>> = env
            .storage()
            .instance()
            .get(&DataKey::MigrationRegistry)
            .unwrap_or(soroban_sdk::Map::new(&env));

        let from_map = registry
            .get(from_version)
            .ok_or(Error::MigrationPathNotFound)?;

        from_map
            .get(to_version)
            .ok_or(Error::MigrationPathNotFound)
    }

    fn migrate_oneshot(
        _env: &Env,
        _from_version: u32,
        _to_version: u32,
    ) -> Result<(), Error> {
        Ok(())
    }

    fn migrate_batch(
        _env: &Env,
        _from_version: u32,
        _to_version: u32,
        _cursor: Bytes,
        _limit: u32,
    ) -> Result<Option<Bytes>, Error> {
        Ok(None)
    }
}
