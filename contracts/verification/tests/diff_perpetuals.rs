//! Differential + property tests for `contracts/perpetuals`.
//!
//! Perpetual math (`calculate_vamm_output`, `calculate_liquidation_price`,
//! `update_funding`, ...) reads contract storage internally (risk
//! parameters, vAMM reserves), so unlike the other four subsystems this
//! drives the contract through its public entry points
//! (`open_position`/`close_position`/`get_unrealized_pnl`/...) via
//! `soroban_sdk::testutils` rather than calling private math helpers
//! directly — a black-box differential test at the contract-call boundary.

use perpetuals::{
    PerpetualError, PerpetualExchange, PerpetualExchangeClient, PositionSide, TradeParams,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, Env};

use verification::reference::perpetuals::{self as refmodel, Side};
use verification::tolerance::{PERP_LIQUIDATION_PRICE, PERP_OPEN_INTEREST, PERP_PNL};
use verification::vectors::{amount_i128, case_count, rng_for_seed};

/// Full contract deployments are far more expensive than pure-math calls;
/// cap the loop count independently of `VERIFICATION_CASES` rather than
/// running (e.g.) 10,000 fresh `Env`s in the extended job.
fn cases() -> u64 {
    case_count().min(150) as u64
}

fn to_side(side: PositionSide) -> Side {
    match side {
        PositionSide::Long => Side::Long,
        PositionSide::Short => Side::Short,
    }
}

fn setup(
    virtual_base: i128,
    virtual_quote: i128,
    max_leverage: u32,
) -> (Env, PerpetualExchangeClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let index_token = Address::generate(&env);
    let quote_admin = Address::generate(&env);
    let quote = env
        .register_stellar_asset_contract_v2(quote_admin)
        .address();
    let fee_recipient = Address::generate(&env);

    let contract_id = env.register(PerpetualExchange, ());
    let client = PerpetualExchangeClient::new(&env, &contract_id);
    client.initialize(
        &admin,
        &oracle,
        &index_token,
        &quote,
        &virtual_base,
        &virtual_quote,
        &max_leverage,
        &fee_recipient,
    );
    (env, client, quote)
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token).mint(to, &amount);
}

fn fund_trader(env: &Env, quote: &Address, amount: i128) -> Address {
    let trader = Address::generate(env);
    mint(env, quote, &trader, amount);
    trader
}

/// PnL reported by `get_unrealized_pnl` must match the reference model's
/// exact (untruncated) computation from the same entry price / size /
/// current mark price, within `PERP_PNL`'s documented tolerance.
#[test]
fn unrealized_pnl_matches_reference_within_tolerance() {
    for seed in 0..cases() {
        let mut rng = rng_for_seed(seed);
        let virtual_base = amount_i128(&mut rng, 1_000_000, 100_000_000, &[]);
        let virtual_quote = amount_i128(&mut rng, 1_000_000, 100_000_000, &[]);
        let (env, client, quote) = setup(virtual_base, virtual_quote, 20);

        let opener = fund_trader(&env, &quote, 1_000_000_000);
        client.deposit_margin(&opener, &1_000_000_000);
        let is_long = seed % 2 == 0;
        let size = amount_i128(&mut rng, 1, virtual_base / 20, &[]);
        let params = TradeParams {
            size,
            leverage: 2,
            max_slippage: 5_000,
        };
        let margin = amount_i128(&mut rng, size / 2 + 1, 900_000_000, &[]);
        let Ok(Ok(position)) = client.try_open_position(&opener, &params, &is_long, &margin) else {
            continue;
        };

        // Move the mark price by having a second trader push the vAMM the
        // other way, then read the first trader's unrealized PnL.
        let mover = fund_trader(&env, &quote, 1_000_000_000);
        client.deposit_margin(&mover, &1_000_000_000);
        let mover_size = amount_i128(&mut rng, 1, virtual_base / 20, &[]);
        let mover_params = TradeParams {
            size: mover_size,
            leverage: 2,
            max_slippage: 5_000,
        };
        let mover_margin = mover_size / 2 + 1;
        if client
            .try_open_position(&mover, &mover_params, &!is_long, &mover_margin)
            .is_err()
        {
            continue;
        }

        let production = client.get_unrealized_pnl(&opener);
        let mark_price = client.get_mark_price();
        let expected = refmodel::pnl(
            to_side(position.side),
            position.size,
            position.entry_price,
            mark_price,
        );
        let expected_i128 = verification::bigmath::round_to_i128(&expected);

        assert!(
            PERP_PNL.check(production, expected_i128),
            "get_unrealized_pnl: production={production} expected={expected_i128} \
             (entry_price={}, mark_price={mark_price}, size={})",
            position.entry_price,
            position.size
        );
    }
}

