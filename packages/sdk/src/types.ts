export interface VaultConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
  specHashPin?: string;
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

// ── Upgrade / Version types ──────────────────────────────────────────

export interface UpgradeConfig {
  contractId: string;
  networkPassphrase: string;
  rpcUrl: string;
  simulationAccount?: string;
}

export interface ContractVersionInfo {
  contractVersion: number;
  storageVersion: number;
}

export interface ScheduleUpgradeParams {
  governance: string;
  wasmHash: string;
  expectedCurrentHash: string;
  migrationId: number;
}

export interface MigrateParams {
  governance: string;
  fromVersion: number;
  toVersion: number;
  cursor: string | null;
  limit: number;
}

export interface MigrationStatusInfo {
  isActive: boolean;
  fromVersion: number;
  toVersion: number;
  progress: number;
  totalBatches: number;
  cursor: string | null;
}

export class IncompatibleContractError extends Error {
  public readonly contractVersion: number;
  public readonly storageVersion: number;
  public readonly minSpecVersion: number;
  public readonly minStorageVersion: number;

  constructor(
    contractVersion: number,
    storageVersion: number,
    minSpecVersion: number,
    minStorageVersion: number,
  ) {
    super(
      `Contract v${contractVersion} / storage v${storageVersion} is incompatible with ` +
      `required spec v${minSpecVersion}+ / storage v${minStorageVersion}+`
    );
    this.name = "IncompatibleContractError";
    this.contractVersion = contractVersion;
    this.storageVersion = storageVersion;
    this.minSpecVersion = minSpecVersion;
    this.minStorageVersion = minStorageVersion;
  }
}

export type {
  TransactionStatus,
  WaitOptions,
} from "./lifecycle";

export type { SignerAdapter } from "./signers";
