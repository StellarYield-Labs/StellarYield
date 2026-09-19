export type IndexerContractType =
  | "vault"
  | "zap"
  | "token"
  | "governance"
  | "strategy"
  | "bridge"
  | "unknown";

export interface ContractStreamConfig {
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  contractId: string;
  contractType: IndexerContractType;
  deploymentLedger: number;
  specVersion: number;
  decoderVersion: number;
}

const DEFAULT_RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const DEFAULT_NETWORK = process.env.STELLAR_NETWORK || "testnet";
const DEFAULT_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseContractType(value: unknown): IndexerContractType {
  const candidate = String(value || "unknown");
  if (
    candidate === "vault" ||
    candidate === "zap" ||
    candidate === "token" ||
    candidate === "governance" ||
    candidate === "strategy" ||
    candidate === "bridge"
  ) {
    return candidate;
  }
  return "unknown";
}

function normalizeStream(raw: Record<string, unknown>): ContractStreamConfig {
  const contractId = String(raw.contractId || raw.CONTRACT_ID || "").trim();
  if (!contractId) {
    throw new Error("Indexer contract entry is missing contractId");
  }

  return {
    network: String(raw.network || DEFAULT_NETWORK),
    networkPassphrase: String(raw.networkPassphrase || DEFAULT_NETWORK_PASSPHRASE),
    rpcUrl: String(raw.rpcUrl || DEFAULT_RPC_URL),
    contractId,
    contractType: parseContractType(raw.contractType),
    deploymentLedger: parsePositiveInteger(raw.deploymentLedger, 0),
    specVersion: parsePositiveInteger(raw.specVersion, 1),
    decoderVersion: parsePositiveInteger(raw.decoderVersion, 1),
  };
}

/**
 * Loads the indexer's multi-contract registry from INDEXER_CONTRACTS_JSON.
 *
 * Example:
 * INDEXER_CONTRACTS_JSON='[
 *   {"network":"testnet","contractId":"CD...","contractType":"vault","deploymentLedger":12345}
 * ]'
 *
 * Falls back to the previous VITE_CONTRACT_ID/CONTRACT_ID convention so local
 * development keeps working while operators migrate to the registry.
 */
export function loadContractStreamsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ContractStreamConfig[] {
  const registryJson = env.INDEXER_CONTRACTS_JSON;
  if (registryJson) {
    const parsed = JSON.parse(registryJson) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("INDEXER_CONTRACTS_JSON must be a JSON array");
    }
    return parsed.map((entry) => normalizeStream(entry as Record<string, unknown>));
  }

  const legacyContractId = env.CONTRACT_ID || env.VITE_CONTRACT_ID;
  if (!legacyContractId) {
    return [];
  }

  return [
    normalizeStream({
      network: env.STELLAR_NETWORK,
      networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
      rpcUrl: env.RPC_URL,
      contractId: legacyContractId,
      contractType: "vault",
      deploymentLedger: env.INDEXER_DEPLOYMENT_LEDGER,
    }),
  ];
}

export function streamKey(stream: Pick<ContractStreamConfig, "network" | "contractId">): string {
  return `${stream.network}:${stream.contractId}`;
}
