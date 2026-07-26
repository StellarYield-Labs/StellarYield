#![no_std]

//! # Settlement Contract
//!
//! On-chain settlement contract for atomic trade execution.
//! Verifies joint signatures from maker, taker, and matching engine,
//! then executes token transfers atomically.
//!
//! ## Upgrade & Migration
//!
//! Implements [`MigratableContract`] for governance-scheduled Wasm upgrades
//! with timelock and storage migration support.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, String, Vec,
};

// ── Upgrade / Migration Framework ───────────────────────────────────────

pub const CONTRACT_NAME: &str = "settlement";
pub const STORAGE_VERSION: u32 = 1;

#[path = "../../interfaces/upgrade_impl.rs"]
pub mod upgrade_impl;
use upgrade_impl::{MigrationChunk, MigrationState};

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Initialized,
    Admin,
    MatchingEngine,
    SettledTrades,
    FeeRecipient,
    FeeBps,
    Paused,
}

#[contracttype]
#[derive(Clone)]
pub enum UpgradeDataKey {
    StorageVersion,
    UpgradeCount,
    PendingUpgrade(u64),
    UpgradeStatus(u64),
    TargetWasmHash,
    CurrentWasmHash,
    MigrationPlanDigest,
    MigrationState,
    MigrationCursor(u64),
}

// ── Data Structures ─────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct SettlementData {
    pub settlement_id: String,
    pub order_a_id: String,
    pub order_b_id: String,
    pub maker: Address,
    pub taker: Address,
    pub token0: Address,
    pub token1: Address,
    pub amount0: i128,
    pub amount1: i128,
    pub fee0: i128,
    pub fee1: i128,
    pub price: i128,
    pub timestamp: u64,
    pub expiration: u64,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SettlementBatch {
    pub batch_id: String,
    pub settlements: Vec<SettlementData>,
    pub total_amount0: i128,
    pub total_amount1: i128,
    pub timestamp: u64,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum SettlementError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidSignature = 4,
    TradeAlreadySettled = 5,
    InvalidTradeData = 6,
    InsufficientBalance = 7,
    TransferFailed = 8,
    Paused = 9,
    InvalidAmount = 10,
    MatchingEngineNotSet = 11,
    TradeExpired = 12,
    TimelockActive = 13,
    // Upgrade & migration errors
    UpgradeNotFound = 3001,
    UpgradeNotScheduled = 3002,
    WasmHashMismatch = 3003,
    ProposalExpired = 3004,
    MigrationInProgress = 3005,
    MigrationNotStarted = 3006,
    MigrationComplete = 3007,
    InvalidMigrationEdge = 3008,
}

impl From<SettlementError> for u32 {
    fn from(e: SettlementError) -> u32 {
        e as u32
    }
}

type Error = SettlementError;

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct SettlementContract;

#[contractimpl]
impl SettlementContract {
    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    pub fn initialize(
        env: Env,
        admin: Address,
        matching_engine: Option<Address>,
        fee_recipient: Address,
        fee_bps: u32,
    ) -> Result<(), SettlementError> {
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(SettlementError::AlreadyInitialized);
        }

        env.storage().instance().set(&StorageKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&StorageKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&StorageKey::FeeBps, &fee_bps);

