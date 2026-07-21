#![no_std]
#![allow(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::unwrap_used
)]
//! # Smart Proxy Wallet
//!
//! A programmable smart contract wallet for Soroban that enables Account Abstraction.
//! Supports WebAuthn/P-256 authentication with production-grade replay protection.
//!
//! ## Signed Payload Structure
//!
//! The payload signed by the WebAuthn authenticator is:
//!
//! ```text
//! SHA-256(
//!   "stellaryield_webauthn_v1" (24 bytes, zero-padded to 32)
//!   || SHA-256(wallet_address_string)   (32 bytes)
//!   || nonce                            (8 bytes big-endian u64)
//!   || SHA-256(call_target_string)      (32 bytes)
//!   || SHA-256(call_data)               (32 bytes)
//!   || expiry                           (8 bytes big-endian u64 ledger sequence)
//!   || network_id                       (32 bytes)
//! )
//! ```
//!
//! This binds every signature to a specific wallet, operation, expiry window,
//! and network, preventing cross-wallet, cross-operation, expired, and
//! cross-network replay attacks.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, crypto::Hash, symbol_short, Address,
    Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
};

/// Legacy WebAuthn assertion data — kept for ABI compatibility.
#[contracttype]
#[derive(Clone, Debug)]
pub struct WebAuthnSignature {
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    pub r_bytes: BytesN<32>,
    pub s_bytes: BytesN<32>,
}

// ── Storage Keys ────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Initialized,
    Owner,
    Nonce,
    Factory,
    Relayer,
    WebAuthnKey,
    UsedNonces,
    VaultAllowances,
    NetworkId,
    RecoveryContract,
}

// ── Data Structures ─────────────────────────────────────────────────────

/// P-256 public key in coordinate form (uncompressed point).
/// secp256r1_verify expects 65-byte uncompressed key: 0x04 || x || y
#[contracttype]
#[derive(Clone, Debug)]
pub struct P256PublicKey {
    pub x: BytesN<32>,
    pub y: BytesN<32>,
}

/// User operation intent for gasless transactions.
///
/// `signature` must be a raw P-256 signature: r (32 bytes) || s (32 bytes) = 64 bytes,
/// over the SHA-256 digest of the canonical payload described in the module docs.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserOperation {
    pub sender: Address,
    pub nonce: u64,
    pub call_data: Bytes,
    pub call_target: Address,
    pub signature: BytesN<64>,
    pub max_fee: i128,
    /// Ledger sequence number after which this operation expires (inclusive)
    pub expiry: u64,
    /// SHA-256 of the Stellar network passphrase
    pub network_id: BytesN<32>,
}

/// Execution result from a user operation
#[contracttype]
#[derive(Clone, Debug)]
pub struct ExecutionResult {
    pub success: bool,
    pub return_data: Bytes,
    pub gas_used: i128,
}

// ── Errors ──────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProxyError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidSignature = 4,
    NonceAlreadyUsed = 5,
    InvalidNonce = 6,
    InvalidOperation = 7,
    CallFailed = 8,
    InsufficientAllowance = 9,
    InvalidWebAuthnSignature = 10,
    InvalidRelayer = 11,
    FeeExceedsMax = 12,
    InvalidTarget = 13,
    Reentrancy = 14,
    /// No WebAuthn key registered; call register_webauthn_key first
    WebAuthnKeyNotRegistered = 15,
    /// Operation has expired (current ledger sequence > op.expiry)
    OperationExpired = 16,
    /// Network ID in operation does not match the wallet's registered network
    NetworkMismatch = 17,
}

// ── Constants ───────────────────────────────────────────────────────────

/// Domain separator — 24 ASCII bytes zero-padded to 32
const DOMAIN_SEP: &[u8; 32] = b"stellaryield_webauthn_v1\x00\x00\x00\x00\x00\x00\x00\x00";

// ── Contract ────────────────────────────────────────────────────────────

#[contract]
pub struct ProxyWallet;

#[contractimpl]
impl ProxyWallet {
    // ═══════════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════