/// Liquidation price stored on a freshly opened position must match the
/// reference model's exact computation from the same entry price / margin /
/// notional / side.
#[test]
fn liquidation_price_matches_reference_within_tolerance() {
    for seed in 0..cases() {
        let mut rng = rng_for_seed(seed);
        let virtual_base = amount_i128(&mut rng, 1_000_000, 100_000_000, &[]);
        let virtual_quote = amount_i128(&mut rng, 1_000_000, 100_000_000, &[]);
        let (env, client, quote) = setup(virtual_base, virtual_quote, 20);

        let trader = fund_trader(&env, &quote, 1_000_000_000);
        client.deposit_margin(&trader, &1_000_000_000);
        let is_long = seed % 2 == 0;
        let size = amount_i128(&mut rng, 1, virtual_base / 20, &[]);
        let params = TradeParams {
            size,
            leverage: 2,
            max_slippage: 5_000,
        };
        let margin = amount_i128(&mut rng, size / 2 + 1, 900_000_000, &[]);
        let Ok(Ok(position)) = client.try_open_position(&trader, &params, &is_long, &margin) else {
            continue;
        };

        let notional = position.size * position.entry_price / 10_000_000;
        if notional == 0 {
            // Degenerate reconstruction only: this recomputes notional from
            // the post-execution entry price, which can differ slightly
            // from the pre-execution mark price production actually used
            // internally: (see `contracts/perpetuals/src/lib.rs`
            // `open_position`'s `notional` vs `execution_price`). Skip
            // rather than divide by zero in the reference model.
            continue;
        }
        let expected = refmodel::liquidation_price(
            to_side(position.side),
            position.entry_price,
            position.margin,
            notional,
            625, // MaintenanceMargin default set in `initialize` (6.25%)
        );
        let expected_i128 = verification::bigmath::round_to_i128(&expected);

        assert!(
            PERP_LIQUIDATION_PRICE.check(position.liquidation_price, expected_i128),
            "liquidation_price: production={} expected={expected_i128} (entry_price={}, margin={}, \
             notional={notional})",
            position.liquidation_price,
            position.entry_price,
            position.margin,
        );
    }
}

/// Open interest equals the aggregate notional of currently-open positions
/// within documented rounding, recomputed from scratch across several
/// traders rather than trusting production's incrementally-updated counter.
#[test]
fn open_interest_matches_aggregate_notional_of_open_positions() {
    let (env, client, quote) = setup(50_000_000, 50_000_000, 20);
    let mut positions: Vec<(Side, i128, i128)> = Vec::new();

    for seed in 0..cases().min(20) {
        let mut rng = rng_for_seed(seed);
        let trader = fund_trader(&env, &quote, 1_000_000_000);
        client.deposit_margin(&trader, &1_000_000_000);
        let is_long = seed % 2 == 0;
        let size = amount_i128(&mut rng, 1, 1_000_000, &[]);
        let params = TradeParams {
            size,
            leverage: 2,
            max_slippage: 5_000,
        };
        let margin = size / 2 + 1_000;
        if let Ok(Ok(position)) = client.try_open_position(&trader, &params, &is_long, &margin) {
            positions.push((to_side(position.side), position.size, position.entry_price));
        }
    }

    let (long_oi, short_oi) = client.get_open_interest();
    let (expected_long, expected_short) = refmodel::open_interest_from_positions(&positions);
    let expected_long_i128 = verification::bigmath::round_to_i128(&expected_long);
    let expected_short_i128 = verification::bigmath::round_to_i128(&expected_short);

    assert!(
        PERP_OPEN_INTEREST.check(long_oi, expected_long_i128),
        "long_oi={long_oi} expected={expected_long_i128}"
    );
    assert!(
        PERP_OPEN_INTEREST.check(short_oi, expected_short_i128),
        "short_oi={short_oi} expected={expected_short_i128}"
    );
}

