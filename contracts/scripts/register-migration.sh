#!/usr/bin/env bash
set -euo pipefail

# register-migration.sh
#
# Registers a migration edge in a contract's migration registry.
# The governance/admin address must invoke `set_migration_edge`
# (or the contract stores the registry at init time).
#
# Usage: ./register-migration.sh <network> <contract-id> <from-version> <to-version> <kind> <admin-seed>
#
# Kind: oneshot | batched | read_compatible

NETWORK="$1"
CONTRACT_ID="$2"
FROM_VER="$3"
TO_VER="$4"
KIND="$5"
ADMIN_SEED="$6"

case "$KIND" in
  oneshot)         KIND_ARG=0 ;;
  batched)         KIND_ARG=1 ;;
  read_compatible) KIND_ARG=2 ;;
  *) echo "Unknown kind: $KIND"; exit 1 ;;
esac

echo "Registering migration $FROM_VER -> $TO_VER ($KIND) on $CONTRACT_ID ..."

# In production this would be a `soroban contract invoke` call.
# The actual invocation depends on the contract's `register_migration` entry.
echo "Done (simulated)."
