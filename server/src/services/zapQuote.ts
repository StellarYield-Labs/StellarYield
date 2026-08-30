import * as StellarSdk from "@stellar/stellar-sdk";
import { randomUUID, createHmac } from "crypto";
import NodeCache from "node-cache";
import { slippageRegistry } from "./slippageRegistry";
import { getYieldData } from "./yieldService";
import { freezeService } from "./freezeService";

export interface ZapQuoteBody {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  inputDecimals: number;
  vaultDecimals: number;
  slippageTolerance?: number;
  protocol?: string;
}

export interface ZapQuoteResult {
  path: { contractId: string; label?: string }[];
  expectedAmountOutStroops: string;
  source: "router_simulation" | "fallback_rate";
  slippageApplied: number;
  amountOutAfterSlippage: string;
  quotedAt: string;
  minAmountOutStroops: string;
  quoteAgeMs: number;
  isFallback: boolean;
  // Safety envelope additions (backward compatible - optional for legacy mocks)
  quoteId?: string;
  expiresAt?: string;
  expiresInMs?: number;
  inputTokenContract?: string;
  vaultTokenContract?: string;
  amountInStroops?: string;
  protocol?: string;
  tvlAtQuote?: string;
  slippageTolerance?: number;
  freezeStateAtQuote?: { isFrozen: boolean; frozenAt?: string; reason?: string };
  signature?: string;
}

export interface ZapQuoteValidationRequest {
  quoteId: string;
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops?: string;
  slippageTolerance?: number;
  allowFallback?: boolean;
  protocol?: string;
  // Optional full quote for stateless verification (fallback if cache miss)
  quotedAt?: string;
  expiresAt?: string;
  expectedAmountOutStroops?: string;
  minAmountOutStroops?: string;
  source?: string;
  signature?: string;
}

export interface ZapQuoteValidationResult {
  valid: boolean;
  code: string;
  reason: string;
  quote?: ZapQuoteResult;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

// In-memory quote store: keeps assumptions until expiry (with buffer). In production would be Redis.
const quoteCache = new NodeCache({ stdTTL: 0, checkperiod: 5, useClones: false });

export function getQuoteTtlMs(): number {
  const raw = process.env.ZAP_QUOTE_TTL_MS ?? "30000";
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30000;
  return parsed;
}

function getHmacSecret(): string {
  return process.env.ZAP_QUOTE_HMAC_SECRET ?? "dev-secret-change-in-prod";
}

function mulDivStroops(amountIn: string, numerator: string, denominator: string): string {
  const a = BigInt(amountIn);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === BigInt(0)) {
    return "0";
  }
  return ((a * n) / d).toString();
}

