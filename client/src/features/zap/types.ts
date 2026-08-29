/** One hop in a Stellar DEX path (contract-backed asset). */
export interface SwapPathHop {
  contractId: string;
  /** Human-readable hint for UI when known (e.g. "XLM"). */
  label?: string;
}

/** Request body for `POST /api/zap/quote`. */
export interface ZapQuoteRequest {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  inputDecimals: number;
  vaultDecimals: number;
  slippageTolerance?: number;
  protocol?: string;
}

/** Quote used to show expected vault-token output and to derive `min_amount_out`. */
export interface ZapQuoteResponse {
  path: SwapPathHop[];
  expectedAmountOutStroops: string;
  source: "router_simulation" | "fallback_rate";
  slippageApplied: number;
  amountOutAfterSlippage: string;
  quotedAt: string;
  minAmountOutStroops: string;
  quoteAgeMs: number;
  isFallback: boolean;
  // ── Safety envelope ──
  quoteId: string;
  expiresAt: string;
  ttlMs: number;
  protocol: string;
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  quoteSignature: string;
  freezeCheckedAt: string;
}

/** Verification request/response for quote execution binding */
export interface ZapQuoteVerifyRequest {
  quote: ZapQuoteResponse;
  inputTokenContract?: string;
  vaultTokenContract?: string;
  amountInStroops?: string;
  protocol?: string;
  allowFallback?: boolean;
}

export interface ZapQuoteVerifyResponse {
  valid: boolean;
  code?: string;
  reason?: string;
  requiresRequote?: boolean;
  isFallback?: boolean;
  isExpired?: boolean;
  quoteId?: string;
  expiresAt?: string;
  message?: string;
}

/** Asset the user can select as zap input (Soroban SAC contract id). */
export interface ZapAssetOption {
  symbol: string;
  name: string;
  contractId: string;
  decimals: number;
  /** Optional URL for UI avatars / icons when provided by the metadata API */
  iconUrl?: string;
}

/** Response from `GET /api/zap/supported-assets` */
export interface ZapSupportedAssetsMetadata {
  assets: ZapAssetOption[];
  vaultToken: ZapAssetOption;
  vaultContractId: string;
}
