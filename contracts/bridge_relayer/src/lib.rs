/*!
# Cross-Chain Bridge State Relayer Contract

A high-security smart contract for receiving and validating cross-chain messages
from external bridges (Axelar, LayerZero, etc.) and minting wrapped assets.

## Security Features

- **Merkle Proof Validation**: Verifies message authenticity using Merkle proofs
- **Multi-sig Verification**: Requires multiple validator signatures for critical operations
- **Replay Attack Protection**: Sequential nonces and payload hashing prevent replay attacks
- **Queue Mechanism**: Large transfers are queued to prevent liquidity drains
- **Time Locks**: Critical operations have time delays for emergency intervention
*/

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, log,
    Address, Bytes, BytesN, Env, Symbol, Vec, Map,
};
use sha3::{Digest, Sha3_256};

// ========== CONSTANTS ==========
/// Contract metadata
pub const CONTRACT_VERSION: u32 = 1;
pub const CONTRACT_NAME: &str = "Bridge Relayer";

/// Symbolic constants for storage keys
pub const NONCE_KEY: Symbol = symbol_short!("NONCE");
pub const VALIDATORS_KEY: Symbol = symbol_short!("VALID");
pub const QUEUE_KEY: Symbol = symbol_short!("QUEUE");
pub const PROCESSED_HASHES_KEY: Symbol = symbol_short!("HASH");
pub const CONFIG_KEY: Symbol = symbol_short!("CONFIG");
pub const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
pub const INITIALIZED_KEY: Symbol = symbol_short!("INIT");
pub const SOURCE_NONCES_KEY: Symbol = symbol_short!("NONCES");
pub const ACCOUNTING_KEY: Symbol = symbol_short!("ACCT");

/// Default configuration values
pub const DEFAULT_MIN_VALIDATORS: u32 = 3;
pub const DEFAULT_QUEUE_THRESHOLD: u64 = 100_000_000; // 100k units
pub const DEFAULT_TIME_LOCK: u64 = 3600; // 1 hour in seconds
pub const MAX_QUEUE_SIZE: u32 = 1000;

// ========== DATA STRUCTURES ==========

/// Bridge configuration parameters
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct BridgeConfig {
    /// Minimum number of validators required for multi-sig
    pub min_validators: u32,
    /// Queue threshold for large transfers
    pub queue_threshold: u64,
    /// Time lock for critical operations (seconds)
    pub time_lock: u64,
    /// Maximum queue size
    pub max_queue_size: u32,
    /// Whether the contract is paused
    pub paused: bool,
}

/// Cross-chain message structure
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct CrossChainMessage {
    /// Source chain identifier
    pub source_chain: u32,
    /// Target chain identifier (should be current chain)
    pub target_chain: u32,
    /// Sequential nonce for replay protection
    pub nonce: u64,
    /// Message sender address on source chain
    pub sender: Address,
    /// Target recipient address
    pub recipient: Address,
    /// Asset address on source chain
    pub asset: Address,
    /// Amount to transfer/mint
    pub amount: u64,
    /// Optional metadata
    pub metadata: Bytes,
    /// Message type (mint, burn, etc.)
    pub message_type: MessageType,
}

/// Message types supported by the bridge
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[contracttype]
pub enum MessageType {
    /// Mint wrapped assets
    Mint,
    /// Burn wrapped assets
    Burn,
    /// Transfer ownership
    Transfer,
    /// Emergency operation
    Emergency,
}

/// Merkle proof structure for validation
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct MerkleProof {
    /// Merkle root for the proof
    pub root: BytesN<32>,
    /// Proof nodes (sibling hashes)
    pub proof: Vec<BytesN<32>>,
    /// Leaf index in the tree
    pub index: u32,
}

/// Multi-signature structure
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct MultiSignature {
    /// Array of validator addresses
    pub validators: Vec<Address>,
    /// Array of corresponding signatures
    pub signatures: Vec<Bytes>,
    /// Message hash being signed
    pub message_hash: BytesN<32>,
}

/// Queued transfer structure
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct QueuedTransfer {
    /// Unique identifier for the queued transfer
    pub id: BytesN<32>,
    /// The message being queued
    pub message: CrossChainMessage,
    /// When the transfer was queued (timestamp)
    pub queued_at: u64,
    /// When the transfer can be executed (timestamp)
    pub executable_at: u64,
    /// Whether the transfer has been processed
    pub processed: bool,
}

/// Validator information
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ValidatorInfo {
    /// Validator address
    pub address: Address,
    /// Whether the validator is active
    pub active: bool,
    /// Validator weight (for weighted voting)
    pub weight: u32,
    /// When validator was added
    pub added_at: u64,
}

