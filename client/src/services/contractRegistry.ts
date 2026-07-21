/**
 * Contract address registry (#185).
 *
 * Resolves Soroban contract IDs for the active network. Environment variables
 * always override registry values so deployers can inject addresses without
 * modifying the JSON file.
 *
 * Priority (highest → lowest):
 *   1. VITE_* environment variables
 *   2. contracts/registry.json for the active network
 *   3. Empty string (caller must handle missing IDs)
 */

import registryJson from "../../../contracts/registry.json";

export const CONTRACT_NAMES: ContractName[] = [
  "vault", "zap", "token", "governance", "strategy",
  "emissionController", "liquidStaking", "stableswap",
];

export type ContractName =
  | "vault"
  | "zap"
  | "token"
  | "governance"
  | "strategy"
  | "emissionController"
  | "liquidStaking"
  | "stableswap";

export type NetworkName = "testnet" | "mainnet" | "local";

export type RegistryWarning = {
  network: NetworkName;
  missingContracts: ContractName[];
  warningMessage: string;
};

type Registry = Record<NetworkName, Record<ContractName, string>>;

const registry = registryJson as Registry;

export function detectNetwork(): NetworkName {
  const passphrase =
    import.meta.env.VITE_NETWORK_PASSPHRASE ?? "";
  if (passphrase.includes("mainnet") || passphrase.includes("Public Global")) {
    return "mainnet";
  }
  if (passphrase === "" || passphrase.includes("local") || passphrase.includes("standalone")) {
    return "local";
  }
  return "testnet";
}

const ENV_MAP: Record<ContractName, string> = {
  vault: "VITE_CONTRACT_ID",
  zap: "VITE_ZAP_CONTRACT_ID",
  token: "VITE_TOKEN_CONTRACT_ID",
  governance: "VITE_GOVERNANCE_CONTRACT_ID",
  strategy: "VITE_STRATEGY_CONTRACT_ID",
  emissionController: "VITE_EMISSION_CONTROLLER_CONTRACT_ID",
  liquidStaking: "VITE_LIQUID_STAKING_CONTRACT_ID",
  stableswap: "VITE_STABLESWAP_CONTRACT_ID",
};

export function getContractId(
  name: ContractName,
  network?: NetworkName,
): string {
  const envKey = ENV_MAP[name];
  const envOverride = import.meta.env[envKey];
  if (typeof envOverride === "string" && envOverride) return envOverride;

  const net = network ?? detectNetwork();
  return registry[net]?.[name] ?? "";
}

export function getAllContractIds(network?: NetworkName): Record<ContractName, string> {
  const net = network ?? detectNetwork();
  return Object.fromEntries(
    CONTRACT_NAMES.map((n) => [n, getContractId(n, net)]),
  ) as Record<ContractName, string>;
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

export function validateRegistry(network?: NetworkName): RegistryWarning {
  const net = network ?? detectNetwork();
  const ids = getAllContractIds(net);

  const missingContracts = CONTRACT_NAMES
    .filter((name) => isBlank(ids[name]))
    .sort();

  const warningMessage = missingContracts.length > 0
    ? `Missing contract IDs for ${net}:\n${missingContracts.map((c) => `- ${c}`).join("\n")}`
    : "";

  return { network: net, missingContracts, warningMessage };
}