/// Closing a position cannot realize PnL twice: a second `close_position`
/// call for the same trader must fail (no position to close), not silently
/// pay out again.
#[test]
fn closing_a_position_cannot_realize_pnl_twice() {
    let (env, client, quote) = setup(50_000_000, 50_000_000, 20);
    // Mint more than gets deposited as margin: open_position/close_position
    // pull their trading fee directly from the trader's wallet balance
    // (separate from the margin already transferred into the contract), so
    // depositing the *entire* minted balance as margin leaves nothing to
    // pay the fee with.
    let trader = fund_trader(&env, &quote, 1_000_000_000);
    client.deposit_margin(&trader, &900_000_000);

    let params = TradeParams {
        size: 1_000,
        leverage: 2,
        max_slippage: 5_000,
    };
    client.open_position(&trader, &params, &true, &10_000_000);

    let first_close = client.try_close_position(&trader, &0);
    assert!(
        first_close.is_ok(),
        "first close_position unexpectedly failed: {first_close:?}"
    );

    let second_close = client.try_close_position(&trader, &0);
    assert!(
        matches!(second_close, Err(Ok(PerpetualError::PositionNotFound))),
        "second close_position on an already-closed position should fail with PositionNotFound, got \
         {second_close:?}"
    );
}

/// Liquidation eligibility (`is_liquidatable`) must be consistent with the
/// same effective-margin-vs-maintenance-requirement computation used to
/// derive it: `margin + pnl(at mark price) < notional(at mark price) *
/// maintenance_margin_bps / 10000`.
#[test]
fn liquidation_eligibility_is_consistent_with_effective_margin() {
    for seed in 0..cases() {
        let mut rng = rng_for_seed(seed);
        let virtual_base = amount_i128(&mut rng, 1_000_000, 100_000_000, &[]);
        let virtual_quote = amount_i128(&mut rng, 1_000_000, 100_000_000, &[]);
        let (env, client, quote) = setup(virtual_base, virtual_quote, 20);

        let trader = fund_trader(&env, &quote, 1_000_000_000);
        client.deposit_margin(&trader, &1_000_000_000);
        let is_long = seed % 2 == 0;
        let size = amount_i128(&mut rng, 1, virtual_base / 20, &[]);
        let params = TradeParams {
            size,
            leverage: 5,
            max_slippage: 5_000,
        };
        // Deliberately thin margin so some fraction of cases land near/at
        // the liquidation boundary, not just deep in the safe zone.
        let notional_estimate = size * client.get_mark_price() / 10_000_000;
        let margin = amount_i128(
            &mut rng,
            (notional_estimate / 10).max(1),
            notional_estimate.max(1),
            &[],
        );
        let Ok(Ok(position)) = client.try_open_position(&trader, &params, &is_long, &margin) else {
            continue;
        };

        let mover = fund_trader(&env, &quote, 1_000_000_000);
        client.deposit_margin(&mover, &1_000_000_000);
        let mover_size = amount_i128(&mut rng, 1, virtual_base / 10, &[]);
        let mover_params = TradeParams {
            size: mover_size,
            leverage: 5,
            max_slippage: 9_000,
        };
        let mover_margin = mover_size / 5 + 1;
        let _ = client.try_open_position(&mover, &mover_params, &is_long, &mover_margin);

        let mark_price = client.get_mark_price();
        let notional = position.size * mark_price / 10_000_000;
        let pnl = refmodel::pnl(
            to_side(position.side),
            position.size,
            position.entry_price,
            mark_price,
        );
        let pnl_i128 = verification::bigmath::round_to_i128(&pnl);
        let effective_margin = position.margin + pnl_i128;
        let required = notional * 625 / 10_000; // MaintenanceMargin default (6.25%)
        let expected_liquidatable = effective_margin < required;

        let production_liquidatable = client.is_liquidatable(&trader);
        assert_eq!(
            production_liquidatable, expected_liquidatable,
            "is_liquidatable mismatch: production={production_liquidatable} expected={expected_liquidatable} \
             (effective_margin={effective_margin}, required={required}, mark_price={mark_price})"
        );
    }
}
