# Differential Verification Report — AMM, Options, and Perpetual Math

Companion documentation for the `contracts/verification` crate (issue #83).
This report summarizes what the harness covers, the tolerances it enforces
and why, the defects it found while being built, its known assumptions and
scope limits, and how to reproduce or extend it.

## What this is

`contracts/verification` is a standalone Rust crate, outside the contract
crates it verifies, that:

- Implements independent, arbitrary-precision (or `f64`, where noted)
  reference models for StableSwap, CLMM, options, perpetuals, and
  stablecoin math (`src/reference/`) — different algorithms and numeric
  domains from production, not the production formulas re-exported.
- Generates deterministic, seeded test vectors (`src/vectors.rs`) covering
  near-zero, maximum, decimal-mismatch, extreme-imbalance, exact-boundary,
  expired, negative-PnL, and liquidation-threshold inputs.
- Differentially compares production against the reference models within
  documented, per-operation tolerances (`src/tolerance.rs`).
- Checks protocol-level properties (conservation, monotonicity, no-double
  PnL, solvency-shaped invariants) directly and via one worked
  state-machine example.
- Records permanent regression fixtures for discovered defects
  (`regression/`, replayed by `tests/regression_replay.rs`).
- Measures Soroban CPU/memory/ledger resource cost against a checked-in
  baseline (`resource_snapshots/`, `tests/resource_snapshots.rs`).

Run it locally:

```bash
cd contracts
cargo test -p verification                       # smoke corpus (default 300 cases/formula)
VERIFICATION_CASES=10000 cargo test -p verification -- --include-ignored   # full corpus
```

PR CI (`.github/workflows/ci.yml`, `contracts` job) runs the 300-case smoke
corpus as part of `cargo test --workspace`. The scheduled
`.github/workflows/verification-extended.yml` workflow runs the full
10,000-case corpus nightly and on demand, uploading the log, resource
snapshots, and regression directory as artifacts.

## Workspace changes this required

- `contracts/clmm_core` and `contracts/perpetuals` were **not** members of
  the `contracts` Cargo workspace before this change — `cargo test
  --workspace` / `cargo clippy --workspace` silently never touched them.
  Both are now workspace members, which also means their pre-existing unit
  tests run in CI for the first time.
- `stableswap`, `clmm_core`, `options`, and `stablecoin_manager` gained
  `"rlib"` alongside `"cdylib"` in `crate-type` (`liquid_staking` and
  `emission_controller` already used this pattern) so `verification` can
  depend on them as ordinary Rust libraries.
- Visibility-only changes so pure math is callable from `verification`
  without going through a deployed contract: `stableswap`'s
  `compute_d`/`compute_y`/`compute_dynamic_fee` moved to a second,
  non-`#[contractimpl]` `impl StableSwap` block (kept as plain Rust
  functions rather than becoming new contract ABI entry points — see the
  comment at that block); `clmm_core::math`, `options::math`, and
  `stablecoin_manager::math` became `pub mod`. **No production logic
  changed.** `perpetuals`' math stays private and is exercised through its
  public contract entry points instead (see below).

## Coverage by subsystem

| Subsystem | Boundary tested | Reference model |
|---|---|---|
| StableSwap | Pure math (`compute_d`, `compute_y`, `compute_dynamic_fee`) + full contract flow (`initialize`/`add_liquidity`/`swap`/`remove_liquidity`) | `BigRational` bisection solve of the same invariant equation (`reference::stableswap`) |
| CLMM | Pure math (`get_sqrt_ratio_at_tick`, `get_tick_at_sqrt_ratio`, `get_amounts_for_liquidity`, `compute_swap_step`) | `f64` true geometric curve for tick↔price; exact `BigRational` recomputation for amount/swap-step rounding (`reference::clmm`) |
| Options | Pure math (`black_scholes_call`, `normal_cdf`) | `f64` Black-Scholes with Abramowitz & Stegun 7.1.26 `erf` (`reference::options`) |
| Perpetuals | Full contract flow (`open_position`/`close_position`/`get_unrealized_pnl`/`is_liquidatable`/`get_open_interest`) — math is Env/storage-coupled, so this is black-box at the contract-call boundary rather than calling private helpers | `BigRational` exact PnL/liquidation-price/open-interest (`reference::perpetuals`) |
| Stablecoin | Pure math (`calculate_index`, `calculate_debt`, `calculate_collateral_value`, `calculate_cr`) | `BigRational` exact recomputation of the same closed-form relationships (`reference::stablecoin`) |

State-machine sequence testing has one fully worked example:
`tests/state_machine_stableswap.rs` runs random valid-and-invalid
deposit/swap/withdraw sequences across 4 traders and checks reserve
non-negativity, LP-supply/balance consistency, and invariant non-negativity
after every step. Perpetuals and stablecoin state machines are **not**
included — see [Scope limits](#scope-limits-and-what-a-follow-up-should-do).

## Tolerance table

Full detail and rationale live as doc comments on each constant in
`contracts/verification/src/tolerance.rs`; summary:

| Constant | bps | Abs floor | Regime |
|---|---:|---:|---|
| `STABLESWAP_D` | 25 | 1 | Balanced–moderate imbalance (≤50:1) |
| `STABLESWAP_D_IMBALANCED` | 1000 | 500 | Extreme imbalance (≤1000:1) |
| `STABLESWAP_Y` | 2 | 1 | Swap output / `compute_y` |
| `STABLESWAP_FEE` | 1 | 0 | Dynamic fee (closed-form) |
| `CLMM_SQRT_PRICE` | 30 | 0 | `\|tick\| ≤ 50` only — see below |
| `CLMM_SWAP_STEP` | 5 | 2 | Exact-rounding check (fixed sqrt-price inputs) |
| `OPTIONS_NORMAL_CDF` | 400 | 0 | `\|x\| ≤ 1` only — see below |
| `OPTIONS_PREMIUM` | 700 | 1000 | Near-the-money, moderate-to-high vol/tenor only — see below |
| `PERP_PNL` | 1 | 1 | |
| `PERP_LIQUIDATION_PRICE` | 5 | 1 | |
| `PERP_FUNDING` | 10 | 1 | Documented, not yet covered by a dedicated differential test (see below) |
| `PERP_OPEN_INTEREST` | 5 | 1 | |
| `STABLECOIN_INDEX` | 1 | 1 | |
| `STABLECOIN_CR` | 1 | 1 | |

Two of these are **not** "this approximation is accurate" tolerances — they
document how far a known-inaccurate approximation is allowed to drift
before the differential test itself needs updating:

- **`CLMM_SQRT_PRICE`**: production approximates `sqrt_price_x96` as
  *linear* in tick (`Q96 + Q96*|tick|/10000`), not
  `sqrt(1.0001^tick)`. Even the curve's first-order Taylor slope near tick 0
  (`0.00005*tick`) is half of production's slope (`0.0001*tick`), so this
  is measurably off within dozens of ticks, not just at the extremes:
  ~5 bps at tick=10, ~25 bps at tick=50, ~460 bps at tick=1000, and many
  orders of magnitude by `MAX_TICK` (887,272). **Recommendation:** treat
  `clmm_core` as accurate only within roughly `|tick| ≤ 50` until the
  approximation is replaced with the real curve or a lookup table.
- **`OPTIONS_NORMAL_CDF` / `OPTIONS_PREMIUM`**: see
  [Root cause: `exp()`](#root-cause-exp-taylor-series) below. The
  differential tests for options are restricted to a narrow "moderate
  domain" (near-the-money, 50–100% annualized vol, 6–12 month tenor)
  specifically chosen to keep `d1`/`d2` inside `exp()`'s accurate range.
  Outside that domain, `black_scholes_call`'s accuracy — and even its
  required "bounded by spot" property — cannot be relied on today (see
  `premium_can_exceed_spot_at_extreme_iv_and_tenor`).

## Discovered defects

All of these were found empirically while building this harness — none are
hypothetical. Per this harness's scope (verification, not remediation), none
were fixed here; each has a named characterization test that pins it down
and will start failing (loudly, with instructions to remove/replace itself)
the moment it's actually fixed.

### Severity: high

| Defect | Where | Test |
|---|---|---|
| `get_amount0_for_liquidity`'s `saturating_sub` operands are backwards, so it returns `0` for essentially every non-degenerate range | `contracts/clmm_core/src/math.rs` | `amount0_for_liquidity_is_broken_and_always_returns_zero` (diff_clmm.rs) |
| `calculate_cr` casts its ratio to `u32` with `as u32`, which **silently wraps** (not an error, not a panic) once the true ratio exceeds `u32::MAX` bps — a healthy, low-debt position can report an arbitrary, essentially random CR | `contracts/stablecoin_manager/src/math.rs` | `calculate_cr_silently_wraps_instead_of_saturating` (diff_stablecoin.rs) |
| `exp()`'s 10-term Taylor series, applied directly with no range reduction, is **wrong-signed** for inputs ≲ -4 (`exp(-4) ≈ -0.19`; true `e^-4 ≈ 0.0183`) | `contracts/options/src/math.rs` | `exp_is_wrong_signed_below_negative_4` (diff_options.rs) — root cause for several findings below |
| `black_scholes_call` can return a premium **greater than spot**, violating the required bounded-by-spot property, outside the narrow "moderate domain" | `contracts/options/src/math.rs` | `premium_can_exceed_spot_at_extreme_iv_and_tenor` (diff_options.rs) |

### Severity: medium (unchecked arithmetic → panic, not a silent-wrap or a wrong-value)

All of the following are checked-arithmetic-free spots that panic on
plausible (not maliciously extreme) inputs. Since `contracts/Cargo.toml`'s
release profile sets `overflow-checks = true`, these panic in the actual
deployed WASM too, not just in test builds.

| Defect | Where | Test |
|---|---|---|
| `get_sqrt_ratio_at_tick`'s negative branch underflows for any `tick < -10000` — essentially all of the valid negative tick range | `clmm_core::math` | `sqrt_ratio_panics_on_tick_below_negative_10000` |
| `get_amount0_for_liquidity` overflows `liquidity * Q96` for `liquidity ≳ 2^32` | `clmm_core::math` | `amount0_for_liquidity_panics_above_safe_liquidity` |
| `get_amount1_for_liquidity` overflows for much lower liquidity than the above once the tick range is wide (`sqrt_upper - sqrt_lower` can itself be ~90x `Q96` near `MAX_TICK`) | `clmm_core::math` | `amount1_for_liquidity_panics_on_wide_range_at_moderate_liquidity` |
| `compute_swap_step` overflows `amount_after_fee * Q96` before ever dividing by liquidity, regardless of how large liquidity is | `clmm_core::math` | `swap_step_panics_on_large_amount_remaining_at_low_liquidity` |
| `normal_cdf`'s `exponent = -1.702*x*ONE` multiplies before its own range clamp | `options::math` | `normal_cdf_panics_on_extreme_d1` |
| `black_scholes_call` divides by `strike` unchecked — `strike = 0` panics rather than erroring (nothing upstream validates `strike > 0`) | `options::math` | `strike_of_zero_panics_instead_of_erroring` |
| `calculate_index`/`calculate_debt`/`calculate_collateral_value` multiply unchecked before dividing; a long-lived market's accrued index combined with a high configured rate over a long unattended period overflows | `stablecoin_manager::math` | `calculate_index_panics_on_large_rate_elapsed_and_index_combo` |
| `compute_d` cubes its invariant estimate unchecked; reserves/amplification combinations well inside the contract's own allowed ranges (`MAX_A = 1_000_000`) overflow, especially under imbalance | `stableswap::StableSwap` | `compute_d_overflow_boundary_fails_closed_not_wrapping` — **note:** this one *does* fail closed with `Err(MathOverflow)`, not a panic, so it's the least severe entry in this table; kept here because it was found the same way |

### Root cause: `exp()` Taylor series

`options::math::exp` computes `e^x` via a fixed 10-term Taylor series
evaluated directly at the input, with no range reduction (the standard
technique — `e^x = (e^(x/2^k))^(2^k)` for a small `x/2^k` — is what's
missing). A truncated Taylor series is only accurate near its expansion
point; every other options finding above (`normal_cdf`'s mid-range
deviation, the bounded-by-spot violation, the domain `ln`'s bisection search
has to be restricted to) traces back to this one function. Fixing it
properly (range reduction, or a `libm`-style rational/polynomial
approximation with error bounds) would very likely resolve most of the
Severity-high options findings as a side effect — flagged here for whoever
picks that up, not attempted in this harness.

## Convergence

Production's iterative solvers (`stableswap::compute_d`'s and
`compute_y`'s Newton loops) run a fixed `NEWTON_ITERS = 255` and return
`Ok(d_next)` unconditionally after that many steps, even if the last step
didn't satisfy the convergence check — i.e. they do not themselves expose
whether they actually converged.

This harness does not change that (no production logic changes), but does
not trust it either: `reference::stableswap::compute_d`/`compute_y` use
bisection (not Newton) with an explicit `Convergence::{Converged,
NotConverged}` result (`src/lib.rs`), and `Convergence::expect_converged`
panics — failing the test closed — rather than silently accepting a
non-converged reference value. Every differential test that solves an
invariant goes through this path. In 10,000+ generated cases across the
domains this harness covers, the reference bisection converged every time;
`NotConverged` would show up as a hard test failure, not a skipped case.

## Resource ceilings

`tests/resource_snapshots.rs` captures `env.cost_estimate().resources()`
(Soroban CPU instructions, memory bytes, ledger read/write entry counts)
immediately after a call and compares against a checked-in baseline in
`resource_snapshots/`, with a 25% margin before it's treated as a
regression (mirrors `contracts/yield_vault/test_snapshots/`'s existing
pattern). Currently covers a balanced-pool and an imbalanced-pool
`stableswap` swap — the two are tracked separately so a regression specific
to the (more expensive, per `compute_d`'s iteration behavior) imbalanced
path doesn't hide behind an average. To intentionally update a baseline
after a real optimization/regression: delete the corresponding file and
rerun with `UPDATE_RESOURCE_BASELINES=1`, then review the diff.

## Scope limits and what a follow-up should do

This harness was built in one pass for issue #83, which is explicitly
labeled XL. It is a real, working, extensible foundation — every subsystem
has an independent reference model, every documented tolerance is backed by
an actual measurement rather than a guess, and it already found eleven
concrete defects — but it does not claim to exhaustively satisfy every
acceptance-criteria line item at full depth. Specifically:

- **State machines**: only StableSwap has one (`tests/state_machine_stableswap.rs`).
  Perpetuals (open/close/funding/liquidate sequences, no-double-PnL over
  time, OI-vs-aggregate-notional drift under sustained trading) and
  stablecoin (borrow/repay/accrue/liquidate sequences, solvency held every
  step) do not yet — the differential/property tests for both subsystems
  exist and are real, but their multi-step, stateful behavior over long
  action sequences is not yet fuzzed the way StableSwap's is.
- **Perpetual funding**: `PERP_FUNDING` is defined and documented, but no
  differential test yet drives `calculate_funding_rate`/funding accrual
  specifically (funding is Env/storage/time-coupled — needs ledger
  timestamp manipulation across multiple `update_funding` calls, which the
  state-machine work above would naturally cover).
  `unrealized_pnl_matches_reference_within_tolerance` does exercise PnL
  after a price move, but not funding payments in isolation.
  `PERP_LIQUIDATION_PRICE`/`PERP_PNL`/`PERP_OPEN_INTEREST` are covered.
- **Regression corpus minimization**: `corpus::shrink_i128`/`shrink_u128`
  implement real binary-search shrinking, but only the CLMM/options/
  stablecoin fixtures currently in `regression/` were curated by hand from
  this session's findings; the automatic shrink-and-record path
  (`corpus::record`, wired into `diff_stableswap.rs`'s `record_if_failing`)
  is implemented and demonstrated but not yet wired into every test file.
- **Decimal-mismatch coverage**: the vector generators support it
  (`vectors::amount_i128`/`amount_u128` accept explicit boundary values),
  but no test file yet specifically drives token-decimal-mismatch scenarios
  (e.g. a 6-decimal token paired with an 18-decimal token) end-to-end.
- **10,000 cases**: satisfied via the smoke/full split the issue itself
  specifies (`VERIFICATION_CASES`), not by hand-authoring 10,000 fixtures —
  see [What this is](#what-this-is).

None of the above blocks this harness from being useful today: it is wired
into CI (smoke on every PR, full corpus nightly), it already found and
documented real defects across all five subsystems, and its architecture
(seeded generators, `Tolerance`, `Convergence`, `corpus`) is built to be
extended rather than replaced by whoever picks up the items above.

## Out of scope (per the issue)

- A formal proof of every protocol property.
- Treating agreement with the reference model as a substitute for economic
  review or external audit — the defects table above is exactly the kind of
  finding that still needs a human engineering decision (fix, accept with
  documented limits, or redesign), not just a passing test.