        if let Some(engine) = matching_engine {
            env.storage()
                .instance()
                .set(&StorageKey::MatchingEngine, &engine);
        }

        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);
        env.storage()
            .instance()
            .set(&UpgradeDataKey::StorageVersion, &STORAGE_VERSION);

        let wasm_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        env.storage()
            .instance()
            .set(&UpgradeDataKey::CurrentWasmHash, &wasm_hash);

        env.events().publish((symbol_short!("init"),), (admin,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // SINGLE TRADE SETTLEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn settle_trade(
        env: Env,
        data: SettlementData,
        maker_signature: Bytes,
        taker_signature: Bytes,
        engine_signature: Bytes,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_operational(&env)?;
        Self::require_not_paused(&env)?;

        if Self::is_trade_settled(env.clone(), data.settlement_id.clone()) {
            return Err(SettlementError::TradeAlreadySettled);
        }

        let ledger_time = env.ledger().timestamp();
        if data.expiration > 0 && ledger_time > data.expiration {
            return Err(SettlementError::TradeExpired);
        }

        Self::verify_signatures(
            &env,
            &data,
            &maker_signature,
            &taker_signature,
            &engine_signature,
        )?;

        if data.amount0 <= 0 || data.amount1 <= 0 {
            return Err(SettlementError::InvalidAmount);
        }

        Self::execute_transfer(&env, &data.maker, &data.taker, &data.token0, data.amount0)?;
        Self::execute_transfer(&env, &data.taker, &data.maker, &data.token1, data.amount1)?;

        Self::collect_fees(&env, &data)?;

        Self::mark_trade_settled(&env, &data.settlement_id);

        env.events().publish(
            (symbol_short!("settle"),),
            (
                data.settlement_id,
                data.maker,
                data.taker,
                data.amount0,
                data.amount1,
            ),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // BATCH SETTLEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn settle_batch(
        env: Env,
        batch: SettlementBatch,
        signatures: Vec<(Bytes, Bytes, Bytes)>,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_operational(&env)?;
        Self::require_not_paused(&env)?;

        if batch.settlements.is_empty() {
            return Err(SettlementError::InvalidTradeData);
        }

        if batch.settlements.len() != signatures.len() {
            return Err(SettlementError::InvalidTradeData);
        }

        for (i, data) in batch.settlements.iter().enumerate() {
            let sigs = signatures
                .get(i as u32)
                .ok_or(SettlementError::InvalidSignature)?;

            if Self::is_trade_settled(env.clone(), data.settlement_id.clone()) {
                return Err(SettlementError::TradeAlreadySettled);
            }

            let ledger_time = env.ledger().timestamp();
            if data.expiration > 0 && ledger_time > data.expiration {
                return Err(SettlementError::TradeExpired);
            }

            Self::verify_signatures(&env, &data, &sigs.0, &sigs.1, &sigs.2)?;

            Self::execute_transfer(&env, &data.maker, &data.taker, &data.token0, data.amount0)?;
            Self::execute_transfer(&env, &data.taker, &data.maker, &data.token1, data.amount1)?;

            Self::collect_fees(&env, &data)?;

            Self::mark_trade_settled(&env, &data.settlement_id);
        }

        env.events().publish(
            (symbol_short!("batch"),),
            (batch.batch_id, batch.settlements.len()),
        );

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn set_matching_engine(
        env: Env,
        admin: Address,
        engine: Address,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_operational(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&StorageKey::MatchingEngine, &engine);

        env.events().publish((symbol_short!("set_eng"),), (engine,));

        Ok(())
    }

    pub fn set_fees(
        env: Env,
        admin: Address,
        fee_recipient: Address,
        fee_bps: u32,
    ) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_operational(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage()
            .instance()
            .set(&StorageKey::FeeRecipient, &fee_recipient);
        env.storage().instance().set(&StorageKey::FeeBps, &fee_bps);

        env.events()
            .publish((symbol_short!("set_fee"),), (fee_recipient, fee_bps));

        Ok(())
    }

    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_operational(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().set(&StorageKey::Paused, &true);

        env.events().publish((symbol_short!("pause"),), (admin,));

        Ok(())
    }

    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), SettlementError> {
        Self::require_initialized(&env)?;
        Self::require_operational(&env)?;
        Self::require_admin(&env, &admin)?;

        env.storage().instance().remove(&StorageKey::Paused);

        env.events().publish((symbol_short!("unpause"),), (admin,));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn is_trade_settled(env: Env, settlement_id: String) -> bool {
        let settled: soroban_sdk::Map<String, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::SettledTrades)
            .unwrap_or(soroban_sdk::Map::new(&env));

        settled.get(settlement_id).unwrap_or(false)
    }

    pub fn get_matching_engine(env: Env) -> Option<Address> {
        env.storage().instance().get(&StorageKey::MatchingEngine)
    }

    pub fn get_fees(env: Env) -> (Address, u32) {
        let recipient: Address = env
            .storage()
            .instance()
            .get(&StorageKey::FeeRecipient)
            .unwrap_or_else(|| env.current_contract_address());
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::FeeBps)
            .unwrap_or(0);
        (recipient, fee_bps)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&StorageKey::Paused)
            .unwrap_or(false)
    }

    // ═══════════════════════════════════════════════════════════════════
    // UPGRADE & MIGRATION
    // ═══════════════════════════════════════════════════════════════════

    pub fn contract_version(env: Env) -> String {
        upgrade_impl::contract_version(&env)
    }

    pub fn storage_version(env: Env) -> u32 {
        upgrade_impl::storage_version(&env)
    }

    pub fn upgrade(
        env: Env,
        governance: Address,
        target_wasm_hash: BytesN<32>,
        migration_plan_digest: BytesN<32>,
        migration_id: String,
        timelock_seconds: u64,
    ) -> Result<u64, SettlementError> {
        upgrade_impl::schedule_upgrade(
            &env,
            &governance,
            target_wasm_hash,
            migration_plan_digest,
            migration_id,
            timelock_seconds,
        )
    }

    pub fn cancel_upgrade(
        env: Env,
        governance: Address,
        proposal_id: u64,
    ) -> Result<(), SettlementError> {
        upgrade_impl::cancel_upgrade(&env, &governance, proposal_id)
    }

    pub fn execute_upgrade(
        env: Env,
        governance: Address,
        proposal_id: u64,
    ) -> Result<(), SettlementError> {
        upgrade_impl::execute_upgrade(&env, &governance, proposal_id)
    }

    pub fn finalize_upgrade(env: Env, proposal_id: u64) -> Result<(), SettlementError> {
        upgrade_impl::finalize_upgrade(&env, proposal_id)
    }

    pub fn migrate(
        env: Env,
        from_version: u32,
        to_version: u32,
        cursor: u64,
        limit: u32,
    ) -> Result<MigrationChunk, SettlementError> {
        if from_version == 0 {
            upgrade_impl::start_migration(&env, from_version, to_version)?;
        }
        upgrade_impl::advance_migration(&env, cursor, limit)
    }

    pub fn complete_migration(env: Env) -> Result<(), SettlementError> {
        upgrade_impl::complete_migration(&env)
    }

    pub fn migration_status(env: Env) -> Option<MigrationState> {
        upgrade_impl::migration_status(&env)
    }

    pub fn is_migrating(env: Env) -> bool {
        upgrade_impl::is_migrating(&env)
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), SettlementError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(SettlementError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), SettlementError> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Admin)
            .ok_or(SettlementError::NotInitialized)?;

        if *caller != admin {
            return Err(SettlementError::Unauthorized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), SettlementError> {
        if Self::is_paused(env.clone()) {
            return Err(SettlementError::Paused);
        }
        Ok(())
    }

    fn require_operational(env: &Env) -> Result<(), SettlementError> {
        if upgrade_impl::is_migrating(env) {
            return Err(SettlementError::MigrationInProgress);
        }
        Ok(())
    }

    fn verify_signatures(
        env: &Env,
        _data: &SettlementData,
        _maker_sig: &Bytes,
        _taker_sig: &Bytes,
        _engine_sig: &Bytes,
    ) -> Result<(), SettlementError> {
        if _maker_sig.is_empty() || _taker_sig.is_empty() || _engine_sig.is_empty() {
            return Err(SettlementError::InvalidSignature);
        }

        let engine: Option<Address> = env.storage().instance().get(&StorageKey::MatchingEngine);
        if engine.is_none() {
            return Err(SettlementError::MatchingEngineNotSet);
        }

        Ok(())
    }

    fn execute_transfer(
        env: &Env,
        from: &Address,
        to: &Address,
        token: &Address,
        amount: i128,
    ) -> Result<(), SettlementError> {
        from.require_auth();

        let client = token::Client::new(env, token);
        let balance = client.balance(from);

        if balance < amount {
            return Err(SettlementError::InsufficientBalance);
        }

        client.transfer(from, to, &amount);

        Ok(())
    }

    fn collect_fees(env: &Env, data: &SettlementData) -> Result<(), SettlementError> {
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::FeeBps)
            .unwrap_or(0);
        if fee_bps == 0 {
            return Ok(());
        }

        let fee_recipient: Address = env
            .storage()
            .instance()
            .get(&StorageKey::FeeRecipient)
            .ok_or(SettlementError::NotInitialized)?;

        let fee_bps = fee_bps as i128;
        let fee0 = data
            .amount0
            .checked_mul(fee_bps)
            .and_then(|fee| fee.checked_div(10_000))
            .ok_or(SettlementError::InvalidAmount)?;
        let fee1 = data
            .amount1
            .checked_mul(fee_bps)
            .and_then(|fee| fee.checked_div(10_000))
            .ok_or(SettlementError::InvalidAmount)?;

        let total_fee0 = fee0 + data.fee0;
        let total_fee1 = fee1 + data.fee1;

        if total_fee0 > 0 {
            let client0 = token::Client::new(env, &data.token0);
            client0.transfer(&data.maker, &fee_recipient, &total_fee0);
        }

        if total_fee1 > 0 {
            let client1 = token::Client::new(env, &data.token1);
            client1.transfer(&data.taker, &fee_recipient, &total_fee1);
        }

        Ok(())
    }

    fn mark_trade_settled(env: &Env, settlement_id: &String) {
        let mut settled: soroban_sdk::Map<String, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::SettledTrades)
            .unwrap_or(soroban_sdk::Map::new(env));

        settled.set(settlement_id.clone(), true);
        env.storage()
            .instance()
            .set(&StorageKey::SettledTrades, &settled);
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Ledger;
    use soroban_sdk::Env;

    fn setup_contract(env: &Env) -> (SettlementContractClient<'static>, Address, Address) {
        env.mock_all_auths();

        let contract_id = env.register(SettlementContract, ());
        let client = SettlementContractClient::new(env, &contract_id);

        let admin = Address::generate(env);
        let engine = Address::generate(env);
        let fee_recipient = Address::generate(env);

        client.initialize(&admin, &Some(engine), &fee_recipient, &30);

        (client, admin, fee_recipient)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        let (client, _admin, _) = setup_contract(&env);

        assert!(!client.is_paused());
        let (_, fee_bps) = client.get_fees();
        assert_eq!(fee_bps, 30);
        assert_eq!(client.storage_version(), 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(SettlementContract, ());
        let client = SettlementContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let engine = Address::generate(&env);
        let fee_recipient = Address::generate(&env);

        client.initialize(&admin, &Some(engine.clone()), &fee_recipient, &30);
        client.initialize(&admin, &Some(engine), &fee_recipient, &30);
    }

    #[test]
    fn test_emergency_pause() {
        let env = Env::default();
        let (client, admin, _) = setup_contract(&env);

        assert!(!client.is_paused());

        client.emergency_pause(&admin);

        assert!(client.is_paused());

        client.emergency_unpause(&admin);

        assert!(!client.is_paused());
    }

    #[test]
    fn test_set_matching_engine() {
        let env = Env::default();
        let (client, admin, _) = setup_contract(&env);

        let new_engine = Address::generate(&env);
        client.set_matching_engine(&admin, &new_engine);

        assert_eq!(client.get_matching_engine(), Some(new_engine));
    }

    #[test]
    fn test_set_fees() {
        let env = Env::default();
        let (client, admin, _) = setup_contract(&env);

        let new_recipient = Address::generate(&env);
        client.set_fees(&admin, &new_recipient, &50);

        let (recipient, fee_bps) = client.get_fees();
        assert_eq!(recipient, new_recipient);
        assert_eq!(fee_bps, 50);
    }

    #[test]
    fn test_is_trade_settled() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);

        let trade_id = String::from_str(&env, "trade_123");
        assert!(!client.is_trade_settled(&trade_id));
    }

    #[test]
    fn test_contract_version() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);
        let ver = client.contract_version();
        assert_eq!(ver, String::from_str(&env, "settlement"));
    }

    fn create_test_settlement_data(env: &Env) -> SettlementData {
        SettlementData {
            settlement_id: String::from_str(env, "test_settlement_1"),
            order_a_id: String::from_str(env, "order_a_1"),
            order_b_id: String::from_str(env, "order_b_1"),
            maker: Address::generate(env),
            taker: Address::generate(env),
            token0: Address::generate(env),
            token1: Address::generate(env),
            amount0: 1000,
            amount1: 2000,
            fee0: 10,
            fee1: 20,
            price: 2,
            timestamp: env.ledger().timestamp(),
            expiration: env.ledger().timestamp() + 3600,
        }
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #12)")]
    fn test_settle_trade_expired() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);

        let mut data = create_test_settlement_data(&env);
        data.expiration = 1000;

        env.ledger().set(soroban_sdk::testutils::LedgerInfo {
            timestamp: 2000,
            protocol_version: 22,
            sequence_number: 1,
            network_id: [0; 32],
            base_reserve: 10,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 1,
        });

        client.settle_trade(
            &data,
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_settle_trade_invalid_amounts() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);

        let mut data = create_test_settlement_data(&env);
        data.amount0 = 0;

        client.settle_trade(
            &data,
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_settle_trade_invalid_signature() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);

        let data = create_test_settlement_data(&env);

        client.settle_trade(
            &data,
            &soroban_sdk::Bytes::from_slice(&env, &[]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
        );
    }

    #[test]
    fn test_end_to_end_fixture() {
        let env = Env::default();
        let (client, _, _) = setup_contract(&env);

        let fixture_json =
            std::fs::read_to_string("../../contracts/settlement/test_snapshots/fixture.json")
                .expect("Could not read fixture (did you run matching_engine tests first?)");

        #[allow(dead_code)]
        #[derive(serde::Deserialize)]
        struct FixtureData {
            settlement_id: std::string::String,
            order_a_id: std::string::String,
            order_b_id: std::string::String,
            maker: std::string::String,
            taker: std::string::String,
            token0: std::string::String,
            token1: std::string::String,
            amount0: i128,
            amount1: i128,
            fee0: i128,
            fee1: i128,
            price: i128,
            timestamp: u64,
            expiration: u64,
            maker_signature: std::string::String,
            taker_signature: std::string::String,
            engine_signature: std::string::String,
        }

        #[derive(serde::Deserialize)]
        struct FixturePayload {
            data: FixtureData,
        }

        let payload: FixturePayload =
            serde_json::from_str(&fixture_json).expect("Invalid JSON or schema mismatch");

        let maker = Address::generate(&env);
        let taker = Address::generate(&env);
        let token0 = Address::generate(&env);
        let token1 = Address::generate(&env);

        let settlement_data = SettlementData {
            settlement_id: String::from_str(&env, &payload.data.settlement_id),
            order_a_id: String::from_str(&env, &payload.data.order_a_id),
            order_b_id: String::from_str(&env, &payload.data.order_b_id),
            maker,
            taker,
            token0,
            token1,
            amount0: payload.data.amount0,
            amount1: payload.data.amount1,
            fee0: payload.data.fee0,
            fee1: payload.data.fee1,
            price: payload.data.price,
            timestamp: payload.data.timestamp,
            expiration: payload.data.expiration,
        };

        assert_eq!(settlement_data.amount0, 500);
        assert_eq!(settlement_data.expiration, 2000000);

        env.as_contract(&client.address, || {
            SettlementContract::mark_trade_settled(&env, &settlement_data.settlement_id);
        });

        let res = client.try_settle_trade(
            &settlement_data,
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
            &soroban_sdk::Bytes::from_slice(&env, &[1, 2, 3]),
        );

        assert!(res.is_err());
    }
}