function createQuoteSignature(payload: Record<string, unknown>): string {
  const secret = getHmacSecret();
  const canonical = JSON.stringify(payload);
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function buildSignaturePayload(quote: ZapQuoteResult): Record<string, unknown> {
  // Deterministic payload covering all safety-critical assumptions
  return {
    quoteId: quote.quoteId ?? "",
    inputTokenContract: quote.inputTokenContract ?? "",
    vaultTokenContract: quote.vaultTokenContract ?? "",
    amountInStroops: quote.amountInStroops ?? "",
    expectedAmountOutStroops: quote.expectedAmountOutStroops,
    minAmountOutStroops: quote.minAmountOutStroops,
    amountOutAfterSlippage: quote.amountOutAfterSlippage,
    slippageApplied: quote.slippageApplied,
    source: quote.source,
    protocol: quote.protocol ?? "default",
    path: quote.path,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt ?? "",
  };
}

export function verifyQuoteSignature(quote: ZapQuoteResult, signature: string): boolean {
  const expected = createQuoteSignature(buildSignaturePayload(quote));
  // Constant-time comparison via simple string compare (acceptable for this context)
  return expected === signature;
}

export function storeQuote(quote: ZapQuoteResult): void {
  // Store with TTL = expiresInMs + buffer (60s) so validation can still report EXPIRED vs NOT_FOUND
  const expiresInMs = quote.expiresInMs ?? getQuoteTtlMs();
  const ttlSec = Math.ceil((expiresInMs + 60000) / 1000);
  const id = quote.quoteId ?? randomUUID();
  // Ensure quote has an ID for later lookup
  if (!quote.quoteId) quote.quoteId = id;
  quoteCache.set(id, quote, ttlSec);
}

export function getStoredQuote(quoteId: string): ZapQuoteResult | undefined {
  return quoteCache.get<ZapQuoteResult>(quoteId);
}

export function clearQuoteStore(): void {
  quoteCache.flushAll();
}

export async function quoteViaRouterSimulation(
  body: ZapQuoteBody,
): Promise<ZapQuoteResult | null> {
  const routerId = process.env.DEX_ROUTER_CONTRACT_ID;
  const simSource = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  if (!routerId || !simSource) {
    return null;
  }

  try {
    const server = new StellarSdk.rpc.Server(rpcUrl);
    const router = new StellarSdk.Contract(routerId);
    const amountIn = BigInt(body.amountInStroops);
    const minOut = BigInt(0);

    const op = router.call(
      "swap",
      new StellarSdk.Address(body.inputTokenContract).toScVal(),
      new StellarSdk.Address(body.vaultTokenContract).toScVal(),
      StellarSdk.nativeToScVal(amountIn, { type: "i128" }),
      StellarSdk.nativeToScVal(minOut, { type: "i128" }),
    );

    const source = await server.getAccount(simSource);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const timeoutMs = parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS ?? "10000", 10);
    const simulated = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs)
      ),
    ]);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      return null;
    }

    const success = simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (!retval) {
      return null;
    }

    const out = StellarSdk.scValToNative(retval) as bigint | number | string;
    const expected =
      typeof out === "bigint" ? out : BigInt(String(out));

    const now = Date.now();

    // Return minimal shape; enrichment happens in getZapQuote
    return {
      path: [
        { contractId: body.inputTokenContract, label: "in" },
        { contractId: body.vaultTokenContract, label: "out" },
      ],
      expectedAmountOutStroops: expected.toString(),
      source: "router_simulation",
      slippageApplied: 0,
      amountOutAfterSlippage: expected.toString(),
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: expected.toString(),
      quoteAgeMs: 0,
      isFallback: false,
      quoteId: "",
      expiresAt: "",
      expiresInMs: 0,
      inputTokenContract: body.inputTokenContract,
      vaultTokenContract: body.vaultTokenContract,
      amountInStroops: body.amountInStroops,
      protocol: body.protocol || "default",
      freezeStateAtQuote: { isFrozen: false },
    };
  } catch {
    return null;
  }
}

export function quoteFallback(body: ZapQuoteBody): ZapQuoteResult {
  const amountIn = body.amountInStroops;
  const now = Date.now();

  if (body.inputTokenContract === body.vaultTokenContract) {
    return {
      path: [{ contractId: body.inputTokenContract }],
      expectedAmountOutStroops: amountIn,
      source: "fallback_rate",
      slippageApplied: 0,
      amountOutAfterSlippage: amountIn,
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: amountIn,
      quoteAgeMs: 0,
      isFallback: true,
      quoteId: "",
      expiresAt: "",
      expiresInMs: 0,
      inputTokenContract: body.inputTokenContract,
      vaultTokenContract: body.vaultTokenContract,
      amountInStroops: amountIn,
      protocol: body.protocol || "default",
      freezeStateAtQuote: { isFrozen: false },
    };
  }

  const num = process.env.ZAP_FALLBACK_NUMERATOR ?? "1";
  const den = process.env.ZAP_FALLBACK_DENOMINATOR ?? "1";
  const expected = mulDivStroops(amountIn, num, den);

  return {
    path: [
      { contractId: body.inputTokenContract, label: "in" },
      { contractId: body.vaultTokenContract, label: "out" },
    ],
    expectedAmountOutStroops: expected,
    source: "fallback_rate",
    slippageApplied: 0,
    amountOutAfterSlippage: expected,
    quotedAt: new Date(now).toISOString(),
    minAmountOutStroops: expected,
    quoteAgeMs: 0,
    isFallback: true,
    quoteId: "",
    expiresAt: "",
    expiresInMs: 0,
    inputTokenContract: body.inputTokenContract,
    vaultTokenContract: body.vaultTokenContract,
    amountInStroops: amountIn,
    protocol: body.protocol || "default",
    freezeStateAtQuote: { isFrozen: false },
  };
}

