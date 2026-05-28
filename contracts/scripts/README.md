# Contract Deployment Scripts

Repeatable testnet deployment for all Soroban contracts.

## Prerequisites

1. Install the Stellar CLI:
   ```bash
   cargo install --locked stellar-cli --features opt
   ```

2. Add the WASM target:
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

3. Install `jq` (used to format the output JSON):
   ```bash
   # macOS
   brew install jq
   # Ubuntu/Debian
   sudo apt-get install jq
   ```

4. Create and fund a testnet identity:
   ```bash
   stellar keys generate --global deployer --network testnet
   stellar keys fund deployer --network testnet
   ```

## Configuration

```bash
cp contracts/scripts/.env.deploy.example contracts/scripts/.env.deploy
```

Edit `.env.deploy` with your values. The file is gitignored — never commit secrets.

| Variable | Description |
|---|---|
| `STELLAR_RPC_URL` | Soroban RPC endpoint (default: Stellar testnet) |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase |
| `STELLAR_SOURCE_ACCOUNT` | Secret key (`S...`) or named CLI identity |

## Usage

Deploy all contracts:
```bash
bash contracts/scripts/deploy.sh
```

Deploy specific contracts:
```bash
bash contracts/scripts/deploy.sh yield_vault zap aa_factory
```

## Output

Deployed contract IDs are written to `contracts/scripts/deployed.json`:

```json
{
  "yield_vault": "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "zap": "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

This file can be consumed by other scripts or CI pipelines.

## Registry Validation

The project maintains a global contract registry in `contracts/registry.json`. This file must be validated to ensure all required contracts have valid addresses for each supported network.

To run the validator:
```bash
node contracts/scripts/validate-registry.js
```

The validator checks for:
- Presence of required networks (`testnet`, `mainnet`).
- Presence of required contract aliases (`vault`, `zap`, etc.).
- Correct address format (Stellar/Soroban `C...` or `G...` addresses).
- Duplicate addresses within a single network.

## Deployment Manifest Generator

After each deployment run, generate a traceable manifest that captures contract IDs,
network, commit SHA, and timestamp:

```bash
node contracts/scripts/generate-manifest.js \
  --input contracts/scripts/deployed.json \
  --network testnet \
  --output contracts/scripts/deployment-manifest.json
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--input` | `contracts/scripts/deployed.json` | Path to the deployed.json from deploy.sh |
| `--network` | `testnet` | Target network: `testnet`, `mainnet`, or `local` |
| `--output` | `contracts/scripts/deployment-manifest.json` | Output path for the manifest |

The script validates all contract IDs (must be 56-char Soroban/Stellar addresses starting with `C` or `G`), skips empty entries, and cross-references the output against `contracts/registry.json` to warn if any deployed contract is not yet registered.

**Sample output** is in `contracts/scripts/deployment-manifest.example.json`.

**Typical post-deployment workflow:**

```bash
# 1. Deploy contracts
bash contracts/scripts/deploy.sh

# 2. Generate the manifest
node contracts/scripts/generate-manifest.js \
  --input contracts/scripts/deployed.json \
  --network testnet

# 3. Validate the registry is up-to-date
node contracts/scripts/validate-registry.js
```

The manifest file (`deployment-manifest.json`) should be committed to the repository
or stored as a CI artifact so that every deployment is fully auditable.

## Secrets

`.env.deploy` is listed in `.gitignore`. Never commit private keys or secret accounts.