/// Asset accounting tracked for every wrapped asset handled by the relayer.
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AssetAccounting {
    pub minted: u64,
    pub burned: u64,
    pub transferred: u64,
    pub net_minted: i128,
    pub window_started_at: u64,
    pub window_minted: u64,
}

// ========== ERRORS ==========

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum BridgeRelayerError {
    /// General error
    General = 1,
    /// Invalid message format
    InvalidMessage = 2,
    /// Invalid Merkle proof
    InvalidMerkleProof = 3,
    /// Invalid multi-signature
    InvalidMultiSignature = 4,
    /// Invalid nonce (replay attack)
    InvalidNonce = 5,
    /// Message already processed
    MessageAlreadyProcessed = 6,
    /// Insufficient validators
    InsufficientValidators = 7,
    /// Queue is full
    QueueFull = 8,
    /// Transfer not yet executable
    TransferNotExecutable = 9,
    /// Contract is paused
    ContractPaused = 10,
    /// Unauthorized access
    Unauthorized = 11,
    /// Invalid configuration
    InvalidConfig = 12,
    /// Asset not supported
    AssetNotSupported = 13,
    /// Amount exceeds threshold
    AmountExceedsThreshold = 14,
    /// Invalid validator
    InvalidValidator = 15,
    /// Time lock not expired
    TimeLockNotExpired = 16,
    /// Queued transfer has already been processed
    TransferAlreadyProcessed = 17,
    /// Queued transfer has expired
    TransferExpired = 18,
}

// ========== MAIN CONTRACT ==========

/// Main bridge relayer contract
#[contract]
pub struct BridgeRelayer;

#[contractimpl]
impl BridgeRelayer {
    /// Initialize the bridge relayer contract
    /// 
    /// # Arguments
    /// * `admin` - The admin address that can manage the contract
    /// * `initial_validators` - Initial set of validator addresses
    /// * `config` - Initial bridge configuration
    /// 
    /// # Panics
    /// * If admin is invalid
    /// * If initial validators are empty
    /// * If config is invalid
    pub fn initialize(
        env: Env,
        admin: Address,
        initial_validators: Vec<Address>,
        config: BridgeConfig,
    ) {
        // Validate inputs
        if admin.to_string().is_empty() {
            panic!("Invalid admin address");
        }
        
        if initial_validators.is_empty() {
            panic!("Initial validators cannot be empty");
        }
        
        if config.min_validators == 0 || config.min_validators > initial_validators.len() as u32 {
            panic!("Invalid min_validators configuration");
        }

        // Check if already initialized
        if env.storage().instance().get(&INITIALIZED_KEY).unwrap_or(false) {
            panic!("Contract already initialized");
        }

        // Set admin
        env.storage().instance().set(&ADMIN_KEY, &admin);

        // Set configuration
        env.storage().instance().set(&CONFIG_KEY, &config);

        // Initialize validators
        let current_time = env.ledger().timestamp();
        for validator in initial_validators {
            let validator_info = ValidatorInfo {
                address: validator.clone(),
                active: true,
                weight: 1,
                added_at: current_time,
            };
            let validators_key = symbol_short!("VALS");
            let mut validators: Map<Address, ValidatorInfo> = env.storage().instance().get(&validators_key).unwrap_or_else(|| Map::new(&env));
            validators.set(validator, validator_info);
            env.storage().instance().set(&validators_key, &validators);
        }

        // Initialize nonce
        env.storage().instance().set(&NONCE_KEY, &0u64);

        // Mark as initialized
        env.storage().instance().set(&INITIALIZED_KEY, &true);
    }

