import type { ZapQuoteRequest, ZapQuoteResponse, ZapQuoteVerifyRequest, ZapQuoteVerifyResponse } from "./types";
import { apiUrl } from "../../lib/api";

/**
 * Ask the backend for the best known swap path and expected vault-token output.
 * Falls back to a deterministic ratio when the DEX router is not configured.
 * Includes slippage tolerance and returns quote metadata (age, source, min output).
 * Now includes safety envelope: quoteId, expiresAt, TTL, signature, and freeze binding.
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
 * Verify a quote is still executable before on-chain submission.
 * Checks expiry, asset-pair binding, fallback distinction, and freeze invalidation.
 * Returns a structured result; caller should block execution if `valid === false`.
 */
export async function verifySwapQuote(
  req: ZapQuoteVerifyRequest,
): Promise<ZapQuoteVerifyResponse> {
  const res = await fetch(apiUrl("/api/zap/verify"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  const body = (await res.json().catch(() => ({}))) as ZapQuoteVerifyResponse;

  if (!res.ok) {
    // Verification endpoint returns 422 with structured error, but also handle 400/500
    if (body && typeof body.valid === "boolean") return body;
    throw new Error(body.reason || body.message || `Verification failed (${res.status})`);
  }

  return body;
}

export function isZapQuoteExpired(quote: ZapQuoteResponse, nowMs = Date.now()): boolean {
  if (quote.expiresAt) {
    const exp = new Date(quote.expiresAt).getTime();
    if (!Number.isNaN(exp)) return nowMs > exp;
  }
  const ttl = quote.ttlMs ?? 30_000;
  const quotedAtMs = new Date(quote.quotedAt).getTime();
  if (Number.isNaN(quotedAtMs)) return true;
  return nowMs > quotedAtMs + ttl;
}

export function isZapQuoteStale(quote: ZapQuoteResponse, nowMs = Date.now()): boolean {
  return isZapQuoteExpired(quote, nowMs);
}
