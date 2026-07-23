import type { ApiConfig, ApiVaultData, HistoricalDataPoint } from "../types";

export class ApiClient {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  async getHealth(): Promise<{ database: string; horizon: string }> {
    const response = await fetch(`${this.config.baseUrl}/api/health`);
    if (!response.ok) {
      throw new Error(`Failed to fetch health: ${response.statusText}`);
    }
    return (await response.json()) as { database: string; horizon: string };
  }

  async getYields(): Promise<ApiVaultData[]> {
    const response = await fetch(`${this.config.baseUrl}/api/yields`);
    if (!response.ok) {
      throw new Error(`Failed to fetch yields: ${response.statusText}`);
    }
    return (await response.json()) as ApiVaultData[];
  }

  async getHistoricalYields(days: number = 30): Promise<HistoricalDataPoint[]> {
    const response = await fetch(`${this.config.baseUrl}/api/yields/history?days=${days}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch historical yields: ${response.statusText}`);
    }
    return (await response.json()) as HistoricalDataPoint[];
  }

  async getUserPnL(walletAddress: string): Promise<{ totalPnl: number; netYield: number }> {
    const response = await fetch(`${this.config.baseUrl}/api/users/${walletAddress}/pnl`);
    if (!response.ok) {
      throw new Error(`Failed to fetch user PnL: ${response.statusText}`);
    }
    return (await response.json()) as { totalPnl: number; netYield: number };
  }

  async getZapQuote(fromAsset: string, toAsset: string, amount: string): Promise<{ expectedAmount: string; priceImpact: number }> {
    const response = await fetch(`${this.config.baseUrl}/api/zap/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromAsset, toAsset, amount }),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch zap quote: ${response.statusText}`);
    }
    return (await response.json()) as { expectedAmount: string; priceImpact: number };
  }

  async getReferralData(walletAddress: string): Promise<{ totalReferredTvl: string; unclaimedRewards: string }> {
    const response = await fetch(`${this.config.baseUrl}/api/referrals/${walletAddress}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch referral data: ${response.statusText}`);
    }
    return (await response.json()) as { totalReferredTvl: string; unclaimedRewards: string };
  }
}