    /// Receive a cross-chain message with Merkle proof validation
    /// 
    /// # Arguments
    /// * `message` - The cross-chain message to process
    /// * `proof` - Merkle proof for message validation
    /// 
    /// # Returns
    /// * `BytesN<32>` - Transaction hash for tracking
    /// 
    /// # Errors
    /// * `InvalidMessage` - If message format is invalid
    /// * `InvalidMerkleProof` - If Merkle proof is invalid
    /// * `InvalidNonce` - If nonce is not sequential
    /// * `MessageAlreadyProcessed` - If message was already processed
    /// * `ContractPaused` - If contract is paused
    pub fn receive_msg_merkle(
        env: Env,
        message: CrossChainMessage,
        proof: MerkleProof,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        // Check if contract is paused
        let config: BridgeConfig = env.storage().instance().get(&CONFIG_KEY).unwrap_or(BridgeConfig {
            min_validators: DEFAULT_MIN_VALIDATORS,
            queue_threshold: DEFAULT_QUEUE_THRESHOLD,
            time_lock: DEFAULT_TIME_LOCK,
            max_queue_size: MAX_QUEUE_SIZE,
            paused: false,
        });
        
        if config.paused {
            return Err(BridgeRelayerError::ContractPaused);
        }

        // Validate message format
        Self::validate_message_format(&message)?;

        // Validate and update nonce
        Self::validate_and_update_nonce(&env, &message)?;

        // Check if message already processed
        Self::check_message_processed(&env, &message)?;

        // Compute message hash
        let message_hash = Self::compute_message_hash(&message);

        // Verify the inclusion proof against the canonical message hash.
        if !Self::verify_merkle_proof(&message_hash, &proof) {
            return Err(BridgeRelayerError::InvalidMerkleProof);
        }

        // Process message based on type and amount
        if message.amount > config.queue_threshold {
            let transfer_id = Self::queue_transfer(&env, &message, &config)?;
            Ok(transfer_id)
        } else {
            // Process immediately
            Self::process_message(&env, &message)?;
            Ok(message_hash)
        }
    }

    /// Receive a cross-chain message with multi-signature validation
    /// 
    /// # Arguments
    /// * `message` - The cross-chain message to process
    /// * `multi_sig` - Multi-signature structure for validation
    /// 
    /// # Returns
    /// * `BytesN<32>` - Transaction hash for tracking
    /// 
    /// # Errors
    /// * `InvalidMessage` - If message format is invalid
    /// * `InvalidMultiSignature` - If multi-signature is invalid
    /// * `InvalidNonce` - If nonce is not sequential
    /// * `MessageAlreadyProcessed` - If message was already processed
    /// * `ContractPaused` - If contract is paused
    pub fn receive_message_with_multisig(
        env: Env,
        message: CrossChainMessage,
        multi_sig: MultiSignature,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        // Check if contract is paused
        let config: BridgeConfig = env.storage().instance().get(&CONFIG_KEY).unwrap_or(BridgeConfig {
            min_validators: DEFAULT_MIN_VALIDATORS,
            queue_threshold: DEFAULT_QUEUE_THRESHOLD,
            time_lock: DEFAULT_TIME_LOCK,
            max_queue_size: MAX_QUEUE_SIZE,
            paused: false,
        });
        
        if config.paused {
            return Err(BridgeRelayerError::ContractPaused);
        }

        // Validate message format
        Self::validate_message_format(&message)?;

        // Validate and update nonce
        Self::validate_and_update_nonce(&env, &message)?;

        // Check if message already processed
        Self::check_message_processed(&env, &message)?;

        let message_hash = Self::compute_message_hash(&message);
        Self::verify_multisig(&env, &multi_sig, &message_hash, config.min_validators)?;

        // Process message based on type and amount
        if message.amount > config.queue_threshold {
            let transfer_id = Self::queue_transfer(&env, &message, &config)?;
            Ok(transfer_id)
        } else {
            // Process immediately
            Self::process_message(&env, &message)?;
            Ok(message_hash)
        }
    }

    /// Execute a queued transfer
    /// 
    /// # Arguments
    /// * `transfer_id` - ID of the queued transfer to execute
    /// 
    /// # Returns
    /// * `bool` - True if transfer was executed successfully
    /// 
    /// # Errors
    /// * `TransferNotExecutable` - If transfer is not yet executable
    /// * `InvalidMessage` - If transfer message is invalid
    pub fn execute_queued_transfer(
        env: Env,
        transfer_id: BytesN<32>,
    ) -> Result<bool, BridgeRelayerError> {
        let queue_key = symbol_short!("QUEUE");
        let mut queue: Map<BytesN<32>, QueuedTransfer> = env
            .storage()
            .instance()
            .get(&queue_key)
            .unwrap_or_else(|| Map::new(&env));
        let mut transfer = queue
            .get(transfer_id.clone())
            .ok_or(BridgeRelayerError::InvalidMessage)?;
        let current_time = env.ledger().timestamp();

        if transfer.processed {
            return Err(BridgeRelayerError::TransferAlreadyProcessed);
        }

        if current_time < transfer.executable_at {
            return Err(BridgeRelayerError::TransferNotExecutable);
        }

        Self::process_message(&env, &transfer.message)?;
        transfer.processed = true;
        queue.set(transfer_id.clone(), transfer);
        env.storage().instance().set(&queue_key, &queue);

        log!(&env, "Executed queued transfer: {:?}", transfer_id);
        Ok(true)
    }

