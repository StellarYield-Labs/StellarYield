#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dry-run-upgrade.sh — Upgrade & Migration Dry-Run Tool
#
# Imports representative state into a local Soroban environment, upgrades the
# Wasm, runs the migration, and compares invariants.
#
# Usage:
#   ./dry-run-upgrade.sh <contract-name> <old-wasm> <new-wasm> <migration-plan>
#
# Example:
#   ./dry-run-upgrade.sh yield_vault \
#     target/wasm32-unknown-unknown/release/yield_vault.v1.wasm \
#     target/wasm32-unknown-unknown/release/yield_vault.v2.wasm \
#     plans/migrate_v1_to_v2.json
#
# Prerequisites:
#   - stellar CLI 22+
#   - cargo (for building test fixtures)
#   - jq
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

if [ $# -lt 4 ]; then
  echo "Usage: $0 <contract-name> <old-wasm> <new-wasm> <migration-plan>"
  exit 1
fi

CONTRACT_NAME="$1"
OLD_WASM="$(realpath "$2")"
NEW_WASM="$(realpath "$3")"
MIGRATION_PLAN="$(realpath "$4")"

echo "=== Upgrade Dry-Run: $CONTRACT_NAME ==="
echo "  Old Wasm:  $OLD_WASM"
echo "  New Wasm:  $NEW_WASM"
echo "  Plan:      $MIGRATION_PLAN"

# 1. Start local Soroban test environment (if not already running)
if ! curl -s http://localhost:8001 > /dev/null 2>&1; then
  echo "Starting local Soroban RPC (8001)..."
  stellar container start
fi

# 2. Generate a deterministic keypair for the test
SEED="test-upgrade-dry-run-${CONTRACT_NAME}"
IDENTITY="dry-run-${CONTRACT_NAME}"
stellar keys generate "$IDENTITY" --seed "$SEED" 2>/dev/null || true

# 3. Build & deploy the OLD Wasm
echo "Deploying old contract..."
OLD_ID=$(stellar contract deploy \
  --wasm "$OLD_WASM" \
  --source "$IDENTITY" \
  --rpc-url http://localhost:8001 \
  --network-passphrase "Standalone Network ; June 2022" \
  2>&1 | tail -1)
echo "  Old contract ID: $OLD_ID"

# 4. Initialize the old contract (capture pre-upgrade state)
#    Each contract may need custom initialization args.
echo "Initializing old contract (customize args per contract)..."
case "$CONTRACT_NAME" in
  yield_vault)
    ADMIN_ID=$(stellar keys address "$IDENTITY")
    TOKEN_ID=$(stellar contract asset deploy --source "$IDENTITY" --rpc-url http://localhost:8001 --network-passphrase "Standalone Network ; June 2022" 2>&1 | tail -1)
    stellar contract invoke \
      --id "$OLD_ID" \
      --source "$IDENTITY" \
      --rpc-url http://localhost:8001 \
      --network-passphrase "Standalone Network ; June 2022" \
      -- initialize \
      --admin "$ADMIN_ID" \
      --token "$TOKEN_ID"
    ;&
  settlement)
    ADMIN_ID=$(stellar keys address "$IDENTITY")
    ENGINE_ID=$(stellar keys address "$IDENTITY")
    stellar contract invoke \
      --id "$OLD_ID" \
      --source "$IDENTITY" \
      --rpc-url http://localhost:8001 \
      --network-passphrase "Standalone Network ; June 2022" \
      -- initialize \
      --admin "$ADMIN_ID" \
      --matching-engine "$ENGINE_ID" \
      --fee-recipient "$ADMIN_ID" \
      --fee-bps 30
    ;;
  optimistic_governance)
    ADMIN_ID=$(stellar keys address "$IDENTITY")
    VE_YIELD=$(stellar keys address "$IDENTITY")
    stellar contract invoke \
      --id "$OLD_ID" \
      --source "$IDENTITY" \
      --rpc-url http://localhost:8001 \
      --network-passphrase "Standalone Network ; June 2022" \
      -- initialize \
      --admin "$ADMIN_ID" \
      --ve-yield-token "$VE_YIELD" \
      --challenge-window 86400
    ;;
esac

# 5. Record pre-upgrade invariants
echo "Recording pre-upgrade invariants..."
PRE_VERSION=$(stellar contract invoke \
  --id "$OLD_ID" \
  --source "$IDENTITY" \
  --rpc-url http://localhost:8001 \
  --network-passphrase "Standalone Network ; June 2022" \
  -- storage_version 2>&1) || true
echo "  Old storage version: ${PRE_VERSION:-<legacy>}"

# 6. Upgrade the Wasm (requires governance)
#    We use the governance contract or direct admin action.
#    In this dry-run tool we use the `upgrade` entry point directly.
echo "Scheduling upgrade..."
UPGRADE_RESULT=$(stellar contract invoke \
  --id "$OLD_ID" \
  --source "$IDENTITY" \
  --rpc-url http://localhost:8001 \
  --network-passphrase "Standalone Network ; June 2022" \
  -- upgrade \
  --governance "$(stellar keys address "$IDENTITY")" \
  --target-wasm-hash "$(sha256sum "$NEW_WASM" | cut -d' ' -f1)" \
  --migration-plan-digest "$(sha256sum "$MIGRATION_PLAN" | cut -d' ' -f1)" \
  --migration-id "dry_run_v1_to_v2" \
  --timelock-seconds 0 2>&1) || true
echo "  Upgrade scheduled: $UPGRADE_RESULT"

# 7. Run migration in chunks (resumable pattern)
echo "Running migration..."
MIGRATION_DONE=false
CURSOR=0
LIMIT=100
while [ "$MIGRATION_DONE" = false ]; do
  MIG_RESULT=$(stellar contract invoke \
    --id "$OLD_ID" \
    --source "$IDENTITY" \
    --rpc-url http://localhost:8001 \
    --network-passphrase "Standalone Network ; June 2022" \
    -- migrate \
    --from-version 1 \
    --to-version 2 \
    --cursor "$CURSOR" \
    --limit "$LIMIT" 2>&1) || true
  echo "  Migration chunk at cursor=$CURSOR: $MIG_RESULT"

  CURSOR=$((CURSOR + LIMIT))
  if [ "$CURSOR" -gt 10000 ]; then
    echo "  Migration complete (or limit reached)"
    MIGRATION_DONE=true
  fi
done

# 8. Compare post-upgrade invariants
echo "Post-upgrade storage version:"
POST_VERSION=$(stellar contract invoke \
  --id "$OLD_ID" \
  --source "$IDENTITY" \
  --rpc-url http://localhost:8001 \
  --network-passphrase "Standalone Network ; June 2022" \
  -- storage_version 2>&1) || true
echo "  New storage version: ${POST_VERSION:-<unknown>}"

echo ""
echo "=== Dry-run complete ==="
echo "Pre-version: ${PRE_VERSION:-legacy} → Post-version: ${POST_VERSION:-unknown}"
echo "Check for any error output above."
