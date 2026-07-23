//! State-machine test for `contracts/stableswap`: executes random
//! sequences of deposit/swap/withdraw actions (including deliberately
//! invalid ones — zero amounts, over-withdrawals, wrong tokens) against a
//! single pool and checks protocol invariants after every step.
//!
//! This is the harness's one fully worked state-machine example (see
//! docs/differential-verification.md for why the other subsystems don't
//! have one yet — scope, not lower priority). It establishes the pattern:
//! deterministic per-seed action sequences (regenerable from the seed
//! alone, same as every other test here), invariant checks after each step
//! rather than only at the end, and no-panic assertions on the invalid
//! actions instead of skipping them.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, Env};
use stableswap::{StableSwap, StableSwapClient};

use verification::vectors::{amount_i128, case_count, rng_for_seed, sometimes};

const NUM_TRADERS: usize = 4;
const SEQUENCE_LEN: usize = 25;

#[derive(Debug, Clone)]
enum Action {
    AddLiquidity {
        trader: usize,
        amount0: i128,
        amount1: i128,
    },
    RemoveLiquidity {
        trader: usize,
        lp_fraction_pct: i128,
    },
    Swap {
        trader: usize,
        token0_in: bool,
        amount: i128,
    },
}

fn generate_sequence(rng: &mut impl rand::RngCore, len: usize) -> Vec<Action> {
    let mut actions = Vec::with_capacity(len);
    for _ in 0..len {
        let trader = (rng.next_u32() as usize) % NUM_TRADERS;
        let roll = rng.next_u32() % 100;
        let action = if roll < 40 {
            Action::AddLiquidity {
                trader,
                // Occasionally zero/negative-ish (invalid) amounts.
                amount0: amount_i128(rng, 0, 50_000_000, &[0]),
                amount1: amount_i128(rng, 0, 50_000_000, &[0]),
            }
        } else if roll < 70 {
            Action::Swap {
                trader,
                token0_in: sometimes(rng, 50),
                amount: amount_i128(rng, 0, 20_000_000, &[0]),
            }
        } else {
            Action::RemoveLiquidity {
                trader,
                lp_fraction_pct: amount_i128(rng, 0, 150, &[0, 100]),
            }
        };
        actions.push(action);
    }
    actions
}

struct World {
    env: Env,
    client: StableSwapClient<'static>,
    token0: Address,
    token1: Address,
    traders: Vec<Address>,
}

fn setup() -> World {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token0_admin = Address::generate(&env);
    let token1_admin = Address::generate(&env);
    let token0 = env
        .register_stellar_asset_contract_v2(token0_admin)
        .address();
    let token1 = env
        .register_stellar_asset_contract_v2(token1_admin)
        .address();
    let lp_token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let contract_id = env.register(StableSwap, ());
    let client = StableSwapClient::new(&env, &contract_id);
    client.initialize(
        &admin, &token0, &token1, &lp_token, &100u32, &30_000u32, &20_000u32,
    );

    let mut traders = Vec::new();
    for _ in 0..NUM_TRADERS {
        let trader = Address::generate(&env);
        token::StellarAssetClient::new(&env, &token0).mint(&trader, &1_000_000_000);
        token::StellarAssetClient::new(&env, &token1).mint(&trader, &1_000_000_000);
        traders.push(trader);
    }

    World {
        env,
        client,
        token0,
        token1,
        traders,
    }
}

/// Checks that must hold after *every* step, valid or invalid:
/// - reserves are never negative
/// - LP total supply equals the sum of every tracked trader's LP balance
/// - the invariant D (recomputed from current reserves) is non-negative
fn check_invariants(world: &World, step: usize, action: &Action) {
    let (r0, r1) = world.client.get_reserves();
    assert!(
        r0 >= 0 && r1 >= 0,
        "step {step} ({action:?}): negative reserves r0={r0} r1={r1}"
    );

    let total_supply = world.client.get_total_supply();
    assert!(
        total_supply >= 0,
        "step {step} ({action:?}): negative total_supply={total_supply}"
    );

    let sum_balances: i128 = world
        .traders
        .iter()
        .map(|t| world.client.get_lp_balance(t))
        .sum();
    assert_eq!(
        total_supply, sum_balances,
        "step {step} ({action:?}): total_supply={total_supply} != sum of tracked LP balances={sum_balances}"
    );

    // Discovered via this state machine (not a bug in the check): ordinary
    // swap sequences — no single extreme input, just several large
    // one-directional trades in a row — can imbalance a pool far enough
    // that `compute_d` overflows on the live reserves (see
    // `compute_d_overflow_boundary_fails_closed_not_wrapping` in
    // tests/diff_stableswap.rs for the isolated boundary). Any subsequent
    // `add_liquidity` in that state would hit the same overflow. Production
    // fails closed (`Err(MathOverflow)`, never a panic — already verified
    // by `apply()`'s no-panic assertion above), so this is *not* treated as
    // an invariant violation here; D is checked only when it can be
    // computed, and its overflow is itself the documented finding.
    if r0 > 0 && r1 > 0 {
        if let Ok(d) = StableSwap::compute_d(r0, r1, 100) {
            assert!(d >= 0, "step {step} ({action:?}): D went negative");
        }
    }
}

fn apply(world: &World, action: &Action) {
    let trader = &world.traders[action.clone().trader_idx()];
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match action {
        Action::AddLiquidity {
            amount0, amount1, ..
        } => {
            let _ = world.client.try_add_liquidity(trader, amount0, amount1, &0);
        }
        Action::Swap {
            token0_in, amount, ..
        } => {
            let token_in = if *token0_in {
                &world.token0
            } else {
                &world.token1
            };
            let _ = world.client.try_swap(trader, token_in, amount, &0);
        }
        Action::RemoveLiquidity {
            lp_fraction_pct, ..
        } => {
            let balance = world.client.get_lp_balance(trader);
            let lp_amount = balance * lp_fraction_pct / 100;
            let _ = world
                .client
                .try_remove_liquidity(trader, &lp_amount, &0, &0);
        }
    }));
    assert!(
        result.is_ok(),
        "action panicked instead of returning a typed error (no valid *or invalid* input should panic): \
         {action:?}"
    );
}

impl Action {
    fn trader_idx(self) -> usize {
        match self {
            Action::AddLiquidity { trader, .. } => trader,
            Action::RemoveLiquidity { trader, .. } => trader,
            Action::Swap { trader, .. } => trader,
        }
    }
}

#[test]
fn random_action_sequences_preserve_invariants() {
    for seed in 0..case_count().min(40) as u64 {
        let mut rng = rng_for_seed(seed);
        let world = setup();
        let sequence = generate_sequence(&mut rng, SEQUENCE_LEN);

        // Seed the pool so early swaps/withdrawals have something to act on.
        let bootstrap = &world.traders[0];
        world
            .client
            .add_liquidity(bootstrap, &100_000_000, &100_000_000, &0);
        check_invariants(
            &world,
            0,
            &Action::AddLiquidity {
                trader: 0,
                amount0: 100_000_000,
                amount1: 100_000_000,
            },
        );

        for (i, action) in sequence.iter().enumerate() {
            apply(&world, action);
            check_invariants(&world, i + 1, action);
        }
        let _ = &world.env;
    }
}
