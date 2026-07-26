**Contracts Registry**

This document explains the `contracts/registry.json` file and the registry diff viewer.

- Location: `contracts/registry.json`
- Purpose: track Soroban contract IDs per environment (local, testnet, mainnet).
- Deployment: update this file after deployments; environment variables override at runtime.

Registry Diff Viewer
--------------------

We provide a simple viewer at `client/src/pages/transparency/RegistryDiff.tsx` which compares the current `contracts/registry.json` file against `contracts/registry.previous.json` (example snapshot). It highlights per-environment changes:

- Added: contract address present in new registry but missing in old.
- Removed: contract address removed in new registry.
- Changed: contract address changed between snapshots.
- Missing entries: any required contract names that are empty in the new registry — the UI shows a warning badge.

Validation
----------

Both the client (`client/src/services/contractRegistry.ts`) and server (`server/src/services/contractRegistry.ts`) expose a `validateRegistry()` function that checks for missing or blank contract IDs.

### Missing Contract Detection

The validation identifies contracts with missing IDs. The following values are all treated as missing:

- `undefined` or `null` (when the contract entry is absent)
- Empty string `""`
- Whitespace-only strings like `"   "` or `"\t\n"`

### Warning Output

`validateRegistry()` returns a `RegistryWarning` object:

```ts
type RegistryWarning = {
  network: NetworkName;
  missingContracts: ContractName[];
  warningMessage: string;
};
```

Example warning message:

```
Missing contract IDs for testnet:
- emissionController
- liquidStaking
- stableswap
- zap
```

### Deterministic Ordering

Missing contracts are always listed in alphabetical order. This ensures consistent output across repeated calls.

Usage
-----

To update the snapshot used for comparison, replace `contracts/registry.previous.json` with the previous deployment's registry (keep private addresses out of public commits). The viewer reads both files and renders a per-network diff.

Tests
-----

Unit tests for the diff logic are at `contracts/__tests__/registryDiff.test.ts` and cover added/removed/changed detection and whitespace handling.

Unit tests for the registry validation are at `client/src/services/contractRegistry.test.ts` and cover missing contracts, blank values, whitespace handling, and deterministic ordering.