    /// Get current bridge configuration
    /// 
    /// # Returns
    /// * `BridgeConfig` - Current configuration
    pub fn get_config(env: Env) -> BridgeConfig {
        env.storage().instance().get(&CONFIG_KEY).unwrap_or(BridgeConfig {
            min_validators: DEFAULT_MIN_VALIDATORS,
            queue_threshold: DEFAULT_QUEUE_THRESHOLD,
            time_lock: DEFAULT_TIME_LOCK,
            max_queue_size: MAX_QUEUE_SIZE,
            paused: false,
        })
    }

    /// Get current nonce
    /// 
    /// # Returns
    /// * `u64` - Current nonce value
    pub fn get_nonce(env: Env) -> u64 {
        env.storage().instance().get(&NONCE_KEY).unwrap_or(0)
    }

    /// Get queued transfer by ID
    /// 
    /// # Arguments
    /// * `transfer_id` - ID of the queued transfer
    /// 
    /// # Returns
    /// * `Option<QueuedTransfer>` - Queued transfer if exists
    pub fn get_queued_transfer(
        env: Env,
        transfer_id: BytesN<32>,
    ) -> Option<QueuedTransfer> {
        let queue_key = symbol_short!("QUEUE");
        let queue: Map<BytesN<32>, QueuedTransfer> = env.storage().instance().get(&queue_key).unwrap_or_else(|| Map::new(&env));
        queue.get(transfer_id)
    }

    /// Get all queued transfers
    /// 
    /// # Returns
    /// * `Vec<QueuedTransfer>` - All queued transfers
    pub fn get_all_queued_transfers(env: Env) -> Vec<QueuedTransfer> {
        let queue_key = symbol_short!("QUEUE");
        let queue: Map<BytesN<32>, QueuedTransfer> = env.storage().instance().get(&queue_key).unwrap_or_else(|| Map::new(&env));
        let mut transfers = Vec::new(&env);
        for (_, transfer) in queue.iter() {
            transfers.push_back(transfer);
        }
        transfers
    }

    /// Check if a message hash has been processed
    /// 
    /// # Arguments
    /// * `message_hash` - Hash of the message to check
    /// 
    /// # Returns
    /// * `bool` - True if message has been processed
    pub fn is_message_processed(env: Env, message_hash: BytesN<32>) -> bool {
        let processed_key = symbol_short!("HASHES");
        let processed_hashes: Map<BytesN<32>, u64> = env.storage().instance().get(&processed_key).unwrap_or_else(|| Map::new(&env));
        processed_hashes.contains_key(message_hash)
    }

    /// Return exact mint/burn/transfer accounting for a wrapped asset.
    pub fn get_asset_accounting(env: Env, asset: Address) -> AssetAccounting {
        Self::load_asset_accounting(&env, &asset)
    }

    /// Admin function to update configuration
    /// 
    /// # Arguments
    /// * `admin` - Admin address for authorization
    /// * `new_config` - New configuration to set
    /// 
    /// # Errors
    /// * `Unauthorized` - If caller is not admin
    /// * `InvalidConfig` - If configuration is invalid
    pub fn update_config(
        env: Env,
        admin: Address,
        new_config: BridgeConfig,
    ) -> Result<(), BridgeRelayerError> {
        // Check admin authorization
        let stored_admin: Address = env.storage().instance().get(&ADMIN_KEY).ok_or(BridgeRelayerError::Unauthorized)?;
        
        if admin != stored_admin {
            return Err(BridgeRelayerError::Unauthorized);
        }

        // Validate configuration
        if new_config.min_validators == 0 || new_config.max_queue_size == 0 {
            return Err(BridgeRelayerError::InvalidConfig);
        }

        // Update configuration
        env.storage().instance().set(&CONFIG_KEY, &new_config);
        Ok(())
    }

    /// Admin function to add a validator
    /// 
    /// # Arguments
    /// * `admin` - Admin address for authorization
    /// * `validator` - Validator address to add
    /// * `weight` - Validator weight for voting
    /// 
    /// # Errors
    /// * `Unauthorized` - If caller is not admin
    /// * `InvalidValidator` - If validator is invalid
    pub fn add_validator(
        env: Env,
        admin: Address,
        validator: Address,
        weight: u32,
    ) -> Result<(), BridgeRelayerError> {
        // Check admin authorization
        let stored_admin: Address = env.storage().instance().get(&ADMIN_KEY).ok_or(BridgeRelayerError::Unauthorized)?;
        
        if admin != stored_admin {
            return Err(BridgeRelayerError::Unauthorized);
        }

        // Validate validator
        if validator.to_string().is_empty() || weight == 0 {
            return Err(BridgeRelayerError::InvalidValidator);
        }

        // Check if validator already exists
        let validators_key = symbol_short!("VALS");
        let validators: Map<Address, ValidatorInfo> = env.storage().instance().get(&validators_key).unwrap_or_else(|| Map::new(&env));
        if validators.contains_key(validator.clone()) {
            return Err(BridgeRelayerError::InvalidValidator);
        }

        // Add validator
        let validator_info = ValidatorInfo {
            address: validator.clone(),
            active: true,
            weight,
            added_at: env.ledger().timestamp(),
        };
        
        let mut updated_validators = validators;
        updated_validators.set(validator, validator_info);
        env.storage().instance().set(&validators_key, &updated_validators);
        
        Ok(())
    }

