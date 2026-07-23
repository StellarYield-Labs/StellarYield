# Soroban Storage TTL Strategy

This document audits current storage usage and defines lifecycle policy for contract keys.

## Scope

- `contracts/options/src/storage.rs`
- `contracts/stablecoin_manager/src/storage.rs`
- `contracts/ve_tokenomics/src/storage.rs`
- `contracts/strategies/delta_neutral/src/storage.rs`

## Lifecycle Rules

- `instance` storage: configuration and global counters tied to contract lifetime.
- `persistent` storage: user state and long-lived positions that must survive inactivity.
- `temporary` storage: short-lived cache data (not currently used in the audited modules).

## Key Inventory

### `options`

| Key             | Class      | Intended lifetime                                 | TTL extension needed |
| --------------- | ---------- | ------------------------------------------------- | -------------------- |
| `Admin`         | instance   | contract lifetime                                 | No                   |
| `Oracle`        | instance   | contract lifetime                                 | No                   |
| `OptionCounter` | instance   | contract lifetime                                 | No                   |
| `Option(id)`    | persistent | until exercised/expired + post-trade audit period | Yes (recommended)    |

Notes:

- `Option(id)` can remain unread for long periods before expiration. Persistent TTL bump policy should be added on read/write paths.

### `stablecoin_manager`

| Key                                                                          | Class      | Intended lifetime           | TTL extension needed |
| ---------------------------------------------------------------------------- | ---------- | --------------------------- | -------------------- |
| `Admin`, `SUSDToken`, `CollateralToken`, `VaultMetrics`, `Oracle`            | instance   | contract lifetime           | No                   |
| `ICR`, `MCR`, `InterestRate`, `CumulativeIndex`, `LastUpdate`, `Initialized` | instance   | contract lifetime           | No                   |
| `CDP(user)`                                                                  | persistent | user debt position lifetime | Yes (recommended)    |

Notes:

- `CDP(user)` should receive TTL bump on updates and critical reads to reduce accidental expiry of active debt records.

### `ve_tokenomics`

| Key                                                          | Class      | Intended lifetime                                        | TTL extension needed |
| ------------------------------------------------------------ | ---------- | -------------------------------------------------------- | -------------------- |
| `Admin`, `YieldToken`, `TotalVotingPower`, `Initialized`     | instance   | contract lifetime                                        | No                   |
| `UserLock(user)`, `GaugeVote(user)`, `PoolTotalWeight(pool)` | persistent | until lock expiry and governance accounting finalization | Yes (recommended)    |

Notes:

- Voting and lock records are long-lived governance state. Add explicit bumping and cleanup windows after lock expiry.

### `delta_neutral` strategy

| Key                                                                                                                                          | Class      | Intended lifetime                                        | TTL extension needed |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------- | -------------------- |
| `Admin`, `UsdcToken`, `SpotToken`, `AmmRouter`, `PerpExchange`, `Oracle`, `Initialized`, `Paused`, `TotalDeposited`, `RebalanceThresholdBps` | instance   | contract lifetime                                        | No                   |
| `Position(user)`                                                                                                                             | persistent | while position exists and during settlement/audit period | Yes (recommended)    |

Notes:

- `Position(user)` should be bumped on open/close/rebalance/funding operations to avoid expiry for low-frequency users.

## Implementation Status

### Completed

✅ **TTL Bump Constants**: Added `TTL_LOW_WATERMARK_LEDGERS` (100,000 ledgers ~5-7 days) and `TTL_BUMP_LEDGER_AMOUNT` (250,000 ledgers ~14 days) to all four contracts.

✅ **Helper Functions**: Implemented dedicated read/write helpers with automatic TTL extension:

- `options`: `read_option()`, `write_option()`
- `stablecoin_manager`: `read_cdp()`, `write_cdp()`
- `ve_tokenomics`: `read_user_lock()`, `write_user_lock()`, `read_gauge_vote()`, `write_gauge_vote()`
- `delta_neutral`: Updated `read_position()`, `write_position()` with TTL extension

✅ **Regression Tests**: Added test coverage validating TTL bumping:

- Each contract has tests confirming TTL extension on read and write paths.
- Tests fail if TTL bump logic is removed (assertion-level coverage).

### Pending / Future Work

- TODO: Add migration plan for legacy entries written before bump logic was enabled.
- TODO: Consider post-expiry cleanup jobs for stale governance/option records to cap state growth.
- TODO: Monitor ledger costs and adjust `TTL_BUMP_LEDGER_AMOUNT` if needed based on operational patterns.