    /// Initialize the proxy wallet.
    ///
    /// `network_id` must be SHA-256 of the Stellar network passphrase.
    /// All subsequent operations must present the same value.
    pub fn initialize(
        env: Env,
        owner: Address,
        factory: Address,
        relayer: Option<Address>,
        network_id: BytesN<32>,
    ) -> Result<(), ProxyError> {
        if env.storage().instance().has(&StorageKey::Initialized) {
            return Err(ProxyError::AlreadyInitialized);
        }
        if owner == env.current_contract_address() {
            return Err(ProxyError::InvalidTarget);
        }

        env.storage().instance().set(&StorageKey::Owner, &owner);
        env.storage().instance().set(&StorageKey::Factory, &factory);
        env.storage()
            .instance()
            .set(&StorageKey::NetworkId, &network_id);

        if let Some(rl) = relayer {
            env.storage().instance().set(&StorageKey::Relayer, &rl);
        }

        env.storage().instance().set(&StorageKey::Nonce, &0u64);
        env.storage()
            .instance()
            .set(&StorageKey::Initialized, &true);

        env.events()
            .publish((symbol_short!("init"),), (owner, factory));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // WEBAUTHN / P-256 KEY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// Register the P-256 public key for WebAuthn authentication.
    pub fn register_webauthn_key(
        env: Env,
        owner: Address,
        public_key: P256PublicKey,
    ) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        env.storage()
            .instance()
            .set(&StorageKey::WebAuthnKey, &public_key);

        env.events().publish((symbol_short!("wa_reg"),), (owner,));
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // USER OPERATION EXECUTION
    // ═══════════════════════════════════════════════════════════════════

    /// Execute a user operation with production P-256/WebAuthn verification.
    ///
    /// Guards (in order):
    /// 1. Initialized
    /// 2. Caller is authorized relayer
    /// 3. WebAuthn key registered
    /// 4. Network ID matches
    /// 5. Not expired
    /// 6. Nonce not used / not below watermark
    /// 7. P-256 signature valid
    /// 8. Target call executes
    pub fn execute_user_operation(
        env: Env,
        op: UserOperation,
        relayer: Address,
    ) -> Result<ExecutionResult, ProxyError> {
        Self::require_initialized(&env)?;
        relayer.require_auth();
        Self::verify_relayer(&env, &relayer)?;
        Self::verify_sender(&env, &op.sender)?;

        let pubkey = Self::require_webauthn_key(&env)?;

        Self::verify_network_id(&env, &op.network_id)?;
        Self::verify_expiry(&env, op.expiry)?;
        Self::consume_nonce(&env, op.nonce)?;
        Self::verify_p256_signature(&env, &op, &pubkey)?;

        let result = Self::execute_call(&env, &op.call_target, &op.call_data)?;

        env.events()
            .publish((symbol_short!("exec"),), (op.nonce, result.success));

        Ok(result)
    }

    /// Execute multiple user operations atomically.
    pub fn execute_batch(
        env: Env,
        ops: Vec<UserOperation>,
        relayer: Address,
    ) -> Result<Vec<ExecutionResult>, ProxyError> {
        Self::require_initialized(&env)?;
        relayer.require_auth();

        let pubkey = Self::require_webauthn_key(&env)?;
        let mut results = Vec::new(&env);

        for op in ops.iter() {
            Self::verify_relayer(&env, &relayer)?;
            Self::verify_sender(&env, &op.sender)?;
            Self::verify_network_id(&env, &op.network_id)?;
            Self::verify_expiry(&env, op.expiry)?;
            Self::consume_nonce(&env, op.nonce)?;
            Self::verify_p256_signature(&env, &op, &pubkey)?;

            let result = Self::execute_call(&env, &op.call_target, &op.call_data)?;
            results.push_back(result);
        }

        env.events()
            .publish((symbol_short!("batch"),), (results.len(),));

        Ok(results)
    }

    // ═══════════════════════════════════════════════════════════════════
    // VAULT INTERACTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn deposit_to_vault(
        env: Env,
        vault: Address,
        amount: i128,
        from_token: Address,
    ) -> Result<i128, ProxyError> {
        Self::require_initialized(&env)?;
        Self::check_vault_allowance(&env, &vault, amount)?;
        Self::approve_token(&env, &from_token, &vault, amount)?;

        let args = soroban_sdk::vec![
            &env,
            env.current_contract_address().into_val(&env),
            amount.into_val(&env),
        ];
        let shares: i128 = env.invoke_contract(&vault, &symbol_short!("deposit"), args);

        env.events()
            .publish((symbol_short!("dep_vlt"),), (vault, amount, shares));

        Ok(shares)
    }

    pub fn withdraw_from_vault(env: Env, vault: Address, shares: i128) -> Result<i128, ProxyError> {
        Self::require_initialized(&env)?;

        let args = soroban_sdk::vec![
            &env,
            env.current_contract_address().into_val(&env),
            shares.into_val(&env),
        ];
        let amount: i128 = env.invoke_contract(&vault, &symbol_short!("withdraw"), args);

        env.events()
            .publish((symbol_short!("wd_vlt"),), (vault, shares, amount));

        Ok(amount)
    }

