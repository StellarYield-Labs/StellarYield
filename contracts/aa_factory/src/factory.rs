//! # Smart Wallet Factory
//!
//! A factory contract for deploying programmable smart contract wallets (proxies)
//! that enable Account Abstraction on Soroban.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    IntoVal, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Initialized,
    Admin,
    ProxyCodeHash,
    DeployedProxies,
    Relayer,
    DeploymentCount,
    UserProxy(Address),
    OwnerSalt(Address, BytesN<32>),
    ProxyInfo(Address),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct DeploymentConfig {
    pub owner: Address,
    pub relayer: Option<Address>,
    pub salt: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProxyInfo {
    pub proxy_address: Address,
    pub owner: Address,
    pub deployed_at: u64,
    pub salt: u64,
    pub salt_hash: BytesN<32>,
    pub relayer: Option<Address>,
    pub network_id: BytesN<32>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    DeploymentFailed = 4,
    ProxyAlreadyExists = 5,
    InvalidConfig = 6,
    ProxyNotFound = 7,
    InvalidCodeHash = 8,
}

#[contract]
pub struct WalletFactory;

#[contractimpl]
impl WalletFactory {
    pub fn initialize(
        env: Env,
        admin: Address,
        proxy_code_hash: BytesN<32>,
    ) -> Result<(), FactoryError> {
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(FactoryError::AlreadyInitialized);
        }
        if Self::is_zero_hash(&proxy_code_hash) {
            return Err(FactoryError::InvalidCodeHash);
        }

        env.storage().instance().set(&StorageKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&StorageKey::ProxyCodeHash, &proxy_code_hash);
        env.storage()
            .instance()
            .set(&StorageKey::DeployedProxies, &Vec::<Address>::new(&env));
        env.storage()
            .instance()
            .set(&StorageKey::DeploymentCount, &0u32);
        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);

        env.events().publish((symbol_short!("init"),), (admin,));
        Ok(())
    }

    pub fn deploy_proxy(env: Env, config: DeploymentConfig) -> Result<Address, FactoryError> {
        Self::require_initialized(&env)?;
        config.owner.require_auth();

        let proxy_code_hash = Self::get_proxy_code_hash(env.clone())?;
        let network_id = env.ledger().network_id();
        let salt_hash = Self::derive_deployment_salt(&env, &config.owner, config.salt);
        let predicted_address = Self::predict_proxy_address(&env, &salt_hash);

        if let Some(existing) =
            env.storage()
                .instance()
                .get::<StorageKey, Address>(&StorageKey::OwnerSalt(
                    config.owner.clone(),
                    salt_hash.clone(),
                ))
        {
            return Ok(existing);
        }

        if let Some(existing_proxy) = env
            .storage()
            .instance()
            .get::<StorageKey, Address>(&StorageKey::UserProxy(config.owner.clone()))
        {
            let existing_info: ProxyInfo = env
                .storage()
                .instance()
                .get(&StorageKey::ProxyInfo(existing_proxy.clone()))
                .ok_or(FactoryError::ProxyNotFound)?;
            if existing_info.salt_hash == salt_hash {
                return Ok(existing_proxy);
            }
            return Err(FactoryError::ProxyAlreadyExists);
        }

        let proxy_address = Self::deploy_proxy_contract(&env, &proxy_code_hash, &salt_hash)?;
        if proxy_address != predicted_address {
            return Err(FactoryError::DeploymentFailed);
        }

        let init_args = soroban_sdk::vec![
            &env,
            config.owner.clone().into_val(&env),
            env.current_contract_address().into_val(&env),
            config.relayer.clone().into_val(&env),
            network_id.clone().into_val(&env)
        ];
        let _: () =
            env.invoke_contract(&proxy_address, &Symbol::new(&env, "initialize"), init_args);

        let proxy_info = ProxyInfo {
            proxy_address: proxy_address.clone(),
            owner: config.owner.clone(),
            deployed_at: env.ledger().timestamp(),
            salt: config.salt,
            salt_hash: salt_hash.clone(),
            relayer: config.relayer.clone(),
            network_id: network_id.clone(),
        };

        env.storage()
            .instance()
            .set(&StorageKey::UserProxy(config.owner.clone()), &proxy_address);
        env.storage().instance().set(
            &StorageKey::OwnerSalt(config.owner.clone(), salt_hash.clone()),
            &proxy_address,
        );
        env.storage()
            .instance()
            .set(&StorageKey::ProxyInfo(proxy_address.clone()), &proxy_info);

        let mut deployed: Vec<Address> = env
            .storage()
            .instance()
            .get(&StorageKey::DeployedProxies)
            .unwrap_or(Vec::new(&env));
        deployed.push_back(proxy_address.clone());
        env.storage()
            .instance()
            .set(&StorageKey::DeployedProxies, &deployed);

        let count: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::DeploymentCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&StorageKey::DeploymentCount, &(count + 1));

        env.events().publish(
            (symbol_short!("deploy"), config.owner, salt_hash),
            (proxy_address.clone(), config.salt, network_id),
        );

        Ok(proxy_address)
    }

    pub fn deploy_proxy_deterministic(
        env: Env,
        owner: Address,
        salt: u64,
        relayer: Option<Address>,
    ) -> Result<Address, FactoryError> {
        Self::deploy_proxy(
            env,
            DeploymentConfig {
                owner,
                relayer,
                salt,
            },
        )
    }

    pub fn wire_recovery(
        env: Env,
        owner: Address,
        proxy: Address,
        recovery: Address,
    ) -> Result<(), FactoryError> {
        Self::require_initialized(&env)?;
        owner.require_auth();

        let _: () = env.invoke_contract(
            &proxy,
            &Symbol::new(&env, "link_recovery"),
            soroban_sdk::vec![
                &env,
                owner.clone().into_val(&env),
                recovery.clone().into_val(&env)
            ],
        );

        let _: () = env.invoke_contract(
            &recovery,
            &Symbol::new(&env, "link_proxy"),
            soroban_sdk::vec![&env, owner.into_val(&env), proxy.clone().into_val(&env)],
        );

        env.events()
            .publish((symbol_short!("wire_rec"),), (proxy, recovery));
        Ok(())
    }

    pub fn set_relayer(env: Env, admin: Address, relayer: Address) -> Result<(), FactoryError> {
        Self::require_initialized(&env)?;
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&StorageKey::Relayer, &relayer);
        env.events()
            .publish((symbol_short!("set_rel"),), (relayer,));
        Ok(())
    }

    pub fn get_relayer(env: Env) -> Result<Option<Address>, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Relayer))
    }

    pub fn get_proxy_for_user(env: Env, user: Address) -> Result<Option<Address>, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::UserProxy(user)))
    }

    pub fn get_all_proxies(env: Env) -> Result<Vec<Address>, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::DeployedProxies)
            .unwrap_or(Vec::new(&env)))
    }

    pub fn get_proxy_count(env: Env) -> Result<u32, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get::<StorageKey, u32>(&StorageKey::DeploymentCount)
            .unwrap_or(0))
    }

    pub fn get_proxy_info(env: Env, proxy_address: Address) -> Result<ProxyInfo, FactoryError> {
        Self::require_initialized(&env)?;
        env.storage()
            .instance()
            .get(&StorageKey::ProxyInfo(proxy_address))
            .ok_or(FactoryError::ProxyNotFound)
    }

    pub fn get_proxy_code_hash(env: Env) -> Result<BytesN<32>, FactoryError> {
        Self::require_initialized(&env)?;
        env.storage()
            .instance()
            .get(&StorageKey::ProxyCodeHash)
            .ok_or(FactoryError::InvalidCodeHash)
    }

    pub fn get_admin(env: Env) -> Result<Address, FactoryError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Admin).unwrap())
    }

    pub fn compute_proxy_address(
        env: Env,
        owner: Address,
        salt: u64,
    ) -> Result<Address, FactoryError> {
        Self::require_initialized(&env)?;
        let salt_hash = Self::derive_deployment_salt(&env, &owner, salt);
        Ok(Self::predict_proxy_address(&env, &salt_hash))
    }

    fn require_initialized(env: &Env) -> Result<(), FactoryError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(FactoryError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), FactoryError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .ok_or(FactoryError::NotInitialized)?;
        if *caller != admin {
            return Err(FactoryError::Unauthorized);
        }
        Ok(())
    }

    fn derive_deployment_salt(env: &Env, owner: &Address, salt: u64) -> BytesN<32> {
        let mut payload = Bytes::new(env);
        payload.extend_from_slice(b"stellaryield_aa_proxy_v1");
        payload.append(&Self::address_bytes(env, env.current_contract_address()));
        payload.append(&Self::address_bytes(env, owner.clone()));
        payload.append(&Bytes::from_slice(env, &salt.to_be_bytes()));
        payload.append(&env.ledger().network_id().into());
        env.crypto().sha256(&payload).to_bytes()
    }

    fn predict_proxy_address(env: &Env, salt_hash: &BytesN<32>) -> Address {
        env.deployer()
            .with_current_contract(salt_hash.clone())
            .deployed_address()
    }

    fn deploy_proxy_contract(
        env: &Env,
        proxy_code_hash: &BytesN<32>,
        salt_hash: &BytesN<32>,
    ) -> Result<Address, FactoryError> {
        if Self::is_zero_hash(proxy_code_hash) {
            return Err(FactoryError::InvalidCodeHash);
        }

        #[cfg(test)]
        {
            let contract_id = Self::predict_proxy_address(env, salt_hash);
            env.register_at(&contract_id, aa_proxy::ProxyWallet, ());
            Ok(contract_id)
        }

        #[cfg(not(test))]
        {
            Ok(env
                .deployer()
                .with_current_contract(salt_hash.clone())
                .deploy_v2(proxy_code_hash.clone(), ()))
        }
    }

    fn address_bytes(env: &Env, address: Address) -> Bytes {
        let string = address.to_string();
        let len = string.len() as usize;
        let mut buffer = [0u8; 128];
        string.copy_into_slice(&mut buffer[..len]);
        Bytes::from_slice(env, &buffer[..len])
    }

    fn is_zero_hash(hash: &BytesN<32>) -> bool {
        hash.to_array().iter().all(|byte| *byte == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aa_proxy::{P256PublicKey, ProxyWalletClient, UserOperation};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env};

    #[contract]
    struct DummyTarget;

    #[contractimpl]
    impl DummyTarget {
        pub fn bump(env: Env) -> u32 {
            let key = symbol_short!("count");
            let next = env
                .storage()
                .instance()
                .get::<Symbol, u32>(&key)
                .unwrap_or(0)
                + 1;
            env.storage().instance().set(&key, &next);
            next
        }

        pub fn get(env: Env) -> u32 {
            env.storage()
                .instance()
                .get::<Symbol, u32>(&symbol_short!("count"))
                .unwrap_or(0)
        }
    }

    const TEST_PRIV: [u8; 32] = [
        0xC9, 0xAF, 0xA9, 0xD8, 0x45, 0xBA, 0x75, 0x16, 0x6B, 0x5C, 0x21, 0x57, 0x67, 0xB1, 0xD6,
        0x93, 0x4E, 0x50, 0xC3, 0xDB, 0x36, 0xE8, 0x9B, 0x12, 0x7B, 0x8A, 0x62, 0x2B, 0x12, 0x0F,
        0x67, 0x21,
    ];

    fn p256_sign(digest: &[u8; 32]) -> [u8; 64] {
        use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};

        let sk = SigningKey::from_bytes(TEST_PRIV.as_ref().into()).expect("valid key");
        let sig: Signature = sk.sign_prehash(digest).expect("sign");
        let sig = sig.normalize_s().unwrap_or(sig);
        let mut out = [0u8; 64];
        out.copy_from_slice(&sig.to_bytes());
        out
    }

    fn testnet_network_id(env: &Env) -> BytesN<32> {
        let passphrase = Bytes::from_slice(env, b"Test SDF Network ; September 2015");
        env.crypto().sha256(&passphrase).to_bytes()
    }

    fn test_pubkey(env: &Env) -> P256PublicKey {
        P256PublicKey {
            x: BytesN::from_array(
                env,
                &[
                    0x60, 0xFE, 0xD4, 0xBA, 0x25, 0x5A, 0x9D, 0x31, 0xC9, 0x61, 0xEB, 0x74, 0xC6,
                    0x35, 0x6D, 0x68, 0xC0, 0x49, 0xB8, 0x92, 0x3B, 0x61, 0xFA, 0x6C, 0xE6, 0x69,
                    0x62, 0x2E, 0x60, 0xF2, 0x9F, 0xB6,
                ],
            ),
            y: BytesN::from_array(
                env,
                &[
                    0x79, 0x03, 0xFE, 0x10, 0x08, 0xB8, 0xBC, 0x99, 0xA4, 0x1A, 0xE9, 0xE9, 0x56,
                    0x28, 0xBC, 0x64, 0xF2, 0xF1, 0xB2, 0x0C, 0x2D, 0x7E, 0x9F, 0x51, 0x77, 0xA3,
                    0xC2, 0x94, 0xD4, 0x46, 0x22, 0x99,
                ],
            ),
        }
    }

    fn build_op_digest(env: &Env, op: &UserOperation) -> BytesN<32> {
        let mut pre = Bytes::new(env);
        pre.append(&Bytes::from_slice(
            env,
            b"stellaryield_webauthn_v1\x00\x00\x00\x00\x00\x00\x00\x00",
        ));
        pre.append(
            &env.crypto()
                .sha256(&address_bytes(env, op.sender.clone()))
                .to_bytes()
                .into(),
        );
        pre.append(&Bytes::from_slice(env, &op.nonce.to_be_bytes()));
        pre.append(
            &env.crypto()
                .sha256(&address_bytes(env, op.call_target.clone()))
                .to_bytes()
                .into(),
        );
        pre.append(&env.crypto().sha256(&op.call_data).to_bytes().into());
        pre.append(&Bytes::from_slice(env, &op.expiry.to_be_bytes()));
        pre.append(&op.network_id.clone().into());
        env.crypto().sha256(&pre).to_bytes()
    }

    fn address_bytes(env: &Env, address: Address) -> Bytes {
        let string = address.to_string();
        let len = string.len() as usize;
        let mut buffer = [0u8; 128];
        string.copy_into_slice(&mut buffer[..len]);
        Bytes::from_slice(env, &buffer[..len])
    }

    fn real_sig(env: &Env, op: &UserOperation) -> BytesN<64> {
        let digest = build_op_digest(env, op).to_array();
        BytesN::from_array(env, &p256_sign(&digest))
    }

    fn setup_factory(env: &Env) -> (WalletFactoryClient<'static>, Address) {
        env.mock_all_auths();
        env.ledger()
            .set_network_id(testnet_network_id(env).to_array());
        let contract_id = env.register(WalletFactory, ());
        let client = WalletFactoryClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin, &BytesN::from_array(env, &[1u8; 32]));
        (client, admin)
    }

    #[test]
    fn test_initialize_and_metadata() {
        let env = Env::default();
        let (client, admin) = setup_factory(&env);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_proxy_count(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_initialize_rejects_zero_proxy_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(WalletFactory, ());
        let client = WalletFactoryClient::new(&env, &contract_id);
        client.initialize(
            &Address::generate(&env),
            &BytesN::from_array(&env, &[0u8; 32]),
        );
    }

    #[test]
    fn test_compute_proxy_address_matches_deployment() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        let owner = Address::generate(&env);
        let predicted = client.compute_proxy_address(&owner, &7u64);
        let deployed = client.deploy_proxy(&DeploymentConfig {
            owner,
            relayer: None,
            salt: 7,
        });
        assert_eq!(predicted, deployed);
    }

    #[test]
    fn test_deploy_proxy_records_info() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        let owner = Address::generate(&env);
        let relayer = Address::generate(&env);

        let proxy = client.deploy_proxy(&DeploymentConfig {
            owner: owner.clone(),
            relayer: Some(relayer.clone()),
            salt: 42,
        });

        assert_eq!(client.get_proxy_count(), 1);
        assert_eq!(client.get_proxy_for_user(&owner), Some(proxy.clone()));

        let info = client.get_proxy_info(&proxy);
        assert_eq!(info.owner, owner);
        assert_eq!(info.relayer, Some(relayer));
        assert_eq!(info.salt, 42);
        assert_eq!(info.network_id, testnet_network_id(&env));
    }

    #[test]
    fn test_duplicate_same_owner_and_salt_returns_existing_proxy() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        let owner = Address::generate(&env);
        let config = DeploymentConfig {
            owner,
            relayer: None,
            salt: 11,
        };

        let first = client.deploy_proxy(&config);
        let second = client.deploy_proxy(&config);

        assert_eq!(first, second);
        assert_eq!(client.get_proxy_count(), 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_duplicate_owner_with_different_salt_panics() {
        let env = Env::default();
        let (client, _) = setup_factory(&env);
        let owner = Address::generate(&env);

        client.deploy_proxy(&DeploymentConfig {
            owner: owner.clone(),
            relayer: None,
            salt: 1,
        });

        client.deploy_proxy(&DeploymentConfig {
            owner,
            relayer: None,
            salt: 2,
        });
    }

    #[test]
    fn test_deployed_proxy_executes_authorized_user_operation() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, _) = setup_factory(&env);
        let owner = Address::generate(&env);
        let relayer = Address::generate(&env);

        let proxy = client.deploy_proxy(&DeploymentConfig {
            owner: owner.clone(),
            relayer: Some(relayer.clone()),
            salt: 5,
        });

        let proxy_client = ProxyWalletClient::new(&env, &proxy);
        proxy_client.register_webauthn_key(&owner, &test_pubkey(&env));

        let target = env.register(DummyTarget, ());
        let mut op = UserOperation {
            sender: proxy.clone(),
            nonce: 0,
            call_data: Bytes::from_slice(&env, b"bump"),
            call_target: target.clone(),
            signature: BytesN::from_array(&env, &[0u8; 64]),
            max_fee: 1000,
            expiry: 9999,
            network_id: testnet_network_id(&env),
        };
        op.signature = real_sig(&env, &op);

        let result = proxy_client.execute_user_operation(&op, &relayer);
        assert!(result.success);

        let dummy = DummyTargetClient::new(&env, &target);
        assert_eq!(dummy.get(), 1);
    }
}
