use soroban_sdk::{contracttype, Address, Env};

/// Low watermark: keys older than this many ledgers trigger a bump.
#[allow(dead_code)]
pub const TTL_LOW_WATERMARK_LEDGERS: u32 = 100_000; // ~5-7 days at ~6 sec blocks

/// Amount to extend TTL by when bumping.
#[allow(dead_code)]
pub const TTL_BUMP_LEDGER_AMOUNT: u32 = 250_000; // ~14 days

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    SUSDToken,
    CollateralToken, // The vault shares (SAC)
    VaultMetrics,    // The contract with total_assets/shares
    Oracle,
    Cdp(Address),
    Icr,          // Initial Collateralization Ratio (bps)
    Mcr,          // Maintenance Collateralization Ratio (bps)
    InterestRate, // Per second (scaled by 1e18)
    CumulativeIndex,
    LastUpdate,
    Initialized,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cdp {
    pub collateral: i128,
    pub debt_shares: i128,
    pub last_index: i128,
}

pub const SCALAR_18: i128 = 1_000_000_000_000_000_000;

/// Read a CDP and bump its TTL to prevent expiry.
#[allow(dead_code)]
pub fn read_cdp(e: &Env, user: &Address) -> Option<Cdp> {
    let key = DataKey::Cdp(user.clone());
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

/// Write a CDP and bump its TTL.
#[allow(dead_code)]
pub fn write_cdp(e: &Env, user: &Address, cdp: &Cdp) {
    let key = DataKey::Cdp(user.clone());
    e.storage().persistent().set(&key, cdp);
    // Bump TTL after writing to ensure it's persisted
    e.storage()
        .persistent()
        .extend_ttl(&key, TTL_LOW_WATERMARK_LEDGERS, TTL_BUMP_LEDGER_AMOUNT);
}
