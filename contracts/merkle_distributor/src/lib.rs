#![no_std]

//! # MerkleDistributor — Efficient On-Chain Rewards Distribution
//!
//! Stores a Merkle root and allows users to claim rewards by presenting
//! a proof for a canonical leaf:
//! `sha256(recipient || token || amount || campaign_id || metadata_hash)`.
//! Claims are tracked per `(campaign_id, recipient)` to prevent duplicate
//! withdrawals while allowing the same address to participate in later campaigns.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    Vec,
};

#[contracttype]
enum DataKey {
    Admin,
    Token,
    MerkleRoot,
    Initialized,
    CampaignId,
    TotalClaimed,
    Claimed(u32, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DistributorError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ZeroAmount = 4,
    AlreadyClaimed = 5,
    InvalidProof = 6,
    NoMerkleRoot = 7,
    InsufficientBalance = 8,
    InvalidCampaign = 9,
}

#[contract]
pub struct MerkleDistributor;

#[contractimpl]
impl MerkleDistributor {
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), DistributorError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(DistributorError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::CampaignId, &0u32);
        env.storage().instance().set(&DataKey::TotalClaimed, &0i128);
        env.storage().instance().set(&DataKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("init"),), (admin.clone(), token.clone()));

        Ok(())
    }

    pub fn set_merkle_root(
        env: Env,
        admin: Address,
        campaign_id: u32,
        merkle_root: BytesN<32>,
    ) -> Result<(), DistributorError> {
        Self::require_admin(&env, &admin)?;

        let current_campaign_id = Self::get_campaign_id_internal(&env);
        if campaign_id <= current_campaign_id {
            return Err(DistributorError::InvalidCampaign);
        }

        env.storage()
            .instance()
            .set(&DataKey::MerkleRoot, &merkle_root);
        env.storage()
            .instance()
            .set(&DataKey::CampaignId, &campaign_id);
        env.storage().instance().set(&DataKey::TotalClaimed, &0i128);

        env.events()
            .publish((symbol_short!("new_root"),), (campaign_id, merkle_root));

        Ok(())
    }

    pub fn claim(
        env: Env,
        claimant: Address,
        token_addr: Address,
        amount: i128,
        campaign_id: u32,
        metadata_hash: BytesN<32>,
        proof: Vec<BytesN<32>>,
    ) -> Result<i128, DistributorError> {
        Self::require_init(&env)?;
        claimant.require_auth();

        if amount <= 0 {
            return Err(DistributorError::ZeroAmount);
        }

        let current_campaign_id = Self::get_campaign_id_internal(&env);
        if campaign_id == 0 || campaign_id != current_campaign_id {
            return Err(DistributorError::InvalidCampaign);
        }

        if Self::is_claimed_internal(&env, campaign_id, &claimant) {
            return Err(DistributorError::AlreadyClaimed);
        }

        let merkle_root: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .ok_or(DistributorError::NoMerkleRoot)?;
        let reward_token: Address = env.storage().instance().get(&DataKey::Token).unwrap();

        if token_addr != reward_token {
            return Err(DistributorError::InvalidProof);
        }

        let leaf = Self::compute_leaf(
            &env,
            &claimant,
            &token_addr,
            amount,
            campaign_id,
            &metadata_hash,
        );
        if !Self::verify_proof(&env, &proof, &merkle_root, &leaf) {
            return Err(DistributorError::InvalidProof);
        }

        let client = token::Client::new(&env, &reward_token);
        let contract_balance = client.balance(&env.current_contract_address());
        if contract_balance < amount {
            return Err(DistributorError::InsufficientBalance);
        }

        Self::set_claimed(&env, campaign_id, &claimant);
        client.transfer(&env.current_contract_address(), &claimant, &amount);

        let total_claimed: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalClaimed)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalClaimed, &(total_claimed + amount));

        env.events()
            .publish((symbol_short!("claim"),), (claimant, campaign_id, amount));

        Ok(amount)
    }

    pub fn is_claimed(env: Env, campaign_id: u32, claimant: Address) -> bool {
        Self::is_claimed_internal(&env, campaign_id, &claimant)
    }

    pub fn get_merkle_root(env: Env) -> Result<BytesN<32>, DistributorError> {
        Self::require_init(&env)?;
        env.storage()
            .instance()
            .get(&DataKey::MerkleRoot)
            .ok_or(DistributorError::NoMerkleRoot)
    }

    pub fn get_campaign_id(env: Env) -> u32 {
        Self::get_campaign_id_internal(&env)
    }

    pub fn get_epoch(env: Env) -> u32 {
        Self::get_campaign_id_internal(&env)
    }

    pub fn get_total_claimed(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalClaimed)
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Result<Address, DistributorError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Admin).unwrap())
    }

    pub fn get_token(env: Env) -> Result<Address, DistributorError> {
        Self::require_init(&env)?;
        Ok(env.storage().instance().get(&DataKey::Token).unwrap())
    }

    fn get_campaign_id_internal(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CampaignId)
            .unwrap_or(0)
    }

    fn compute_leaf(
        env: &Env,
        account: &Address,
        token_addr: &Address,
        amount: i128,
        campaign_id: u32,
        metadata_hash: &BytesN<32>,
    ) -> BytesN<32> {
        let mut data = soroban_sdk::Bytes::new(env);
        Self::append_address_bytes(env, &mut data, account);
        Self::append_address_bytes(env, &mut data, token_addr);
        data.append(&soroban_sdk::Bytes::from_array(env, &amount.to_be_bytes()));
        data.append(&soroban_sdk::Bytes::from_array(
            env,
            &campaign_id.to_be_bytes(),
        ));
        data.append(&soroban_sdk::Bytes::from_array(
            env,
            &metadata_hash.to_array(),
        ));
        env.crypto().sha256(&data).into()
    }

    fn append_address_bytes(env: &Env, data: &mut soroban_sdk::Bytes, address: &Address) {
        let address_str = address.to_string();
        let len = address_str.len() as usize;
        let mut buf = [0u8; 64];
        address_str.copy_into_slice(&mut buf[..len]);
        data.append(&soroban_sdk::Bytes::from_slice(env, &buf[..len]));
    }

    fn verify_proof(
        env: &Env,
        proof: &Vec<BytesN<32>>,
        root: &BytesN<32>,
        leaf: &BytesN<32>,
    ) -> bool {
        let mut computed = leaf.clone();

        for i in 0..proof.len() {
            let proof_element = proof.get(i).unwrap();
            computed = Self::hash_pair(env, &computed, &proof_element);
        }

        computed == *root
    }

    fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
        let mut data = soroban_sdk::Bytes::new(env);
        if a.to_array() <= b.to_array() {
            data.append(&soroban_sdk::Bytes::from_array(env, &a.to_array()));
            data.append(&soroban_sdk::Bytes::from_array(env, &b.to_array()));
        } else {
            data.append(&soroban_sdk::Bytes::from_array(env, &b.to_array()));
            data.append(&soroban_sdk::Bytes::from_array(env, &a.to_array()));
        }
        env.crypto().sha256(&data).into()
    }

    fn is_claimed_internal(env: &Env, campaign_id: u32, claimant: &Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Claimed(campaign_id, claimant.clone()))
    }

    fn set_claimed(env: &Env, campaign_id: u32, claimant: &Address) {
        env.storage()
            .persistent()
            .set(&DataKey::Claimed(campaign_id, claimant.clone()), &true);
    }

    fn require_init(env: &Env) -> Result<(), DistributorError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(DistributorError::NotInitialized);
        }
        Ok(())
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), DistributorError> {
        Self::require_init(env)?;
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(DistributorError::NotInitialized)?;
        if *caller != admin {
            return Err(DistributorError::Unauthorized);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use serde::Deserialize;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    struct SharedFixture {
        distribution: SharedDistribution,
        root: std::string::String,
        claims: BTreeMap<std::string::String, SharedClaim>,
    }

    #[derive(Deserialize)]
    struct SharedDistribution {
        token: std::string::String,
        #[serde(rename = "campaignId")]
        campaign_id: u32,
        #[serde(rename = "metadataHash")]
        metadata_hash: std::string::String,
    }

    #[derive(Deserialize)]
    struct SharedClaim {
        address: std::string::String,
        token: std::string::String,
        amount: std::string::String,
        #[serde(rename = "campaignId")]
        campaign_id: u32,
        #[serde(rename = "metadataHash")]
        metadata_hash: std::string::String,
        leaf: std::string::String,
        proof: std::vec::Vec<std::string::String>,
    }

    fn setup_env() -> (
        Env,
        MerkleDistributorClient<'static>,
        Address,
        Address,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(MerkleDistributor, ());
        let client = MerkleDistributorClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_addr = token_contract.address();

        client.initialize(&admin, &token_addr);

        (env, client, admin, token_addr, token_admin)
    }

    fn mint_tokens(env: &Env, token_addr: &Address, to: &Address, amount: i128) {
        let admin_client = soroban_sdk::token::StellarAssetClient::new(env, token_addr);
        admin_client.mint(to, &amount);
    }

    fn zero_metadata(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0u8; 32])
    }

    fn compute_test_leaf(
        env: &Env,
        account: &Address,
        token_addr: &Address,
        amount: i128,
        campaign_id: u32,
        metadata_hash: &BytesN<32>,
    ) -> BytesN<32> {
        MerkleDistributor::compute_leaf(
            env,
            account,
            token_addr,
            amount,
            campaign_id,
            metadata_hash,
        )
    }

    fn hash_pair_test(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
        MerkleDistributor::hash_pair(env, a, b)
    }

    fn load_shared_fixture() -> SharedFixture {
        serde_json::from_str(include_str!(
            "../../../backend/rewards/src/__tests__/fixtures/rewardMerkleVectors.json"
        ))
        .expect("shared fixture should parse")
    }

    fn hex_to_bytes32(env: &Env, hex: &str) -> BytesN<32> {
        let normalized = hex.strip_prefix("0x").unwrap_or(hex);
        assert_eq!(normalized.len(), 64);

        let mut out = [0u8; 32];
        for i in 0..32 {
            let start = i * 2;
            out[i] = u8::from_str_radix(&normalized[start..start + 2], 16).unwrap();
        }

        BytesN::from_array(env, &out)
    }

    fn proof_from_hex(env: &Env, proof: &[std::string::String]) -> Vec<BytesN<32>> {
        let mut soroban_proof = Vec::new(env);
        for element in proof {
            soroban_proof.push_back(hex_to_bytes32(env, element));
        }
        soroban_proof
    }

    #[test]
    fn test_initialize() {
        let (_, client, admin, token_addr, _) = setup_env();
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_token(), token_addr);
        assert_eq!(client.get_campaign_id(), 0);
        assert_eq!(client.get_epoch(), 0);
        assert_eq!(client.get_total_claimed(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let (env, client, _, token_addr, _) = setup_env();
        let new_admin = Address::generate(&env);
        client.initialize(&new_admin, &token_addr);
    }

    #[test]
    fn test_set_merkle_root() {
        let (env, client, admin, _, _) = setup_env();
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let campaign_id = 7u32;
        client.set_merkle_root(&admin, &campaign_id, &root);
        assert_eq!(client.get_merkle_root(), root);
        assert_eq!(client.get_campaign_id(), campaign_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn test_set_merkle_root_requires_increasing_campaign_id() {
        let (env, client, admin, _, _) = setup_env();
        let root1 = BytesN::from_array(&env, &[1u8; 32]);
        let root2 = BytesN::from_array(&env, &[2u8; 32]);
        client.set_merkle_root(&admin, &1u32, &root1);
        client.set_merkle_root(&admin, &1u32, &root2);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_set_merkle_root_unauthorized() {
        let (env, client, _, _, _) = setup_env();
        let non_admin = Address::generate(&env);
        let root = BytesN::from_array(&env, &[1u8; 32]);
        client.set_merkle_root(&non_admin, &1u32, &root);
    }

    #[test]
    fn test_shared_fixture_proofs_verify() {
        let env = Env::default();
        let fixture = load_shared_fixture();
        let root = hex_to_bytes32(&env, &fixture.root);

        for claim in fixture.claims.values() {
            assert!(!claim.address.is_empty());
            assert!(!claim.amount.is_empty());
            assert_eq!(claim.campaign_id, fixture.distribution.campaign_id);
            assert_eq!(claim.token, fixture.distribution.token);
            assert_eq!(claim.metadata_hash, fixture.distribution.metadata_hash);

            let leaf = hex_to_bytes32(&env, &claim.leaf);
            let proof = proof_from_hex(&env, &claim.proof);
            assert!(MerkleDistributor::verify_proof(&env, &proof, &root, &leaf));
        }
    }

    #[test]
    fn test_claim_with_valid_proof() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let campaign_id: u32 = 7;
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(
            &env,
            &claimant,
            &token_addr,
            amount,
            campaign_id,
            &metadata_hash,
        );

        client.set_merkle_root(&admin, &campaign_id, &leaf);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 10_000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        let claimed = client.claim(
            &claimant,
            &token_addr,
            &amount,
            &campaign_id,
            &metadata_hash,
            &empty_proof,
        );
        assert_eq!(claimed, 1000);
        assert!(client.is_claimed(&campaign_id, &claimant));
        assert_eq!(client.get_total_claimed(), 1000);
    }

    #[test]
    fn test_claim_with_two_leaf_proof() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant1 = Address::generate(&env);
        let claimant2 = Address::generate(&env);
        let amount1: i128 = 500;
        let amount2: i128 = 300;
        let campaign_id: u32 = 9;
        let metadata_hash = zero_metadata(&env);

        let leaf1 = compute_test_leaf(
            &env,
            &claimant1,
            &token_addr,
            amount1,
            campaign_id,
            &metadata_hash,
        );
        let leaf2 = compute_test_leaf(
            &env,
            &claimant2,
            &token_addr,
            amount2,
            campaign_id,
            &metadata_hash,
        );
        let root = hash_pair_test(&env, &leaf1, &leaf2);
        client.set_merkle_root(&admin, &campaign_id, &root);

        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 10_000);

        let proof1: Vec<BytesN<32>> = Vec::from_array(&env, [leaf2.clone()]);
        let claimed1 = client.claim(
            &claimant1,
            &token_addr,
            &amount1,
            &campaign_id,
            &metadata_hash,
            &proof1,
        );
        assert_eq!(claimed1, 500);

        let proof2: Vec<BytesN<32>> = Vec::from_array(&env, [leaf1.clone()]);
        let claimed2 = client.claim(
            &claimant2,
            &token_addr,
            &amount2,
            &campaign_id,
            &metadata_hash,
            &proof2,
        );
        assert_eq!(claimed2, 300);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_double_claim_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let campaign_id: u32 = 11;
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(
            &env,
            &claimant,
            &token_addr,
            amount,
            campaign_id,
            &metadata_hash,
        );

        client.set_merkle_root(&admin, &campaign_id, &leaf);
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 10_000);

        let empty_proof: Vec<BytesN<32>> = Vec::new(&env);
        client.claim(
            &claimant,
            &token_addr,
            &amount,
            &campaign_id,
            &metadata_hash,
            &empty_proof,
        );
        client.claim(
            &claimant,
            &token_addr,
            &amount,
            &campaign_id,
            &metadata_hash,
            &empty_proof,
        );
    }

    #[test]
    fn test_claim_state_is_scoped_to_campaign() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let amount: i128 = 1000;
        let metadata_hash = zero_metadata(&env);
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 20_000);

        let campaign_one = 21u32;
        let leaf_one = compute_test_leaf(
            &env,
            &claimant,
            &token_addr,
            amount,
            campaign_one,
            &metadata_hash,
        );
        client.set_merkle_root(&admin, &campaign_one, &leaf_one);
        client.claim(
            &claimant,
            &token_addr,
            &amount,
            &campaign_one,
            &metadata_hash,
            &Vec::new(&env),
        );

        let campaign_two = 22u32;
        let leaf_two = compute_test_leaf(
            &env,
            &claimant,
            &token_addr,
            amount,
            campaign_two,
            &metadata_hash,
        );
        client.set_merkle_root(&admin, &campaign_two, &leaf_two);
        let claimed = client.claim(
            &claimant,
            &token_addr,
            &amount,
            &campaign_two,
            &metadata_hash,
            &Vec::new(&env),
        );

        assert_eq!(claimed, 1000);
        assert!(client.is_claimed(&campaign_one, &claimant));
        assert!(client.is_claimed(&campaign_two, &claimant));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_wrong_amount_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let campaign_id: u32 = 31;
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(
            &env,
            &claimant,
            &token_addr,
            1000,
            campaign_id,
            &metadata_hash,
        );

        client.set_merkle_root(&admin, &campaign_id, &leaf);
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 10_000);

        client.claim(
            &claimant,
            &token_addr,
            &999,
            &campaign_id,
            &metadata_hash,
            &Vec::new(&env),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_wrong_recipient_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let rightful_claimant = Address::generate(&env);
        let wrong_claimant = Address::generate(&env);
        let campaign_id: u32 = 32;
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(
            &env,
            &rightful_claimant,
            &token_addr,
            1000,
            campaign_id,
            &metadata_hash,
        );

        client.set_merkle_root(&admin, &campaign_id, &leaf);
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 10_000);

        client.claim(
            &wrong_claimant,
            &token_addr,
            &1000,
            &campaign_id,
            &metadata_hash,
            &Vec::new(&env),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #9)")]
    fn test_wrong_campaign_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(&env, &claimant, &token_addr, 1000, 41, &metadata_hash);

        client.set_merkle_root(&admin, &41u32, &leaf);
        let contract_addr = client.address.clone();
        mint_tokens(&env, &token_addr, &contract_addr, 10_000);

        client.claim(
            &claimant,
            &token_addr,
            &1000,
            &42u32,
            &metadata_hash,
            &Vec::new(&env),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #4)")]
    fn test_claim_zero_amount_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(&env, &claimant, &token_addr, 1000, 51, &metadata_hash);
        client.set_merkle_root(&admin, &51u32, &leaf);

        client.claim(
            &claimant,
            &token_addr,
            &0,
            &51u32,
            &metadata_hash,
            &Vec::new(&env),
        );
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_claim_insufficient_balance_panics() {
        let (env, client, admin, token_addr, _) = setup_env();
        let claimant = Address::generate(&env);
        let metadata_hash = zero_metadata(&env);
        let leaf = compute_test_leaf(&env, &claimant, &token_addr, 1000, 61, &metadata_hash);

        client.set_merkle_root(&admin, &61u32, &leaf);

        client.claim(
            &claimant,
            &token_addr,
            &1000,
            &61u32,
            &metadata_hash,
            &Vec::new(&env),
        );
    }
}
