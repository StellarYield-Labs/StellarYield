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

export interface RequestOptions {
  signal?: AbortSignal;
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

export interface ZapQuoteResult {
  expectedAmount: string;
  priceImpact: number;
}

export interface DepositSimulationAllocation {
  protocol: string;
  amount: number;
  percentage: number;
}

export interface DepositSimulationFee {
  type: string;
  amount: number;
}

export interface DepositSimulationResult {
  isSimulationOnly: true;
  allocations: DepositSimulationAllocation[];
  expectedShares: number;
  fees: DepositSimulationFee[];
  postDepositExposure: {
    expectedApy: number;
  };
  routing: {
    path: string[];
    expectedOutput: number;
  };
  warnings: string[];
}

export interface DepositSimulationParams {
  strategyId: string;
  amount: number;
  token: string;
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