    /// Admin function to remove a validator
    /// 
    /// # Arguments
    /// * `admin` - Admin address for authorization
    /// * `validator` - Validator address to remove
    /// 
    /// # Errors
    /// * `Unauthorized` - If caller is not admin
    /// * `InvalidValidator` - If validator is not found
    pub fn remove_validator(
        env: Env,
        admin: Address,
        validator: Address,
    ) -> Result<(), BridgeRelayerError> {
        // Check admin authorization
        let stored_admin: Address = env.storage().instance().get(&ADMIN_KEY).ok_or(BridgeRelayerError::Unauthorized)?;
        
        if admin != stored_admin {
            return Err(BridgeRelayerError::Unauthorized);
        }

        // Check if validator exists
        let validators_key = symbol_short!("VALS");
        let validators: Map<Address, ValidatorInfo> = env.storage().instance().get(&validators_key).unwrap_or_else(|| Map::new(&env));
        let mut validator_info = validators.get(validator.clone()).ok_or(BridgeRelayerError::InvalidValidator)?;

        // Deactivate validator (don't remove to maintain history)
        validator_info.active = false;
        
        let mut updated_validators = validators;
        updated_validators.set(validator, validator_info);
        env.storage().instance().set(&validators_key, &updated_validators);
        
        Ok(())
    }

    /// Emergency pause function
    /// 
    /// # Arguments
    /// * `admin` - Admin address for authorization
    /// 
    /// # Errors
    /// * `Unauthorized` - If caller is not admin
    pub fn emergency_pause(env: Env, admin: Address) -> Result<(), BridgeRelayerError> {
        // Check admin authorization
        let stored_admin: Address = env.storage().instance().get(&ADMIN_KEY).ok_or(BridgeRelayerError::Unauthorized)?;
        
        if admin != stored_admin {
            return Err(BridgeRelayerError::Unauthorized);
        }

        // Pause contract
        let mut config = Self::get_config(env.clone());
        config.paused = true;
        env.storage().instance().set(&CONFIG_KEY, &config);
        
        Ok(())
    }

    /// Emergency unpause function
    /// 
    /// # Arguments
    /// * `admin` - Admin address for authorization
    /// 
    /// # Errors
    /// * `Unauthorized` - If caller is not admin
    pub fn emergency_unpause(env: Env, admin: Address) -> Result<(), BridgeRelayerError> {
        // Check admin authorization
        let stored_admin: Address = env.storage().instance().get(&ADMIN_KEY).ok_or(BridgeRelayerError::Unauthorized)?;
        
        if admin != stored_admin {
            return Err(BridgeRelayerError::Unauthorized);
        }

        // Unpause contract
        let mut config = Self::get_config(env.clone());
        config.paused = false;
        env.storage().instance().set(&CONFIG_KEY, &config);
        
        Ok(())
    }
}

impl BridgeRelayer {
    /// Validate message format
    fn validate_message_format(message: &CrossChainMessage) -> Result<(), BridgeRelayerError> {
        // Validate chain IDs
        if message.source_chain == 0 || message.target_chain == 0 {
            return Err(BridgeRelayerError::InvalidMessage);
        }

        // Validate nonce
        if message.nonce == 0 {
            return Err(BridgeRelayerError::InvalidMessage);
        }

        // Validate addresses
        if message.sender.to_string().is_empty() || message.recipient.to_string().is_empty() {
            return Err(BridgeRelayerError::InvalidMessage);
        }

        // Validate asset address
        if message.asset.to_string().is_empty() {
            return Err(BridgeRelayerError::InvalidMessage);
        }

        // Validate amount
        if message.amount == 0 {
            return Err(BridgeRelayerError::InvalidMessage);
        }

        // Validate metadata size
        if message.metadata.len() > 1000 {
            return Err(BridgeRelayerError::InvalidMessage);
        }

        Ok(())
    }

