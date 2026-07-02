export interface BacktestRequest {
  vaultContractId: string;
  startDate: string;
  endDate: string;
  depositAmount: bigint;
}

export interface BacktestResult {
  request: BacktestRequest;
  isValid: boolean;
  errors: Array<{ code: string; message: string; field?: string }>;
}

export interface DailySnapshot {
  date: string;
  balance: bigint;
  yieldEarned: bigint;
  apy?: number;
  equityValue?: bigint;
}