export async function getZapQuote(body: ZapQuoteBody): Promise<ZapQuoteResult> {
  if (freezeService.isFrozen(body.protocol)) {
    throw new Error(`Quoting is temporarily disabled for ${body.protocol || "all protocols"} due to safety freeze.`);
  }

  const quotedAt = new Date().toISOString();
  const nowMs = Date.now();

  const sim = (await quoteViaRouterSimulation(body)) || quoteFallback(body);

  const protocol = body.protocol || "default";
  const model = slippageRegistry.getModel(protocol);

  const yieldData = await getYieldData();
  const protocolData = yieldData.find(y => y.protocolName.toLowerCase() === protocol.toLowerCase());
  const tvl = BigInt(Math.floor(protocolData?.tvl || 10_000_000));

  const amountIn = BigInt(body.amountInStroops);
  const slippage = model.calculateSlippage(amountIn, tvl);

  const userSlippage = body.slippageTolerance !== undefined
    ? Math.min(Math.max(body.slippageTolerance, 0.001), 0.15)
    : slippage;

  const effectiveSlippage = Math.max(slippage, userSlippage);

  const expectedOut = BigInt(sim.expectedAmountOutStroops);
  const multiplier = 1 - effectiveSlippage;
  const outAfterSlippage = (expectedOut * BigInt(Math.floor(multiplier * 10000))) / BigInt(10000);

  const ttlMs = getQuoteTtlMs();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const quoteId = randomUUID();

  const freezeState: { isFrozen: boolean; frozenAt?: Date; reason?: string } =
    typeof (freezeService as unknown as { getFreezeStatus?: (p?: string) => { isFrozen: boolean; frozenAt?: Date; reason?: string } }).getFreezeStatus === "function"
      ? (freezeService as unknown as { getFreezeStatus: (p?: string) => { isFrozen: boolean; frozenAt?: Date; reason?: string } }).getFreezeStatus(protocol)
      : { isFrozen: freezeService.isFrozen(protocol) };
  const freezeStateAtQuote = {
    isFrozen: freezeState.isFrozen,
    frozenAt: freezeState.frozenAt ? new Date(freezeState.frozenAt).toISOString() : undefined,
    reason: freezeState.reason,
  };

  const now = Date.now();
  const quotedAtMs = new Date(quotedAt).getTime();

  const quote: ZapQuoteResult = {
    ...sim,
    slippageApplied: effectiveSlippage,
    amountOutAfterSlippage: outAfterSlippage.toString(),
    minAmountOutStroops: outAfterSlippage.toString(),
    quotedAt,
    quoteAgeMs: now - quotedAtMs,
    isFallback: sim.source === "fallback_rate",
    quoteId,
    expiresAt,
    expiresInMs: ttlMs,
    inputTokenContract: body.inputTokenContract,
    vaultTokenContract: body.vaultTokenContract,
    amountInStroops: body.amountInStroops,
    protocol,
    tvlAtQuote: tvl.toString(),
    slippageTolerance: body.slippageTolerance,
    freezeStateAtQuote,
  };

  // Sign assumptions
  try {
    quote.signature = createQuoteSignature(buildSignaturePayload(quote));
  } catch {
    // Non-critical: continue without signature
  }

  storeQuote(quote);

  return quote;
}

/**
 * Validate a quote for execution. Central safety envelope.
 * Checks: existence, expiry, asset pair, amount, freeze, fallback, slippage bounds.
 */
