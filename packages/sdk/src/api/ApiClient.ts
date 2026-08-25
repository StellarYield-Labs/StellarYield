import type {
  ApiConfig,
  ApiVaultData,
  DepositSimulationParams,
  DepositSimulationResult,
  HistoricalDataPoint,
  RequestOptions,
  ZapQuoteResult,
} from "../types";
import { apiRequest } from "./request";

export class ApiClient {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  async getHealth(options?: RequestOptions): Promise<{ database: string; horizon: string }> {
    return apiRequest(`${this.config.baseUrl}/api/health`, options);
  }

  async getYields(options?: RequestOptions): Promise<ApiVaultData[]> {
    return apiRequest(`${this.config.baseUrl}/api/yields`, options);
  }

  async getHistoricalYields(
    days: number = 30,
    options?: RequestOptions,
  ): Promise<HistoricalDataPoint[]> {
    return apiRequest(`${this.config.baseUrl}/api/yields/history?days=${days}`, options);
  }

  async getUserPnL(
    walletAddress: string,
    options?: RequestOptions,
  ): Promise<{ totalPnl: number; netYield: number }> {
    return apiRequest(`${this.config.baseUrl}/api/users/${walletAddress}/pnl`, options);
  }

  async getZapQuote(
    fromAsset: string,
    toAsset: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<ZapQuoteResult> {
    return apiRequest(`${this.config.baseUrl}/api/zap/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAsset, toAsset, amount }),
      ...options,
    });
  }

  async getDepositSimulation(
    params: DepositSimulationParams,
    options?: RequestOptions,
  ): Promise<DepositSimulationResult> {
    return apiRequest(`${this.config.baseUrl}/api/simulator/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      ...options,
    });
  }

  async getReferralData(
    walletAddress: string,
    options?: RequestOptions,
  ): Promise<{ totalReferredTvl: string; unclaimedRewards: string }> {
    return apiRequest(`${this.config.baseUrl}/api/referrals/${walletAddress}`, options);
  }
}