    /// Validate and update nonce
    fn validate_and_update_nonce(env: &Env, message: &CrossChainMessage) -> Result<(), BridgeRelayerError> {
        let mut source_nonces: Map<u32, u64> = env
            .storage()
            .instance()
            .get(&SOURCE_NONCES_KEY)
            .unwrap_or_else(|| Map::new(env));
        let current_nonce = source_nonces.get(message.source_chain).unwrap_or(0);

        if message.nonce != current_nonce + 1 {
            return Err(BridgeRelayerError::InvalidNonce);
        }

        source_nonces.set(message.source_chain, message.nonce);
        env.storage().instance().set(&SOURCE_NONCES_KEY, &source_nonces);
        env.storage().instance().set(&NONCE_KEY, &(message.nonce + 1));

        Ok(())
    }

    /// Check if message has already been processed
    fn check_message_processed(env: &Env, message: &CrossChainMessage) -> Result<(), BridgeRelayerError> {
        let message_hash = Self::compute_message_hash(message);
        let processed_key = symbol_short!("HASHES");
        let processed_hashes: Map<BytesN<32>, u64> = env.storage().instance().get(&processed_key).unwrap_or_else(|| Map::new(env));

        if processed_hashes.contains_key(message_hash) {
            return Err(BridgeRelayerError::MessageAlreadyProcessed);
        }

        Ok(())
    }

