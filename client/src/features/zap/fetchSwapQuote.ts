import type { ZapQuoteRequest, ZapQuoteResponse } from "./types";
import { apiUrl } from "../../lib/api";
import type { RequestOptions } from "../../lib/requestCancellation";
import { fetchJson } from "../../lib/requestCancellation";

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 */
export async function fetchSwapQuote(
  req: ZapQuoteRequest,
  options?: RequestOptions,
): Promise<ZapQuoteResponse> {
  return fetchJson<ZapQuoteResponse>(apiUrl("/api/zap/quote"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    ...options,
  });
}
