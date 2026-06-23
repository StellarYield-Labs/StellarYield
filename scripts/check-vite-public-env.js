#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_ROOTS = [
  "client",
  "docs",
  ".github/workflows",
  "vercel.json",
];

const FORBIDDEN_NAME_PATTERNS = [
  /SECRET/i,
  /PRIVATE/i,
  /PRIVKEY/i,
  /PASSWORD/i,
  /PASSCODE/i,
  /TOKEN/i,
  /CREDENTIAL/i,
  /SIGNING/i,
  /WEBHOOK/i,
  /PINATA/i,
  /OPENAI/i,
  /GEMINI/i,
  /RELAYER/i,
  /DATABASE/i,
  /MONGODB/i,
  /SMTP/i,
  /METRICS/i,
];

const ALLOWED_PUBLIC_VITE_NAMES = new Set([
  "VITE_API_BASE_URL",
  "VITE_API_URL",
  "VITE_APP_URL",
  "VITE_AQUA_SAC_CONTRACT_ID",
  "VITE_CONFIG_PATH",
  "VITE_CONTRACT_ID",
  "VITE_EMISSION_CONTROLLER_CONTRACT_ID",
  "VITE_GOOGLE_CLIENT_ID",
  "VITE_GOVERNANCE_CONTRACT_ID",
  "VITE_LIQUID_STAKING_CONTRACT_ID",
  "VITE_NETWORK_PASSPHRASE",
  "VITE_OFFRAMP_API_KEY",
  "VITE_OFFRAMP_BASE_URL",
  "VITE_OG_API_BASE_URL",
  "VITE_SOROBAN_RPC_URL",
  "VITE_STABLESWAP_CONTRACT_ID",
  "VITE_STELLAR_NETWORK",
  "VITE_STRATEGY_CONTRACT_ID",
  "VITE_TOKEN_CONTRACT_ID",
  "VITE_USDC_SAC_CONTRACT_ID",
  "VITE_VAULT_CONTRACT_ID",
  "VITE_VAULT_TOKEN_CONTRACT_ID",
  "VITE_VAULT_TOKEN_DECIMALS",
  "VITE_VAULT_TOKEN_SYMBOL",
  "VITE_VESTING_CONTRACT_ID",
  "VITE_XLM_SAC_CONTRACT_ID",
  "VITE_ZAP_ASSETS_JSON",
  "VITE_ZAP_CONTRACT_ID",
  "VITE_ZAP_METADATA_FROM_API",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (base.startsWith(".env")) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath));
}

function* walk(entry) {
  const fullPath = path.join(ROOT, entry);
  if (!fs.existsSync(fullPath)) return;

  const stat = fs.statSync(fullPath);
  if (stat.isFile()) {
    if (isTextFile(fullPath)) yield fullPath;
    return;
  }

  const children = fs.readdirSync(fullPath, { withFileTypes: true });
  for (const child of children) {
    if (child.name === "node_modules" || child.name === "dist" || child.name === "build") {
      continue;
    }
    yield* walk(path.join(entry, child.name));
  }
}

const findings = [];
const seenNames = new Map();
const viteNamePattern = /\bVITE_[A-Z0-9_]+\b/g;

for (const root of SCAN_ROOTS) {
  for (const filePath of walk(root)) {
    const rel = path.relative(ROOT, filePath);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      const matches = line.matchAll(viteNamePattern);
      for (const match of matches) {
        const name = match[0];
        if (!seenNames.has(name)) seenNames.set(name, []);
        seenNames.get(name).push(`${rel}:${index + 1}`);

        if (ALLOWED_PUBLIC_VITE_NAMES.has(name)) {
          continue;
        }

        const suspicious = FORBIDDEN_NAME_PATTERNS.some((pattern) => pattern.test(name));
        if (suspicious) {
          findings.push({
            rel,
            line: index + 1,
            name,
            reason: "sensitive-looking VITE_ variable name",
          });
        }
      }
    });
  }
}

for (const [name, locations] of seenNames.entries()) {
  if (!ALLOWED_PUBLIC_VITE_NAMES.has(name)) {
    findings.push({
      rel: locations[0].split(":")[0],
      line: locations[0].split(":")[1],
      name,
      reason: "VITE_ variable is not in the public allowlist",
    });
  }
}

if (findings.length > 0) {
  console.error("Unsafe frontend environment variables found:");
  for (const finding of findings) {
    console.error(`- ${finding.rel}:${finding.line} ${finding.name} (${finding.reason})`);
  }
  console.error(
    "\nVite exposes every VITE_ variable to the browser bundle. Move secrets to server/.env and proxy secret-dependent flows through backend routes.",
  );
  process.exit(1);
}

console.log(`Validated ${seenNames.size} public VITE_ variable names.`);
