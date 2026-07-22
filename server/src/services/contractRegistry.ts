/**
 * Contract address registry — server side (#185).
 *
 * Reads contract IDs from contracts/registry.json and applies process.env
 * overrides in the same priority order as the client-side version.
 */

import * as path from "path";
import * as fs from "fs";

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

const REGISTRY_PATH = path.resolve(
  __dirname,
  "../../../../contracts/registry.json",
);

function loadRegistry(): Registry {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as Registry;
  } catch {
    return { testnet: {} as Record<ContractName, string>, mainnet: {} as Record<ContractName, string>, local: {} as Record<ContractName, string> };
  }
}

const registry = loadRegistry();

export function detectNetwork(): NetworkName {
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE ?? "";
  if (passphrase.includes("mainnet") || passphrase.includes("Public Global")) {
    return "mainnet";
  }
  const horizon = process.env.STELLAR_HORIZON_URL ?? "";
  if (horizon.includes("testnet") || passphrase.includes("testnet")) {
    return "testnet";
  }
  if (horizon.includes("local") || horizon.includes("localhost")) {
    return "local";
  }
  return "testnet";
}

const ENV_MAP: Record<ContractName, string> = {
  vault: "CONTRACT_ID",
  zap: "ZAP_CONTRACT_ID",
  token: "TOKEN_CONTRACT_ID",
  governance: "GOVERNANCE_CONTRACT_ID",
  strategy: "STRATEGY_CONTRACT_ID",
  emissionController: "EMISSION_CONTROLLER_CONTRACT_ID",
  liquidStaking: "LIQUID_STAKING_CONTRACT_ID",
  stableswap: "STABLESWAP_CONTRACT_ID",
};

export function getContractId(
  name: ContractName,
  network?: NetworkName,
): string {
  const envKey = ENV_MAP[name];
  const envOverride = process.env[envKey];
  if (envOverride) return envOverride;

  const net = network ?? detectNetwork();
  return registry[net]?.[name] ?? "";
}

export function getAllContractIds(
  network?: NetworkName,
): Record<ContractName, string> {
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
