/**
 * Typed, validated schema for public frontend environment variables.
 *
 * Rules:
 *  - Only values that are SAFE to ship in the browser bundle belong here.
 *  - Secrets (API keys, private keys, OAuth client secrets) must live in
 *    server/.env and be accessed exclusively through backend proxy endpoints.
 *  - Variable names that contain SECRET, PRIVATE, or API_KEY are rejected
 *    at runtime in development to catch misconfigurations early.
 */

const FORBIDDEN_PATTERNS = [/_SECRET/i, /_PRIVATE/i, /_API_KEY/i, /_PRIVATE_KEY/i];

function assertNotSecret(name: string, value: string | undefined): void {
  if (value && FORBIDDEN_PATTERNS.some((re) => re.test(name))) {
    throw new Error(
      `[env] "${name}" looks like a secret but is exposed as a VITE_ variable. ` +
        `Move it to the server and access it through a backend proxy endpoint.`,
    );
  }
}

function readPublicEnv() {
  const env = import.meta.env as Record<string, string | undefined>;

  // Validate that no suspicious names sneak in at runtime (dev guard).
  if (env.MODE !== "production") {
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("VITE_")) assertNotSecret(key, value);
    }
  }

  return {
    /** Public OAuth client ID — safe to expose (not a secret). */
    GOOGLE_CLIENT_ID: env.VITE_GOOGLE_CLIENT_ID ?? "",

    /** Soroban RPC network passphrase. */
    NETWORK_PASSPHRASE: env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",

    /** Primary yield vault contract ID. */
    CONTRACT_ID: env.VITE_CONTRACT_ID ?? "",

    /** Zap contract ID. */
    ZAP_CONTRACT_ID: env.VITE_ZAP_CONTRACT_ID ?? "",

    /** Token contract ID. */
    TOKEN_CONTRACT_ID: env.VITE_TOKEN_CONTRACT_ID ?? "",

    /** Governance contract ID. */
    GOVERNANCE_CONTRACT_ID: env.VITE_GOVERNANCE_CONTRACT_ID ?? "",

    /** Stellar network identifier (mainnet | testnet). */
    STELLAR_NETWORK: (env.VITE_STELLAR_NETWORK ?? "testnet") as "mainnet" | "testnet",

    /** Public base URL of the app (used for referral links etc.). */
    APP_URL: env.VITE_APP_URL ?? "",

    /** Frontend API base URL (public). */
    API_BASE_URL: env.VITE_API_BASE_URL ?? env.VITE_API_URL ?? "",

    /** OG image API base URL (public CDN/edge). */
    OG_API_BASE_URL: env.VITE_OG_API_BASE_URL ?? "",

    /** Off-ramp base URL for the backend proxy (public endpoint, no credentials). */
    OFFRAMP_BASE_URL: env.VITE_OFFRAMP_BASE_URL ?? "",
  } as const;
}

export const clientEnv = readPublicEnv();
