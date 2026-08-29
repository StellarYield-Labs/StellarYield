import type { ZapQuoteRequest, ZapQuoteResponse, ZapQuoteVerifyRequest, ZapQuoteVerifyResponse } from "./types";
import { apiUrl } from "../../lib/api";

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 */
export async function fetchSwapQuote(
  req: ZapQuoteRequest,
): Promise<ZapQuoteResponse> {
  const res = await fetch(apiUrl("/api/zap/quote"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Quote failed (${res.status})`);
  }

  return res.json() as Promise<ZapQuoteResponse>;
}

/**
 * Verify a quote is still valid for execution before submitting on-chain.
 * Checks expiry, asset pair, freeze, and fallback confirmation.
 */
export async function verifyZapQuote(
  req: ZapQuoteVerifyRequest,
): Promise<ZapQuoteVerifyResponse> {
  const res = await fetch(apiUrl("/api/zap/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Return structured error even on non-2xx so UI can show specific messaging
    return body as ZapQuoteVerifyResponse;
  }
  return body as ZapQuoteVerifyResponse;
}

/**
 * Helper to determine if a quote is expired based on expiresAt.
 */
export function isQuoteExpired(quote: ZapQuoteResponse, nowMs: number = Date.now()): boolean {
  if (!quote.expiresAt) return false;
  const exp = new Date(quote.expiresAt).getTime();
  if (isNaN(exp)) return false;
  return nowMs > exp;
}

/**
 * Helper to determine if a quote is stale (over half TTL or past expiresAt).
 */
export function isQuoteStale(quote: ZapQuoteResponse, nowMs: number = Date.now()): boolean {
  if (isQuoteExpired(quote, nowMs)) return true;
  const quotedMs = new Date(quote.quotedAt).getTime();
  if (isNaN(quotedMs)) return false;
  const ttl = quote.expiresInMs ?? 30000;
  // Consider stale if older than TTL or half TTL depending on UX; we treat TTL as stale threshold
  return nowMs - quotedMs > ttl;
}