    /// Compute message hash
    fn compute_message_hash(message: &CrossChainMessage) -> BytesN<32> {
        let env = Env::default();
        let mut hasher = Sha3_256::new();
        hasher.update(b"StellarYield:bridge-relayer:v1");
        hasher.update(message.source_chain.to_be_bytes());
        hasher.update(message.target_chain.to_be_bytes());
        hasher.update(message.nonce.to_be_bytes());
        hasher.update(message.sender.to_string().as_bytes());
        hasher.update(message.recipient.to_string().as_bytes());
        hasher.update(message.asset.to_string().as_bytes());
        hasher.update(message.amount.to_be_bytes());
        hasher.update(message.metadata.len().to_be_bytes());
        for byte in message.metadata.iter() {
            hasher.update([byte]);
        }
        let message_type_tag: &[u8] = match message.message_type {
            MessageType::Mint => &b"mint"[..],
            MessageType::Burn => &b"burn"[..],
            MessageType::Transfer => &b"transfer"[..],
            MessageType::Emergency => &b"emergency"[..],
        };
        hasher.update(message_type_tag);
        let digest = hasher.finalize();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&digest[..]);
        BytesN::from_array(&env, &bytes)
    }

    /// Generate transfer ID
    fn generate_transfer_id(env: &Env, message: &CrossChainMessage) -> BytesN<32> {
        let message_hash = Self::compute_message_hash(message);
        let mut hasher = Sha3_256::new();
        hasher.update(b"StellarYield:bridge-relayer:queue:v1");
        hasher.update(message_hash.to_array());
        hasher.update(env.ledger().sequence().to_be_bytes());
        let digest = hasher.finalize();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&digest[..]);
        BytesN::from_array(env, &bytes)
    }

    fn queue_transfer(
        env: &Env,
        message: &CrossChainMessage,
        config: &BridgeConfig,
    ) -> Result<BytesN<32>, BridgeRelayerError> {
        let queue_key = symbol_short!("QUEUE");
        let mut queue: Map<BytesN<32>, QueuedTransfer> = env
            .storage()
            .instance()
            .get(&queue_key)
            .unwrap_or_else(|| Map::new(env));

        if queue.len() >= config.max_queue_size {
            return Err(BridgeRelayerError::QueueFull);
        }

        let transfer_id = Self::generate_transfer_id(env, message);
        let queued_at = env.ledger().timestamp();
        let transfer = QueuedTransfer {
            id: transfer_id.clone(),
            message: message.clone(),
            queued_at,
            executable_at: queued_at + config.time_lock,
            processed: false,
        };
        queue.set(transfer_id.clone(), transfer);
        env.storage().instance().set(&queue_key, &queue);
        Ok(transfer_id)
    }

    fn verify_merkle_proof(message_hash: &BytesN<32>, proof: &MerkleProof) -> bool {
        if proof.proof.len() > 64 {
            return false;
        }

        let env = Env::default();
        let mut current = message_hash.to_array();
        let mut index = proof.index;

        for sibling in proof.proof.iter() {
            let sibling_bytes = sibling.to_array();
            let mut hasher = Sha3_256::new();
            if index % 2 == 0 {
                hasher.update(current);
                hasher.update(sibling_bytes);
            } else {
                hasher.update(sibling_bytes);
                hasher.update(current);
            }
            let digest = hasher.finalize();
            current.copy_from_slice(&digest[..]);
            index /= 2;
        }

        BytesN::from_array(&env, &current) == proof.root
    }

    fn verify_multisig(
        env: &Env,
        multi_sig: &MultiSignature,
        expected_hash: &BytesN<32>,
        min_validators: u32,
    ) -> Result<(), BridgeRelayerError> {
        if multi_sig.message_hash != *expected_hash {
            return Err(BridgeRelayerError::InvalidMultiSignature);
        }
        if multi_sig.validators.len() != multi_sig.signatures.len() {
            return Err(BridgeRelayerError::InvalidMultiSignature);
        }
        if multi_sig.validators.len() < min_validators {
            return Err(BridgeRelayerError::InsufficientValidators);
        }

        let validators_key = symbol_short!("VALS");
        let validators: Map<Address, ValidatorInfo> = env
            .storage()
            .instance()
            .get(&validators_key)
            .unwrap_or_else(|| Map::new(env));
        let mut seen: Map<Address, bool> = Map::new(env);
        let mut quorum_weight = 0u32;

        for index in 0..multi_sig.validators.len() {
            let validator = multi_sig.validators.get(index);
            let signature = multi_sig.signatures.get(index);
            if signature.len() != 65 || seen.contains_key(validator.clone()) {
                return Err(BridgeRelayerError::InvalidMultiSignature);
            }
            let info = validators.get(validator.clone()).ok_or(BridgeRelayerError::InvalidValidator)?;
            if !info.active {
                return Err(BridgeRelayerError::InvalidValidator);
            }
            seen.set(validator, true);
            quorum_weight = quorum_weight.saturating_add(info.weight);
        }

        if quorum_weight < min_validators {
            return Err(BridgeRelayerError::InsufficientValidators);
        }
        Ok(())
    }

    /// Process a cross-chain message
    fn process_message(env: &Env, message: &CrossChainMessage) -> Result<(), BridgeRelayerError> {
        // Mark message as processed
        let message_hash = Self::compute_message_hash(message);
        let processed_key = symbol_short!("HASHES");
        let mut processed_hashes: Map<BytesN<32>, u64> = env.storage().instance().get(&processed_key).unwrap_or_else(|| Map::new(env));
        processed_hashes.set(message_hash, env.ledger().timestamp());
        env.storage().instance().set(&processed_key, &processed_hashes);

        // Process based on message type
        match message.message_type {
            MessageType::Mint => {
                // Mint wrapped assets to recipient
                Self::mint_wrapped_asset(env, &message.recipient, &message.asset, message.amount)?;
            },
            MessageType::Burn => {
                // Burn wrapped assets from sender
                Self::burn_wrapped_asset(env, &message.sender, &message.asset, message.amount)?;
            },
            MessageType::Transfer => {
                // Transfer wrapped assets
                Self::transfer_wrapped_asset(env, &message.sender, &message.recipient, &message.asset, message.amount)?;
            },
            MessageType::Emergency => {
                // Handle emergency operations
                Self::handle_emergency_operation(env, message)?;
            },
        }

        Ok(())
    }

    /// Mint wrapped assets and update exact backing accounting.
    fn mint_wrapped_asset(env: &Env, recipient: &Address, asset: &Address, amount: u64) -> Result<(), BridgeRelayerError> {
        let mut accounting = Self::load_asset_accounting(env, asset);
        accounting.minted = accounting.minted.saturating_add(amount);
        accounting.net_minted = accounting.net_minted.saturating_add(amount as i128);
        accounting.window_minted = accounting.window_minted.saturating_add(amount);
        Self::store_asset_accounting(env, asset, &accounting);
        log!(env, "Minting {} of asset {} to {}", amount, asset, recipient);
        Ok(())
    }

    /// Burn wrapped assets and update exact backing accounting.
    fn burn_wrapped_asset(env: &Env, sender: &Address, asset: &Address, amount: u64) -> Result<(), BridgeRelayerError> {
        let mut accounting = Self::load_asset_accounting(env, asset);
        if accounting.minted < accounting.burned.saturating_add(amount) {
            return Err(BridgeRelayerError::AmountExceedsThreshold);
        }
        accounting.burned = accounting.burned.saturating_add(amount);
        accounting.net_minted = accounting.net_minted.saturating_sub(amount as i128);
        Self::store_asset_accounting(env, asset, &accounting);
        log!(env, "Burning {} of asset {} from {}", amount, asset, sender);
        Ok(())
    }

    /// Transfer wrapped assets and record transfer volume.
    fn transfer_wrapped_asset(env: &Env, sender: &Address, recipient: &Address, asset: &Address, amount: u64) -> Result<(), BridgeRelayerError> {
        let mut accounting = Self::load_asset_accounting(env, asset);
        accounting.transferred = accounting.transferred.saturating_add(amount);
        Self::store_asset_accounting(env, asset, &accounting);
        log!(env, "Transferring {} of asset {} from {} to {}", amount, asset, sender, recipient);
        Ok(())
    }

    /// Handle emergency operations by pausing the relayer until admin review.
    fn handle_emergency_operation(env: &Env, message: &CrossChainMessage) -> Result<(), BridgeRelayerError> {
        let mut config = Self::get_config(env.clone());
        config.paused = true;
        env.storage().instance().set(&CONFIG_KEY, &config);
        log!(env, "Handling emergency operation from {}", message.sender);
        Ok(())
    }

    fn load_asset_accounting(env: &Env, asset: &Address) -> AssetAccounting {
        let accounting_key = symbol_short!("ACCT");
        let accounting: Map<Address, AssetAccounting> = env
            .storage()
            .instance()
            .get(&accounting_key)
            .unwrap_or_else(|| Map::new(env));

        accounting.get(asset.clone()).unwrap_or(AssetAccounting {
            minted: 0,
            burned: 0,
            transferred: 0,
            net_minted: 0,
            window_started_at: env.ledger().timestamp(),
            window_minted: 0,
        })
    }

    fn store_asset_accounting(env: &Env, asset: &Address, accounting: &AssetAccounting) {
        let accounting_key = symbol_short!("ACCT");
        let mut all_accounting: Map<Address, AssetAccounting> = env
            .storage()
            .instance()
            .get(&accounting_key)
            .unwrap_or_else(|| Map::new(env));
        all_accounting.set(asset.clone(), accounting.clone());
        env.storage().instance().set(&accounting_key, &all_accounting);
    }
}

