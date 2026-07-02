use soroban_sdk::{contracttype, Address, Env};

/// Low watermark: keys older than this many ledgers trigger a bump.
pub const TTL_LOW_WATERMARK_LEDGERS: u32 = 100_000; // ~5-7 days at ~6 sec blocks

/// Amount to extend TTL by when bumping.
pub const TTL_BUMP_LEDGER_AMOUNT: u32 = 250_000; // ~14 days

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    YieldToken,
    UserLock(Address),
    TotalVotingPower,         // Placeholder for global state
    GaugeVote(Address),       // User's set of votes
    PoolTotalWeight(Address), // Total weight for a specific pool
    Initialized,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserLock {
    pub amount: i128,
    pub end: u64,
}

pub const MAX_TIME: u64 = 4 * 365 * 24 * 60 * 60; // 4 years in seconds
pub const WEEK: u64 = 7 * 24 * 60 * 60; // 1 week in seconds

/// Read a user lock and bump its TTL.
pub fn read_user_lock(e: &Env, user: &Address) -> Option<UserLock> {
    let key = DataKey::UserLock(user.clone());
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

/// Write a user lock and bump its TTL.
pub fn write_user_lock(e: &Env, user: &Address, lock: &UserLock) {
    let key = DataKey::UserLock(user.clone());
    e.storage().persistent().set(&key, lock);
    // Bump TTL after writing to ensure it's persisted
    e.storage()
        .persistent()
        .extend_ttl(&key, TTL_LOW_WATERMARK_LEDGERS, TTL_BUMP_LEDGER_AMOUNT);
}

/// Read a gauge vote and bump its TTL.
pub fn read_gauge_vote(e: &Env, user: &Address) -> Option<soroban_sdk::Vec<(Address, i128)>> {
    let key = DataKey::GaugeVote(user.clone());
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

/// Write a gauge vote and bump its TTL.
pub fn write_gauge_vote(e: &Env, user: &Address, votes: &soroban_sdk::Vec<(Address, i128)>) {
    let key = DataKey::GaugeVote(user.clone());
    e.storage().persistent().set(&key, votes);
    // Bump TTL after writing to ensure it's persisted
    e.storage()
        .persistent()
        .extend_ttl(&key, TTL_LOW_WATERMARK_LEDGERS, TTL_BUMP_LEDGER_AMOUNT);
}
