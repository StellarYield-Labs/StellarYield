use soroban_sdk::{contracttype, Address, Env};

/// Low watermark: keys older than this many ledgers trigger a bump.
pub const TTL_LOW_WATERMARK_LEDGERS: u32 = 100_000; // ~5-7 days at ~6 sec blocks

/// Amount to extend TTL by when bumping.
pub const TTL_BUMP_LEDGER_AMOUNT: u32 = 250_000; // ~14 days

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    Oracle,
    OptionCounter,
    Option(u32),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OptionType {
    Call,
    Put,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionData {
    pub minter: Address,
    pub option_type: OptionType,
    pub underlying_asset: Address,
    pub quote_asset: Address,
    pub strike_price: i128,   // Scaled by 1e7
    pub expiration_time: u64, // Unix timestamp
    pub collateral_amount: i128,
    pub exercised: bool,
    pub expired: bool,
}

pub fn has_admin(e: &Env) -> bool {
    e.storage().instance().has(&DataKey::Admin)
}

#[allow(dead_code)]
pub fn read_admin(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Admin).unwrap()
}

pub fn write_admin(e: &Env, id: &Address) {
    e.storage().instance().set(&DataKey::Admin, id);
}

#[allow(dead_code)]
pub fn read_oracle(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::Oracle).unwrap()
}

pub fn write_oracle(e: &Env, id: &Address) {
    e.storage().instance().set(&DataKey::Oracle, id);
}

pub fn read_option_counter(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&DataKey::OptionCounter)
        .unwrap_or(0)
}

pub fn write_option_counter(e: &Env, counter: u32) {
    e.storage()
        .instance()
        .set(&DataKey::OptionCounter, &counter);
}

pub fn read_option(e: &Env, id: u32) -> Option<OptionData> {
    let key = DataKey::Option(id);
    // Only bump TTL if the key exists to avoid MissingValue errors in tests
    if e.storage().persistent().has(&key) {
        e.storage().persistent().extend_ttl(
            &key,
            TTL_LOW_WATERMARK_LEDGERS,
            TTL_BUMP_LEDGER_AMOUNT,
        );
    }
    e.storage().persistent().get(&key)
}

pub fn write_option(e: &Env, id: u32, option: &OptionData) {
    let key = DataKey::Option(id);
    e.storage().persistent().set(&key, option);
    // Bump TTL after writing to ensure it's persisted
    e.storage()
        .persistent()
        .extend_ttl(&key, TTL_LOW_WATERMARK_LEDGERS, TTL_BUMP_LEDGER_AMOUNT);
}