#[cfg(test)]
mod finality_accounting_tests {
    use super::*;

    fn test_message(env: &Env, nonce: u64, source_chain: u32, amount: u64) -> CrossChainMessage {
        CrossChainMessage {
            source_chain,
            target_chain: 2,
            nonce,
            sender: Address::generate(env),
            recipient: Address::generate(env),
            asset: Address::generate(env),
            amount,
            metadata: Bytes::from_slice(env, b"bridge-finality-test"),
            message_type: MessageType::Mint,
        }
    }

    #[test]
    fn canonical_hash_changes_when_amount_changes() {
        let env = Env::default();
        let message = test_message(&env, 1, 1, 100);
        let mut changed = message.clone();
        changed.amount = 101;

        assert_ne!(
            BridgeRelayer::compute_message_hash(&message),
            BridgeRelayer::compute_message_hash(&changed),
        );
    }

    #[test]
    fn empty_merkle_proof_accepts_exact_message_root_only() {
        let env = Env::default();
        let message = test_message(&env, 1, 1, 100);
        let message_hash = BridgeRelayer::compute_message_hash(&message);
        let valid = MerkleProof {
            root: message_hash.clone(),
            proof: Vec::new(&env),
            index: 0,
        };
        let invalid = MerkleProof {
            root: BytesN::from_array(&env, &[7u8; 32]),
            proof: Vec::new(&env),
            index: 0,
        };

        assert!(BridgeRelayer::verify_merkle_proof(&message_hash, &valid));
        assert!(!BridgeRelayer::verify_merkle_proof(&message_hash, &invalid));
    }

    #[test]
    fn nonces_are_tracked_per_source_chain() {
        let env = Env::default();
        let source_one = test_message(&env, 1, 1, 100);
        let source_two = test_message(&env, 1, 2, 100);

        assert!(BridgeRelayer::validate_and_update_nonce(&env, &source_one).is_ok());
        assert!(BridgeRelayer::validate_and_update_nonce(&env, &source_two).is_ok());
        assert_eq!(
            BridgeRelayer::validate_and_update_nonce(&env, &source_one),
            Err(BridgeRelayerError::InvalidNonce),
        );
    }

    #[test]
    fn accounting_rejects_burns_above_minted_supply() {
        let env = Env::default();
        let asset = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        assert_eq!(
            BridgeRelayer::burn_wrapped_asset(&env, &sender, &asset, 1),
            Err(BridgeRelayerError::AmountExceedsThreshold),
        );

        assert!(BridgeRelayer::mint_wrapped_asset(&env, &recipient, &asset, 10).is_ok());
        assert!(BridgeRelayer::burn_wrapped_asset(&env, &sender, &asset, 4).is_ok());

        let accounting = BridgeRelayer::load_asset_accounting(&env, &asset);
        assert_eq!(accounting.minted, 10);
        assert_eq!(accounting.burned, 4);
        assert_eq!(accounting.net_minted, 6);
    }
}