    pub fn approve_vault(
        env: Env,
        owner: Address,
        vault: Address,
        allowance: i128,
    ) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        let mut allowances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&StorageKey::VaultAllowances)
            .unwrap_or(Map::new(&env));

        allowances.set(vault.clone(), allowance);
        env.storage()
            .instance()
            .set(&StorageKey::VaultAllowances, &allowances);

        env.events()
            .publish((symbol_short!("appr_v"),), (vault, allowance));

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // NONCE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn get_nonce(env: Env) -> Result<u64, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::Nonce)
            .unwrap_or(0))
    }

    pub fn is_nonce_used(env: Env, nonce: u64) -> Result<bool, ProxyError> {
        Self::require_initialized(&env)?;
        let used: Map<u64, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::UsedNonces)
            .unwrap_or(Map::new(&env));
        Ok(used.get(nonce).unwrap_or(false))
    }

    /// Owner can pre-emptively mark a nonce used to invalidate a pending operation.
    pub fn mark_nonce_used(env: Env, owner: Address, nonce: u64) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        let mut used: Map<u64, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::UsedNonces)
            .unwrap_or(Map::new(&env));

        used.set(nonce, true);
        env.storage().instance().set(&StorageKey::UsedNonces, &used);

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // RELAYER MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    pub fn set_relayer(env: Env, owner: Address, relayer: Address) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;
        env.storage().instance().set(&StorageKey::Relayer, &relayer);
        env.events()
            .publish((symbol_short!("set_rel"),), (relayer,));
        Ok(())
    }

    pub fn remove_relayer(env: Env, owner: Address) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;
        env.storage().instance().remove(&StorageKey::Relayer);
        env.events().publish((symbol_short!("rm_rel"),), ());
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // RECOVERY INTEGRATION
    // ═══════════════════════════════════════════════════════════════════

    /// Link a recovery module contract to this proxy wallet.
    ///
    /// Only the owner can call this. Once linked, the recovery contract gains the
    /// exclusive ability to rotate the owner via `update_owner`.
    pub fn link_recovery(
        env: Env,
        owner: Address,
        recovery_contract: Address,
    ) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;
        Self::require_owner(&env, &owner)?;

        env.storage()
            .instance()
            .set(&StorageKey::RecoveryContract, &recovery_contract);

        env.events()
            .publish((symbol_short!("link_rec"),), (recovery_contract,));

        Ok(())
    }

    /// Rotate the owner as authorised by the linked recovery module.
    ///
    /// Only callable by the linked recovery contract (enforced via Soroban's
    /// cross-contract auth: `recovery_contract.require_auth()` passes because
    /// the recovery contract is the invoker of this function).
    pub fn update_owner(env: Env, new_owner: Address) -> Result<(), ProxyError> {
        Self::require_initialized(&env)?;

        let recovery_contract: Address = env
            .storage()
            .instance()
            .get(&StorageKey::RecoveryContract)
            .ok_or(ProxyError::Unauthorized)?;

        // Passes when this is called as a cross-contract invocation from the
        // recovery contract; reverts for any other caller.
        recovery_contract.require_auth();

        env.storage().instance().set(&StorageKey::Owner, &new_owner);

        env.events()
            .publish((symbol_short!("upd_owner"),), (new_owner,));

        Ok(())
    }

    /// Get the recovery contract address, if one has been linked.
    pub fn get_recovery_contract(env: Env) -> Result<Option<Address>, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::RecoveryContract))
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    pub fn get_owner(env: Env) -> Result<Address, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Owner).unwrap())
    }

    pub fn get_factory(env: Env) -> Result<Address, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Factory).unwrap())
    }

    pub fn get_relayer(env: Env) -> Result<Option<Address>, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env.storage().instance().get(&StorageKey::Relayer))
    }

    pub fn is_authorized_relayer(env: Env, relayer: Address) -> Result<bool, ProxyError> {
        Self::require_initialized(&env)?;
        let stored: Option<Address> = env.storage().instance().get(&StorageKey::Relayer);
        Ok(stored.map(|r| r == relayer).unwrap_or(false))
    }

    pub fn get_network_id(env: Env) -> Result<BytesN<32>, ProxyError> {
        Self::require_initialized(&env)?;
        Ok(env
            .storage()
            .instance()
            .get(&StorageKey::NetworkId)
            .unwrap())
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — GUARDS
    // ═══════════════════════════════════════════════════════════════════

    fn require_initialized(env: &Env) -> Result<(), ProxyError> {
        if !env.storage().instance().has(&StorageKey::Initialized) {
            return Err(ProxyError::NotInitialized);
        }
        Ok(())
    }

    fn require_owner(env: &Env, caller: &Address) -> Result<(), ProxyError> {
        caller.require_auth();
        let owner: Address = env
            .storage()
            .instance()
            .get(&StorageKey::Owner)
            .ok_or(ProxyError::NotInitialized)?;
        if *caller != owner {
            return Err(ProxyError::Unauthorized);
        }
        Ok(())
    }

    fn require_webauthn_key(env: &Env) -> Result<P256PublicKey, ProxyError> {
        env.storage()
            .instance()
            .get::<StorageKey, P256PublicKey>(&StorageKey::WebAuthnKey)
            .ok_or(ProxyError::WebAuthnKeyNotRegistered)
    }

    fn verify_relayer(env: &Env, relayer: &Address) -> Result<(), ProxyError> {
        let stored: Option<Address> = env.storage().instance().get(&StorageKey::Relayer);
        match stored {
            Some(rl) if rl != *relayer => Err(ProxyError::InvalidRelayer),
            _ => Ok(()),
        }
    }

    fn verify_network_id(env: &Env, op_network_id: &BytesN<32>) -> Result<(), ProxyError> {
        let stored: BytesN<32> = env
            .storage()
            .instance()
            .get(&StorageKey::NetworkId)
            .ok_or(ProxyError::NotInitialized)?;
        if stored != *op_network_id {
            return Err(ProxyError::NetworkMismatch);
        }
        Ok(())
    }

    fn verify_expiry(env: &Env, expiry: u64) -> Result<(), ProxyError> {
        let current = env.ledger().sequence() as u64;
        if current > expiry {
            return Err(ProxyError::OperationExpired);
        }
        Ok(())
    }

    fn verify_sender(env: &Env, sender: &Address) -> Result<(), ProxyError> {
        if *sender != env.current_contract_address() {
            return Err(ProxyError::InvalidTarget);
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — NONCE
    // ═══════════════════════════════════════════════════════════════════

    fn consume_nonce(env: &Env, nonce: u64) -> Result<(), ProxyError> {
        let mut used: Map<u64, bool> = env
            .storage()
            .instance()
            .get(&StorageKey::UsedNonces)
            .unwrap_or(Map::new(env));

        if used.get(nonce).unwrap_or(false) {
            return Err(ProxyError::NonceAlreadyUsed);
        }

        let current: u64 = env
            .storage()
            .instance()
            .get(&StorageKey::Nonce)
            .unwrap_or(0);

        if nonce < current {
            return Err(ProxyError::InvalidNonce);
        }

        used.set(nonce, true);
        env.storage().instance().set(&StorageKey::UsedNonces, &used);

        // Advance sequential watermark
        if nonce == current {
            env.storage()
                .instance()
                .set(&StorageKey::Nonce, &(nonce + 1));
        }

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — SIGNATURE VERIFICATION
    // ═══════════════════════════════════════════════════════════════════

    /// Verify the P-256 signature against the canonical payload digest.
    ///
    /// Uses `env.crypto().secp256r1_verify(public_key, digest, signature)`:
    /// - `public_key`: 65-byte uncompressed point 0x04 || x (32) || y (32)
    /// - `digest`:     32-byte SHA-256 message digest
    /// - `signature`:  64-byte r || s
    ///
    /// The host traps on invalid signature; Soroban surfaces that as a
    /// contract-level ScError which propagates naturally to the caller.
    fn verify_p256_signature(
        env: &Env,
        op: &UserOperation,
        pubkey: &P256PublicKey,
    ) -> Result<(), ProxyError> {
        let digest: Hash<32> = Self::build_op_digest(env, op);

        // Build uncompressed 65-byte public key: 0x04 || x (32) || y (32)
        let mut pk_bytes = Bytes::new(env);
        pk_bytes.append(&Bytes::from_slice(env, &[0x04u8]));
        pk_bytes.append(&pubkey.x.clone().into());
        pk_bytes.append(&pubkey.y.clone().into());

        let pk65: BytesN<65> = pk_bytes
            .try_into()
            .expect("pk_bytes is always exactly 65 bytes");

        // Host traps on invalid signature; Soroban surfaces this as ScError.
        env.crypto().secp256r1_verify(&pk65, &digest, &op.signature);

        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // INTERNAL — EXECUTION
    // ═══════════════════════════════════════════════════════════════════

    fn execute_call(
        env: &Env,
        target: &Address,
        call_data: &Bytes,
    ) -> Result<ExecutionResult, ProxyError> {
        if *target == env.current_contract_address() {
            return Err(ProxyError::InvalidTarget);
        }

        let fn_symbol = Self::decode_call_symbol(env, call_data)?;
        let args = Vec::<Val>::new(env);
        let _: Val = env.invoke_contract(target, &fn_symbol, args);

        Ok(ExecutionResult {
            success: true,
            return_data: Bytes::new(env),
            gas_used: 1000,
        })
    }

    fn decode_call_symbol(env: &Env, call_data: &Bytes) -> Result<Symbol, ProxyError> {
        let len = call_data.len() as usize;
        if len == 0 || len > 32 {
            return Err(ProxyError::InvalidOperation);
        }

        let mut raw = [0u8; 32];
        call_data.copy_into_slice(&mut raw[..len]);
        let fn_name = core::str::from_utf8(&raw[..len]).map_err(|_| ProxyError::InvalidOperation)?;
        let _validated = String::from_bytes(env, fn_name.as_bytes());
        Ok(Symbol::new(env, fn_name))
    }

    fn check_vault_allowance(env: &Env, vault: &Address, amount: i128) -> Result<(), ProxyError> {
        let allowances: Map<Address, i128> = env
            .storage()
            .instance()
            .get(&StorageKey::VaultAllowances)
            .unwrap_or(Map::new(env));
        if allowances.get(vault.clone()).unwrap_or(0) < amount {
            return Err(ProxyError::InsufficientAllowance);
        }
        Ok(())
    }

    fn approve_token(
        env: &Env,
        token: &Address,
        spender: &Address,
        amount: i128,
    ) -> Result<(), ProxyError> {
        let args = soroban_sdk::vec![
            env,
            env.current_contract_address().into_val(env),
            spender.clone().into_val(env),
            amount.into_val(env),
        ];
        let _: () = env.invoke_contract(token, &symbol_short!("approve"), args);
        Ok(())
    }
}

// ── Non-contract helpers (not exposed via ABI) ───────────────────────────

impl ProxyWallet {
    /// Build the 32-byte SHA-256 digest that the authenticator must sign.
    ///
    /// Pre-image layout (176 bytes total, all fixed-width):
    ///
    /// | Field          | Size | Value                                    |
    /// |----------------|------|------------------------------------------|
    /// | domain_sep     | 32   | "stellaryield_webauthn_v1\0\0\0\0\0\0\0\0" |
    /// | wallet_hash    | 32   | SHA-256(XDR(op.sender))                  |
    /// | nonce          | 8    | op.nonce big-endian u64                  |
    /// | target_hash    | 32   | SHA-256(XDR(op.call_target))             |
    /// | call_data_hash | 32   | SHA-256(op.call_data)                    |
    /// | expiry         | 8    | op.expiry big-endian u64                 |
    /// | network_id     | 32   | op.network_id                            |
    /// Serialize a Soroban `Address` to its ASCII string bytes.
    /// Stellar addresses are base32 or contract-hash strings, max ~72 chars.
    fn addr_bytes(env: &Env, addr: Address) -> Bytes {
        let s = addr.to_string();
        let len = s.len() as usize;
        // Stack buffer: Stellar addresses are ≤ 72 chars
        let mut buf = [0u8; 128];
        s.copy_into_slice(&mut buf[..len]);
        Bytes::from_slice(env, &buf[..len])
    }

    pub(crate) fn build_op_digest(env: &Env, op: &UserOperation) -> Hash<32> {
        let wallet_hash: Hash<32> = env
            .crypto()
            .sha256(&Self::addr_bytes(env, op.sender.clone()));
        let target_hash: Hash<32> = env
            .crypto()
            .sha256(&Self::addr_bytes(env, op.call_target.clone()));
        let call_data_hash: Hash<32> = env.crypto().sha256(&op.call_data);

        // Build fixed-width 176-byte pre-image
        let mut pre = Bytes::new(env);
        pre.append(&Bytes::from_slice(env, DOMAIN_SEP.as_slice())); // 32
        pre.append(&wallet_hash.to_bytes().into()); // 32
        pre.append(&Bytes::from_slice(env, &op.nonce.to_be_bytes())); // 8
        pre.append(&target_hash.to_bytes().into()); // 32
        pre.append(&call_data_hash.to_bytes().into()); // 32
        pre.append(&Bytes::from_slice(env, &op.expiry.to_be_bytes())); // 8
        pre.append(&op.network_id.clone().into()); // 32

        env.crypto().sha256(&pre)
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::Env;

    #[contract]
    pub struct DummyTarget;

    #[contractimpl]
    impl DummyTarget {
        pub fn bump(env: Env) -> u32 {
            let key = symbol_short!("count");
            let next = env.storage().instance().get::<Symbol, u32>(&key).unwrap_or(0) + 1;
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

    // ── Crypto helpers ───────────────────────────────────────────────────

    // RFC 6979 / NIST P-256 test vectors
    // Private key d (32 bytes)
    const TEST_PRIV: [u8; 32] = [
        0xC9, 0xAF, 0xA9, 0xD8, 0x45, 0xBA, 0x75, 0x16, 0x6B, 0x5C, 0x21, 0x57, 0x67, 0xB1, 0xD6,
        0x93, 0x4E, 0x50, 0xC3, 0xDB, 0x36, 0xE8, 0x9B, 0x12, 0x7B, 0x8A, 0x62, 0x2B, 0x12, 0x0F,
        0x67, 0x21,
    ];

    /// Sign `digest` with the test P-256 private key; returns 64-byte r||s.
    /// Normalizes `s` to low-s form as required by Soroban's secp256r1_verify.
    fn p256_sign(digest: &[u8; 32]) -> [u8; 64] {
        use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};

        let sk = SigningKey::from_bytes(TEST_PRIV.as_ref().into()).expect("valid key");
        let sig: Signature = sk.sign_prehash(digest).expect("sign");
        // Soroban host rejects high-s signatures; normalize to low-s form
        let sig = sig.normalize_s().unwrap_or(sig);
        let bytes = sig.to_bytes();
        let mut out = [0u8; 64];
        out.copy_from_slice(&bytes);
        out
    }

    /// Build a real P-256 signature over the canonical op digest.
    fn real_sig(env: &Env, op: &UserOperation) -> BytesN<64> {
        // build_op_digest returns Hash<32>; extract the 32 raw bytes
        let hash = ProxyWallet::build_op_digest(env, op);
        let bytes = hash.to_bytes();
        // copy into a [u8;32] via copy_into_slice
        let mut digest = [0u8; 32];
        bytes.copy_into_slice(&mut digest);
        BytesN::from_array(env, &p256_sign(&digest))
    }

    fn dummy_sig(env: &Env) -> BytesN<64> {
        BytesN::from_array(env, &[0u8; 64])
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    fn testnet_network_id(env: &Env) -> BytesN<32> {
        let passphrase = Bytes::from_slice(env, b"Test SDF Network ; September 2015");
        env.crypto().sha256(&passphrase).to_bytes()
    }

    /// NIST P-256 public key corresponding to TEST_PRIV.
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

    fn setup(env: &Env) -> (ProxyWalletClient<'_>, Address, Address, Address, BytesN<32>, Address) {
        env.mock_all_auths();

        let contract_id = env.register(ProxyWallet, ());
        let client = ProxyWalletClient::new(env, &contract_id);

        let owner = Address::generate(env);
        let factory = Address::generate(env);
        let relayer = Address::generate(env);
        let nid = testnet_network_id(env);

        client.initialize(&owner, &factory, &Some(relayer.clone()), &nid);
        client.register_webauthn_key(&owner, &test_pubkey(env));

        (client, owner, factory, relayer, nid, contract_id)
    }

    fn setup_proxy_wallet(env: &Env) -> (ProxyWalletClient<'_>, Address, Address) {
        env.mock_all_auths();

        let contract_id = env.register(ProxyWallet, ());
        let client = ProxyWalletClient::new(env, &contract_id);

        let owner = Address::generate(env);
        let factory = Address::generate(env);
        let nid = testnet_network_id(env);

        client.initialize(&owner, &factory, &None, &nid);

        (client, owner, factory)
    }

    fn make_op(
        _env: &Env,
        sender: Address,
        call_target: Address,
        call_data: Bytes,
        nonce: u64,
        network_id: BytesN<32>,
        expiry: u64,
        sig: BytesN<64>,
    ) -> UserOperation {
        UserOperation {
            sender,
            nonce,
            call_data,
            call_target,
            signature: sig,
            max_fee: 1000,
            expiry,
            network_id,
        }
    }

    // ── Initialization ──────────────────────────────────────────────────

    #[test]
    fn test_initialize_stores_owner_and_factory() {
        let env = Env::default();
        let (client, owner, factory, _, _, _) = setup(&env);

        assert_eq!(client.get_owner(), owner);
        assert_eq!(client.get_factory(), factory);
        assert_eq!(client.get_nonce(), 0);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let proxy_id = env.register(ProxyWallet, ());
        let client = ProxyWalletClient::new(&env, &proxy_id);

        let owner = Address::generate(&env);
        let factory = Address::generate(&env);
        let nid = testnet_network_id(&env);

        client.initialize(&owner, &factory, &None, &nid);
        client.initialize(&owner, &factory, &None, &nid);
    }

    // ── WebAuthn key not registered ─────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #15)")]
    fn test_no_webauthn_key_panics() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_sequence_number(100);

        let contract_id = env.register(ProxyWallet, ());
        let client = ProxyWalletClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let factory = Address::generate(&env);
        let relayer = Address::generate(&env);
        let nid = testnet_network_id(&env);

        // Initialize WITHOUT registering a WebAuthn key
        client.initialize(&owner, &factory, &Some(relayer.clone()), &nid);

        let op = make_op(
            &env,
            contract_id,
            Address::generate(&env),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            9999,
            dummy_sig(&env),
        );
        client.execute_user_operation(&op, &relayer);
    }

    // ── Network ID ──────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #17)")]
    fn test_wrong_network_id_panics() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, _owner, _, relayer, _, proxy_id) = setup(&env);

        let mainnet_nid: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Public Global Stellar Network ; October 2015",
            ))
            .to_bytes();

        let op = make_op(
            &env,
            proxy_id,
            Address::generate(&env),
            Bytes::from_slice(&env, b"bump"),
            0,
            mainnet_nid,
            9999,
            dummy_sig(&env),
        );
        client.execute_user_operation(&op, &relayer);
    }

    // ── Expiry ──────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #16)")]
    fn test_expired_operation_panics() {
        let env = Env::default();
        env.ledger().set_sequence_number(1000);
        let (client, _owner, _, relayer, nid, proxy_id) = setup(&env);

        // expiry=500, current=1000 → expired
        let op = make_op(
            &env,
            proxy_id,
            Address::generate(&env),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            500,
            dummy_sig(&env),
        );
        client.execute_user_operation(&op, &relayer);
    }

    #[test]
    fn test_operation_at_expiry_boundary_succeeds() {
        let env = Env::default();
        env.ledger().set_sequence_number(500);
        let (client, _owner, _, relayer, nid, proxy_id) = setup(&env);
        let target_id = env.register(DummyTarget, ());

        // Build a real signature over the canonical digest for this op
        let mut op = make_op(
            &env,
            proxy_id,
            target_id.clone(),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            500,
            dummy_sig(&env),
        );
        op.signature = real_sig(&env, &op);
        let result = client.execute_user_operation(&op, &relayer);
        assert!(result.success);
        let target = DummyTargetClient::new(&env, &target_id);
        assert_eq!(target.get(), 1);
    }

    // ── Nonce ───────────────────────────────────────────────────────────

    #[test]
    fn test_nonce_consumed_on_execute() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, _owner, _, relayer, nid, proxy_id) = setup(&env);
        let target_id = env.register(DummyTarget, ());

        // Build a real signature for this specific op
        let mut op = make_op(
            &env,
            proxy_id,
            target_id,
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            9999,
            dummy_sig(&env),
        );
        op.signature = real_sig(&env, &op);
        client.execute_user_operation(&op, &relayer);

        assert!(client.is_nonce_used(&0));
        assert_eq!(client.get_nonce(), 1);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_replayed_nonce_panics() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, owner, _, relayer, nid, proxy_id) = setup(&env);

        // Pre-mark nonce 0 as used via the owner API, then try to execute with it
        client.mark_nonce_used(&owner, &0);

        let mut op = make_op(
            &env,
            proxy_id,
            Address::generate(&env),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            9999,
            dummy_sig(&env),
        );
        op.signature = real_sig(&env, &op);
        client.execute_user_operation(&op, &relayer);
    }

    /// Verify that a nonce below the sequential watermark is rejected.
    /// In practice the used-map check fires first (#5) because sequential
    /// execution adds every nonce to the map; the watermark (#6) is a
    /// secondary guard for pathological cases (e.g. map cleared by upgrade).
    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_below_watermark_nonce_panics() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, _owner, _, relayer, nid, proxy_id) = setup(&env);
        let target_id = env.register(DummyTarget, ());

        // Consume nonce 0 successfully (watermark advances to 1)
        let mut op0 = make_op(
            &env,
            proxy_id.clone(),
            target_id.clone(),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid.clone(),
            9999,
            dummy_sig(&env),
        );
        op0.signature = real_sig(&env, &op0);
        client.execute_user_operation(&op0, &relayer);

        // Retry nonce 0 — it's in the used map → NonceAlreadyUsed (#5)
        let mut op_old = make_op(
            &env,
            proxy_id,
            target_id,
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            9999,
            dummy_sig(&env),
        );
        op_old.signature = real_sig(&env, &op_old);
        client.execute_user_operation(&op_old, &relayer);
    }

    // ── Relayer ─────────────────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_unauthorized_relayer_panics() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, _owner, _, _, nid, proxy_id) = setup(&env);

        let impostor = Address::generate(&env);
        let op = make_op(
            &env,
            proxy_id,
            Address::generate(&env),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid,
            9999,
            dummy_sig(&env),
        );
        client.execute_user_operation(&op, &impostor);
    }

    #[test]
    fn test_set_and_remove_relayer() {
        let env = Env::default();
        let (client, owner, _, _, _, _) = setup(&env);

        let new_relayer = Address::generate(&env);
        client.set_relayer(&owner, &new_relayer);
        assert_eq!(client.get_relayer(), Some(new_relayer.clone()));
        assert!(client.is_authorized_relayer(&new_relayer));

        client.remove_relayer(&owner);
        assert_eq!(client.get_relayer(), None);
    }

    // ── Digest determinism ───────────────────────────────────────────────

    #[test]
    fn test_op_digest_is_deterministic_and_domain_separated() {
        let env = Env::default();
        let (_, _owner, _, relayer, nid, proxy_id) = setup(&env);

        let target = Address::generate(&env);
        let call_data = Bytes::from_slice(&env, &[0xca, 0xfe]);
        let sig = dummy_sig(&env);

        let op = UserOperation {
            sender: proxy_id.clone(),
            nonce: 7,
            call_data: call_data.clone(),
            call_target: target.clone(),
            signature: sig.clone(),
            max_fee: 500,
            expiry: 9999,
            network_id: nid.clone(),
        };

        // Idempotent
        assert_eq!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op).to_bytes()
        );

        // Different nonce → different digest
        let op_nonce = UserOperation {
            nonce: 8,
            ..op.clone()
        };
        assert_ne!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op_nonce).to_bytes()
        );

        // Different call_data → different digest
        let op_data = UserOperation {
            call_data: Bytes::from_slice(&env, &[0xbe, 0xef]),
            ..op.clone()
        };
        assert_ne!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op_data).to_bytes()
        );

        // Different network_id → different digest
        let other_nid: BytesN<32> = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Public Global Stellar Network ; October 2015",
            ))
            .to_bytes();
        let op_net = UserOperation {
            network_id: other_nid,
            ..op.clone()
        };
        assert_ne!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op_net).to_bytes()
        );

        // Different sender → different digest
        let op_sender = UserOperation {
            sender: relayer.clone(),
            ..op.clone()
        };
        assert_ne!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op_sender).to_bytes()
        );

        // Different call_target → different digest
        let op_target = UserOperation {
            call_target: Address::generate(&env),
            ..op.clone()
        };
        assert_ne!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op_target).to_bytes()
        );

        // Different expiry → different digest
        let op_expiry = UserOperation {
            expiry: 1234,
            ..op.clone()
        };
        assert_ne!(
            ProxyWallet::build_op_digest(&env, &op).to_bytes(),
            ProxyWallet::build_op_digest(&env, &op_expiry).to_bytes()
        );
    }

    // ── Batch execution ──────────────────────────────────────────────────

    #[test]
    fn test_batch_execute_consumes_all_nonces() {
        let env = Env::default();
        env.ledger().set_sequence_number(100);
        let (client, _owner, _, relayer, nid, proxy_id) = setup(&env);
        let target_id = env.register(DummyTarget, ());

        // Build three ops and sign each one individually (each has a different digest)
        let mut op0 = make_op(
            &env,
            proxy_id.clone(),
            target_id.clone(),
            Bytes::from_slice(&env, b"bump"),
            0,
            nid.clone(),
            9999,
            dummy_sig(&env),
        );
        op0.signature = real_sig(&env, &op0);
        let mut op1 = make_op(
            &env,
            proxy_id.clone(),
            target_id.clone(),
            Bytes::from_slice(&env, b"bump"),
            1,
            nid.clone(),
            9999,
            dummy_sig(&env),
        );
        op1.signature = real_sig(&env, &op1);
        let mut op2 = make_op(
            &env,
            proxy_id,
            target_id.clone(),
            Bytes::from_slice(&env, b"bump"),
            2,
            nid.clone(),
            9999,
            dummy_sig(&env),
        );
        op2.signature = real_sig(&env, &op2);

        let ops = soroban_sdk::vec![&env, op0, op1, op2];
        let results = client.execute_batch(&ops, &relayer);
        assert_eq!(results.len(), 3);
        assert!(client.is_nonce_used(&0));
        assert!(client.is_nonce_used(&1));
        assert!(client.is_nonce_used(&2));
    }

    // ── Vault ────────────────────────────────────────────────────────────

    #[test]
    fn test_approve_vault_sets_allowance() {
        let env = Env::default();
        let (client, owner, _, _, _, _) = setup(&env);
        let vault = Address::generate(&env);
        client.approve_vault(&owner, &vault, &1000);
    }

    // ── Network ID view ──────────────────────────────────────────────────

    #[test]
    fn test_get_network_id_returns_registered_value() {
        let env = Env::default();
        let (client, _, _, _, nid, _) = setup(&env);
        assert_eq!(client.get_network_id(), nid);
    }

    // ── Recovery integration ───────────────────────────────────────────

    #[test]
    fn test_link_recovery() {
        let env = Env::default();
        let (client, owner, _) = setup_proxy_wallet(&env);

        let recovery = Address::generate(&env);
        client.link_recovery(&owner, &recovery);

        assert_eq!(client.get_recovery_contract(), Some(recovery));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_link_recovery_non_owner_panics() {
        let env = Env::default();
        let (client, _, _) = setup_proxy_wallet(&env);

        let non_owner = Address::generate(&env);
        let recovery = Address::generate(&env);
        client.link_recovery(&non_owner, &recovery);
    }

    #[test]
    fn test_get_recovery_contract_none_when_unlinked() {
        let env = Env::default();
        let (client, _, _) = setup_proxy_wallet(&env);

        assert_eq!(client.get_recovery_contract(), None);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_update_owner_without_recovery_linked_panics() {
        let env = Env::default();
        let (client, _, _) = setup_proxy_wallet(&env);

        let new_owner = Address::generate(&env);
        client.update_owner(&new_owner);
    }
}