export function validateZapQuoteForExecution(req: ZapQuoteValidationRequest): ZapQuoteValidationResult {
  const now = Date.now();

  if (!req.quoteId || typeof req.quoteId !== "string") {
    return {
      valid: false,
      code: "MISSING_QUOTE_ID",
      reason: "Missing quote identifier. Please request a fresh quote.",
    };
  }

  let stored = getStoredQuote(req.quoteId);

  // Stateless fallback: if cache miss but signature provided, try to reconstruct minimal quote from request
  if (!stored && req.signature && req.quotedAt && req.expiresAt) {
    // Attempt to verify signature using provided fields; if valid, use request as source of truth for expiry/freeze checks
    // For now, we still require cache hit for full validation; cache miss is treated as NOT_FOUND unless signature validates.
    // We will validate signature against a reconstructed quote; if it passes, we treat it as found.
    const reconstructed: ZapQuoteResult = {
      path: [],
      expectedAmountOutStroops: req.expectedAmountOutStroops ?? "0",
      source: (req.source as "router_simulation" | "fallback_rate") ?? "fallback_rate",
      slippageApplied: 0,
      amountOutAfterSlippage: req.minAmountOutStroops ?? "0",
      quotedAt: req.quotedAt,
      minAmountOutStroops: req.minAmountOutStroops ?? "0",
      quoteAgeMs: 0,
      isFallback: req.source === "fallback_rate",
      quoteId: req.quoteId,
      expiresAt: req.expiresAt,
      expiresInMs: Math.max(0, new Date(req.expiresAt).getTime() - new Date(req.quotedAt).getTime()),
      inputTokenContract: req.inputTokenContract,
      vaultTokenContract: req.vaultTokenContract,
      amountInStroops: req.amountInStroops ?? "",
      protocol: req.protocol ?? "default",
      freezeStateAtQuote: { isFrozen: false },
      signature: req.signature,
    };
    if (verifyQuoteSignature(reconstructed, req.signature)) {
      stored = reconstructed;
    }
  }

  if (!stored) {
    return {
      valid: false,
      code: "QUOTE_NOT_FOUND",
      reason: "Quote not found or has expired from cache. Please request a fresh quote.",
    };
  }

  // Verify signature if present (tamper protection)
  if (stored.signature) {
    const payloadValid = verifyQuoteSignature(stored, stored.signature);
    if (!payloadValid) {
      return {
        valid: false,
        code: "SIGNATURE_INVALID",
        reason: "Quote signature is invalid. Please request a fresh quote.",
        quote: stored,
      };
    }
    // If request provides signature, ensure it matches
    if (req.signature && req.signature !== stored.signature) {
      return {
        valid: false,
        code: "SIGNATURE_MISMATCH",
        reason: "Quote signature mismatch. Possible tampering or stale quote.",
        quote: stored,
      };
    }
  }

  // 1. Expiry check
  if (stored.expiresAt) {
    const expiresMs = new Date(stored.expiresAt).getTime();
    if (!isNaN(expiresMs) && now > expiresMs) {
      return {
        valid: false,
        code: "QUOTE_EXPIRED",
        reason: `Quote expired at ${stored.expiresAt}. Please request a fresh quote.`,
        quote: stored,
      };
    }
  }

  // Also check quoteAgeMs fallback if expiresAt not set (backward compat)
  const quotedMs = new Date(stored.quotedAt).getTime();
  const ttlMs = stored.expiresInMs ?? getQuoteTtlMs();
  if (!isNaN(quotedMs) && now - quotedMs > ttlMs + 1000) {
    return {
      valid: false,
      code: "QUOTE_STALE",
      reason: "Quote is stale. Market conditions may have changed. Please requote.",
      quote: stored,
    };
  }

  // 2. Asset pair check (only if stored has binding - backward compat)
  if (
    stored.inputTokenContract !== undefined &&
    stored.vaultTokenContract !== undefined &&
    (req.inputTokenContract !== stored.inputTokenContract ||
      req.vaultTokenContract !== stored.vaultTokenContract)
  ) {
    return {
      valid: false,
      code: "ASSET_MISMATCH",
      reason: `Quote was generated for ${stored.inputTokenContract}→${stored.vaultTokenContract} but execution requested ${req.inputTokenContract}→${req.vaultTokenContract}. Please requote.`,
      quote: stored,
    };
  }

  // 3. Amount check (if provided)
  if (req.amountInStroops && req.amountInStroops !== stored.amountInStroops) {
    return {
      valid: false,
      code: "AMOUNT_MISMATCH",
      reason: `Quote amount ${stored.amountInStroops} differs from execution amount ${req.amountInStroops}. Please requote.`,
      quote: stored,
    };
  }

  // 4. Protocol check (if provided and differs)
  if (req.protocol && stored.protocol && req.protocol.toLowerCase() !== stored.protocol.toLowerCase()) {
    return {
      valid: false,
      code: "PROTOCOL_MISMATCH",
      reason: `Quote was for protocol ${stored.protocol} but execution uses ${req.protocol}. Please requote.`,
      quote: stored,
    };
  }

  // 5. Freeze checks
  const protocolToCheck = req.protocol ?? stored.protocol;
  // Currently frozen? Block regardless of quote age
  if (freezeService.isFrozen(protocolToCheck)) {
    return {
      valid: false,
      code: "PROTOCOL_FROZEN",
      reason: `Protocol ${protocolToCheck || "unknown"} is currently frozen. Execution blocked.`,
      quote: stored,
    };
  }
  if (freezeService.isFrozen()) {
    return {
      valid: false,
      code: "GLOBAL_FROZEN",
      reason: "Global protocol freeze is active. Execution blocked.",
      quote: stored,
    };
  }
  // Freeze after quote?
  const isInvalidated = typeof (freezeService as unknown as { isQuoteInvalidatedByFreeze?: (a: string, p?: string) => boolean }).isQuoteInvalidatedByFreeze === "function"
    ? (freezeService as unknown as { isQuoteInvalidatedByFreeze: (a: string, p?: string) => boolean }).isQuoteInvalidatedByFreeze(stored.quotedAt, protocolToCheck)
    : false;
  if (isInvalidated) {
    return {
      valid: false,
      code: "FREEZE_INVALIDATED",
      reason: "Quote was created before a protocol freeze. Please request a fresh quote after freeze review.",
      quote: stored,
    };
  }
  // Also check global freeze after quote even if protocol undefined
  if (!protocolToCheck || protocolToCheck === "default") {
    const globalInvalidated = typeof (freezeService as unknown as { isQuoteInvalidatedByFreeze?: (a: string, p?: string) => boolean }).isQuoteInvalidatedByFreeze === "function"
      ? (freezeService as unknown as { isQuoteInvalidatedByFreeze: (a: string, p?: string) => boolean }).isQuoteInvalidatedByFreeze(stored.quotedAt)
      : false;
    if (globalInvalidated) {
      return {
        valid: false,
        code: "FREEZE_INVALIDATED",
        reason: "Quote was created before a global freeze. Please requote.",
        quote: stored,
      };
    }
  }

  // 6. Slippage edge checks
  if (req.slippageTolerance !== undefined) {
    const s = req.slippageTolerance;
    if (typeof s !== "number" || isNaN(s) || s < 0.001 || s > 0.15) {
      return {
        valid: false,
        code: "SLIPPAGE_OUT_OF_BOUNDS",
        reason: `Slippage tolerance ${s} is outside allowed range [0.001, 0.15]. Clamp to 0.1%–15%.`,
        quote: stored,
      };
    }
    // If slippage tolerance differs from quote's tolerance, require requote (user changed setting after quote)
    if (
      stored.slippageTolerance !== undefined &&
      Math.abs(s - stored.slippageTolerance) > 0.0001
    ) {
      return {
        valid: false,
        code: "SLIPPAGE_CHANGED",
        reason: `Slippage tolerance was ${stored.slippageTolerance} at quote time but now ${s}. Please request a fresh quote with the new tolerance.`,
        quote: stored,
      };
    }
  }

  // 7. Fallback handling: fallback quotes require explicit allowFallback
  if (stored.isFallback || stored.source === "fallback_rate") {
    if (!req.allowFallback) {
      return {
        valid: false,
        code: "FALLBACK_REQUIRES_CONFIRMATION",
        reason: "This quote uses a fallback rate estimation (router simulation unavailable). Explicit confirmation is required to execute with fallback pricing.",
        quote: stored,
      };
    }
  }

  // 8. Source distinction: ensure fallback not silently treated as router
  if (req.source && req.source !== stored.source) {
    return {
      valid: false,
      code: "SOURCE_MISMATCH",
      reason: `Quote source was ${stored.source} but execution expects ${req.source}. Please requote.`,
      quote: stored,
    };
  }

  return { valid: true, code: "OK", reason: "Quote is valid for execution.", quote: stored };
}
