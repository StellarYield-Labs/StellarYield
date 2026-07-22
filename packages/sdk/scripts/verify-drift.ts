import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { YIELD_VAULT_SPEC_HASH } from "../src/generated/yield_vault";

const rootDir = path.resolve(__dirname, "../../..");
const contractsDir = path.join(rootDir, "contracts");
const wasmPath = path.join(
  contractsDir,
  "target/wasm32-unknown-unknown/release/yield_vault.wasm"
);
const openapiPath = path.join(rootDir, "server/openapi.yaml");
const apiClientPath = path.join(rootDir, "packages/sdk/src/api/ApiClient.ts");

function verifyWasmDrift() {
  console.log("--> Checking YieldVault WASM spec drift...");
  if (!fs.existsSync(wasmPath)) {
    console.log("--> WASM not found, compiling yield_vault...");
    execSync(
      "cargo build -p yield_vault --target wasm32-unknown-unknown --release",
      { cwd: contractsDir, stdio: "inherit" }
    );
  }

  const wasmBuffer = fs.readFileSync(wasmPath);
  const currentHash = crypto
    .createHash("sha256")
    .update(wasmBuffer)
    .digest("hex");

  if (currentHash !== YIELD_VAULT_SPEC_HASH) {
    console.error(`❌ SPEC DRIFT DETECTED!`);
    console.error(`  WASM Artifact SHA-256: ${currentHash}`);
    console.error(`  SDK Pinned Spec Hash:  ${YIELD_VAULT_SPEC_HASH}`);
    console.error(
      `Please run 'npm run build:bindings' in packages/sdk to update generated bindings.`
    );
    process.exit(1);
  }

  console.log("  [OK] Contract spec hash is up-to-date with WASM artifact.");
}

function verifyApiDrift() {
  console.log("--> Checking ApiClient OpenAPI route drift...");
  if (!fs.existsSync(openapiPath)) {
    console.error(`❌ openapi.yaml not found at ${openapiPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(apiClientPath)) {
    console.error(`❌ ApiClient.ts not found at ${apiClientPath}`);
    process.exit(1);
  }

  const openapiContent = fs.readFileSync(openapiPath, "utf-8");
  const apiClientContent = fs.readFileSync(apiClientPath, "utf-8");

  // Extract paths defined in openapi.yaml
  const openapiPaths = new Set<string>();
  const pathRegex = /^  (\/api\/[a-zA-Z0-9_\/\{\}\-]+):/gm;
  let match;
  while ((match = pathRegex.exec(openapiContent)) !== null) {
    openapiPaths.add(match[1]);
  }

  // Extract endpoints queried in ApiClient.ts (urls like `/api/...` or `${this.baseUrl}/api/...`)
  const apiRouteRegex = /\/api\/[a-zA-Z0-9_\/$\{\}\-]+/g;
  const queriedRoutes = new Set<string>();
  let routeMatch;
  while ((routeMatch = apiRouteRegex.exec(apiClientContent)) !== null) {
    let route = routeMatch[0];
    // Clean trailing quotes, backticks, or query params
    route = route.split("?")[0].split("`")[0].split('"')[0].split("'")[0];
    // Convert template literals like ${walletAddress} to openapi format {walletAddress}
    route = route.replace(/\$\{([a-zA-Z0-9_]+)\}/g, "{$1}");
    queriedRoutes.add(route);
  }

  const missingRoutes: string[] = [];
  for (const route of queriedRoutes) {
    if (!openapiPaths.has(route)) {
      missingRoutes.push(route);
    }
  }

  if (missingRoutes.length > 0) {
    console.error(`❌ API ROUTE DRIFT DETECTED!`);
    console.error(`The following routes in ApiClient.ts are missing from server/openapi.yaml:`);
    missingRoutes.forEach((r) => console.error(`  - ${r}`));
    process.exit(1);
  }

  console.log(`  [OK] All ${queriedRoutes.size} ApiClient routes match server/openapi.yaml.`);
}

function main() {
  verifyWasmDrift();
  verifyApiDrift();
  console.log("\n✅ All drift checks passed successfully.");
}

main();
