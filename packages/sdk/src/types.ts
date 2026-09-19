export interface VaultConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
  specHashPin?: string;
  contractVersionPin?: string;
  storageVersionPin?: number;
}

export interface ApiConfig {
  baseUrl: string;
}

export interface DepositParams {
  from: string;
  amount: string;
  minSharesOut?: string;
}

export interface WithdrawParams {
  to: string;
  shares: string;
}

export interface HarvestParams {
  caller: string;
  minAmountOut: string;
}

export interface RebalanceParams {
  caller: string;
  target: string;
  amount: string;
}

export interface EmergencyWithdrawParams {
  to: string;
  shares: string;
}

export interface VaultInfo {
  totalShares: string;
  totalAssets: string;
  token: string;
  admin: string;
}

export interface ApiVaultData {
  id?: string;
  name?: string;
  symbol?: string;
  apy: number;
  tvl: number;
  historicalData: HistoricalDataPoint[];
}

export interface HistoricalDataPoint {
  timestamp: string;
  apy: number;
  tvl: number;
}

export interface SDKConfig {
  vault: VaultConfig;
  api?: ApiConfig;
}

export interface UpgradeProposal {
  id: string;
  network: string;
  contractId: string;
  currentWasmHash: string;
  targetWasmHash: string;
  migrationPlanDigest: string;
  executionTime: string;
  expiryTime: string;
  migrationId: string;
  proposedAt: string;
}

export interface MigrationStatus {
  fromVersion: number;
  toVersion: number;
  cursor: string;
  totalApplied: number;
  complete: boolean;
}

export type {
  TransactionStatus,
  WaitOptions,
} from "./lifecycle";

export type { SignerAdapter } from "./signers";
