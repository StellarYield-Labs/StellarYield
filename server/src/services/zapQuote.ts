import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
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
  // ── Safety envelope (added for execution binding) ──
  // Optional for backward compat with older mocks/tests, but always present on fresh quotes from getZapQuote.
  quoteId?: string;
  expiresAt?: string;
  ttlMs?: number;
  protocol?: string;
  inputTokenContract?: string;
  vaultTokenContract?: string;
  amountInStroops?: string;
  quoteSignature?: string;
  freezeCheckedAt?: string;
}

export interface ZapQuoteValidationRequest {
  quote: ZapQuoteResult;
  inputTokenContract?: string;
  vaultTokenContract?: string;
  amountInStroops?: string;
  protocol?: string;
  allowFallback?: boolean;
}

export interface ZapQuoteValidationResult {
  valid: boolean;
  code?: string;
  reason?: string;
  requiresRequote?: boolean;
  isFallback?: boolean;
  isExpired?: boolean;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

export const ZAP_QUOTE_DEFAULT_TTL_MS = 30_000;
export const ZAP_QUOTE_MIN_TTL_MS = 5_000;
export const ZAP_QUOTE_MAX_TTL_MS = 300_000;

export function getZapQuoteTtlMs(): number {
  const raw = process.env.ZAP_QUOTE_TTL_MS;
  if (!raw) return ZAP_QUOTE_DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return ZAP_QUOTE_DEFAULT_TTL_MS;
  return Math.min(Math.max(n, ZAP_QUOTE_MIN_TTL_MS), ZAP_QUOTE_MAX_TTL_MS);
}

export function generateQuoteId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function getQuoteHmacSecret(): string {
  return process.env.ZAP_QUOTE_HMAC_SECRET || process.env.AUDIT_SIGNING_KEY || "dev-zap-quote-secret-not-for-production";
}

export function computeQuoteSignature(payload: Omit<ZapQuoteResult, "quoteSignature">): string {
  const hmac = crypto.createHmac("sha256", getQuoteHmacSecret());
  const canonical = JSON.stringify({
    quoteId: payload.quoteId,
    inputTokenContract: payload.inputTokenContract,
    vaultTokenContract: payload.vaultTokenContract,
    amountInStroops: payload.amountInStroops,
    expectedAmountOutStroops: payload.expectedAmountOutStroops,
    minAmountOutStroops: payload.minAmountOutStroops,
    amountOutAfterSlippage: payload.amountOutAfterSlippage,
    slippageApplied: payload.slippageApplied,
    path: payload.path,
    source: payload.source,
    protocol: payload.protocol,
    quotedAt: payload.quotedAt,
    expiresAt: payload.expiresAt,
    ttlMs: payload.ttlMs,
    isFallback: payload.isFallback,
    freezeCheckedAt: payload.freezeCheckedAt,
  });
  hmac.update(canonical);
  return hmac.digest("hex");
}

export function verifyQuoteSignature(quote: ZapQuoteResult): boolean {
  if (!quote.quoteSignature) return false;
  const { quoteSignature, ...rest } = quote;
  const expected = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(quoteSignature, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return expected === quoteSignature;
  }
}

export function isQuoteExpired(quote: ZapQuoteResult, nowMs = Date.now()): boolean {
  if (!quote.expiresAt) {
    const quotedAtMs = new Date(quote.quotedAt).getTime();
    if (Number.isNaN(quotedAtMs)) return true;
    const ttl = quote.ttlMs ?? getZapQuoteTtlMs();
    return nowMs > quotedAtMs + ttl;
  }
  const expiresAtMs = new Date(quote.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) return true;
  return nowMs > expiresAtMs;
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

// In-memory quote store for persistence validation (TTL-aware)
const quoteStore = new NodeCache({ stdTTL: 0, checkperiod: 60, useClones: false });

export function storeQuote(quote: ZapQuoteResult): void {
  if (!quote.quoteId) return;
  const ttlMs = quote.ttlMs ?? getZapQuoteTtlMs();
  const ttlSec = Math.ceil(ttlMs / 1000) + 5;
  quoteStore.set(quote.quoteId, quote, ttlSec);
}

export function getStoredQuote(quoteId: string): ZapQuoteResult | undefined {
  return quoteStore.get<ZapQuoteResult>(quoteId);
}

export function clearQuoteStore(): void {
  quoteStore.flushAll();
}

export function getQuoteStoreSize(): number {
  return quoteStore.keys().length;
}

type ZapQuoteCore = Omit<ZapQuoteResult, "quoteId" | "expiresAt" | "ttlMs" | "protocol" | "inputTokenContract" | "vaultTokenContract" | "amountInStroops" | "quoteSignature" | "freezeCheckedAt">;

export async function quoteViaRouterSimulation(
  body: ZapQuoteBody,
): Promise<ZapQuoteCore | null> {
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
    };
  } catch {
    return null;
  }
}

export function quoteFallback(body: ZapQuoteBody): ZapQuoteCore {
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
  };
}

export async function getZapQuote(body: ZapQuoteBody): Promise<ZapQuoteResult> {
  if (freezeService.isFrozen(body.protocol)) {
    throw new Error(`Quoting is temporarily disabled for ${body.protocol || "all protocols"} due to safety freeze.`);
  }

  const quotedAt = new Date().toISOString();
  const quotedAtMs = new Date(quotedAt).getTime();
  const ttlMs = getZapQuoteTtlMs();
  const expiresAt = new Date(quotedAtMs + ttlMs).toISOString();
  const quoteId = generateQuoteId();
  const protocol = body.protocol || "default";

  const sim = (await quoteViaRouterSimulation(body)) || quoteFallback(body);

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

  const now = Date.now();
  const freezeCheckedAt = new Date(now).toISOString();

  const envelopeBase: Omit<ZapQuoteResult, "quoteSignature"> = {
    ...sim,
    slippageApplied: effectiveSlippage,
    amountOutAfterSlippage: outAfterSlippage.toString(),
    minAmountOutStroops: outAfterSlippage.toString(),
    quotedAt,
    quoteAgeMs: now - quotedAtMs,
    isFallback: sim.source === "fallback_rate",
    quoteId,
    expiresAt,
    ttlMs,
    protocol,
    inputTokenContract: body.inputTokenContract,
    vaultTokenContract: body.vaultTokenContract,
    amountInStroops: body.amountInStroops,
    freezeCheckedAt,
  };

  const quoteSignature = computeQuoteSignature(envelopeBase);

  const fullQuote: ZapQuoteResult = {
    ...envelopeBase,
    quoteSignature,
  };

  storeQuote(fullQuote);

  return fullQuote;
}

export function validateZapQuoteForExecution(
  request: ZapQuoteValidationRequest,
  nowMs = Date.now(),
): ZapQuoteValidationResult {
  const quote = request.quote;

  if (!quote || typeof quote !== "object") {
    return {
      valid: false,
      code: "QUOTE_MISSING",
      reason: "Quote is missing or malformed. Please request a fresh quote.",
      requiresRequote: true,
    };
  }

  // Signature is required — an omitted or user-controlled empty signature must not bypass verification (CodeQL: user-controlled bypass)
  if (!quote.quoteSignature) {
    return {
      valid: false,
      code: "SIGNATURE_INVALID",
      reason: "Missing quote signature — quote is not from a trusted envelope. Please request a fresh quote.",
      requiresRequote: true,
    };
  }
  if (!verifyQuoteSignature(quote)) {
    return {
      valid: false,
      code: "SIGNATURE_INVALID",
      reason: "Quote signature is invalid — quote may have been tampered with. Please requote.",
      requiresRequote: true,
    };
  }

  // Expiry / TTL check
  if (isQuoteExpired(quote, nowMs)) {
    return {
      valid: false,
      code: "QUOTE_EXPIRED",
      reason: `Quote expired at ${quote.expiresAt ?? "unknown"} (TTL ${quote.ttlMs ?? getZapQuoteTtlMs()}ms). Please request a fresh quote.`,
      requiresRequote: true,
      isExpired: true,
    };
  }

  // Also check quoteAgeMs if expiresAt missing but stale
  if (quote.quoteAgeMs !== undefined && quote.ttlMs !== undefined && quote.quoteAgeMs > quote.ttlMs + 1000) {
    return {
      valid: false,
      code: "QUOTE_STALE",
      reason: "Quote is stale based on age. Please requote.",
      requiresRequote: true,
      isExpired: true,
    };
  }

  // Asset pair check — must match envelope's recorded pair or explicit request fields
  const expectedInput = quote.inputTokenContract || (quote as unknown as { inputTokenContract?: string }).inputTokenContract;
  const expectedVault = quote.vaultTokenContract || (quote as unknown as { vaultTokenContract?: string }).vaultTokenContract;
  const reqInput = request.inputTokenContract || expectedInput;
  const reqVault = request.vaultTokenContract || expectedVault;
  const reqAmount = request.amountInStroops || quote.amountInStroops;

  // If quote has envelope fields, enforce strict match
  if (quote.inputTokenContract && request.inputTokenContract && quote.inputTokenContract !== request.inputTokenContract) {
    return {
      valid: false,
      code: "ASSET_MISMATCH",
      reason: `Quote input asset mismatch: quote is for ${quote.inputTokenContract} but request is for ${request.inputTokenContract}. Please requote for the correct pair.`,
      requiresRequote: true,
    };
  }
  if (quote.vaultTokenContract && request.vaultTokenContract && quote.vaultTokenContract !== request.vaultTokenContract) {
    return {
      valid: false,
      code: "ASSET_MISMATCH",
      reason: `Quote vault asset mismatch: quote is for ${quote.vaultTokenContract} but request is for ${request.vaultTokenContract}. Please requote.`,
      requiresRequote: true,
    };
  }
  // If request doesn't provide pair explicitly, we still validate quote's internal consistency if path changed? Check path still corresponds to recorded pair
  if (quote.path && quote.path.length > 0) {
    const firstHop = quote.path[0]?.contractId;
    const lastHop = quote.path[quote.path.length - 1]?.contractId;
    if (quote.inputTokenContract && firstHop && firstHop !== quote.inputTokenContract) {
      return {
        valid: false,
        code: "ROUTE_CHANGED",
        reason: "Quote route does not match quoted input asset. Requote required.",
        requiresRequote: true,
      };
    }
    if (quote.vaultTokenContract && lastHop && lastHop !== quote.vaultTokenContract) {
      return {
        valid: false,
        code: "ROUTE_CHANGED",
        reason: "Quote route does not match quoted vault asset. Requote required.",
        requiresRequote: true,
      };
    }
  }

  if (quote.amountInStroops && reqAmount && quote.amountInStroops !== reqAmount) {
    return {
      valid: false,
      code: "AMOUNT_MISMATCH",
      reason: `Quote amount mismatch: quoted ${quote.amountInStroops} but execution requests ${reqAmount}. Please requote for the exact amount.`,
      requiresRequote: true,
    };
  }

  // Protocol freeze after quote check
  const protocolToCheck = request.protocol || quote.protocol || "default";
  if (freezeService.wasFrozenAfter(quote.quotedAt, protocolToCheck)) {
    return {
      valid: false,
      code: "FROZEN_AFTER_QUOTE",
      reason: `Protocol ${protocolToCheck} was frozen after this quote was issued at ${quote.quotedAt}. This quote is no longer executable. Please requote.`,
      requiresRequote: true,
    };
  }
  // Also check global freeze after quote even if protocol not specified
  if (protocolToCheck !== "default" && freezeService.wasFrozenAfter(quote.quotedAt, undefined)) {
    return {
      valid: false,
      code: "FROZEN_AFTER_QUOTE",
      reason: `A global freeze occurred after this quote was issued at ${quote.quotedAt}. Requote required.`,
      requiresRequote: true,
    };
  }
  // Current frozen check (if still frozen)
  if (freezeService.isFrozen(protocolToCheck)) {
    return {
      valid: false,
      code: "PROTOCOL_FROZEN",
      reason: `Protocol ${protocolToCheck} is currently frozen. Execution is blocked until unfrozen.`,
      requiresRequote: true,
    };
  }

  // Fallback distinction — fallback quotes cannot be silently treated as router-simulated
  const isFallback = quote.isFallback || quote.source === "fallback_rate";
  if (isFallback && !request.allowFallback) {
    return {
      valid: false,
      code: "FALLBACK_REQUIRES_ACK",
      reason: "This is a fallback quote (router simulation unavailable). Execution with fallback pricing requires explicit acknowledgement. Please acknowledge fallback risk or wait for a router-simulated quote via requote.",
      requiresRequote: false,
      isFallback: true,
    };
  }

  // Slippage edge validation — ensure quote slippage is within sane bounds and not tampered
  if (typeof quote.slippageApplied === "number") {
    if (!Number.isFinite(quote.slippageApplied) || quote.slippageApplied < 0 || quote.slippageApplied >= 1) {
      return {
        valid: false,
        code: "SLIPPAGE_INVALID",
        reason: `Quote slippage ${quote.slippageApplied} is outside valid range [0,1). Requote required.`,
        requiresRequote: true,
      };
    }
    // Enforce that applied slippage respects minimum protocol slippage? Already max-clamped at 15% =0.15
    if (quote.slippageApplied > 0.15 + 1e-9) {
      return {
        valid: false,
        code: "SLIPPAGE_INVALID",
        reason: `Quote slippage ${quote.slippageApplied} exceeds maximum allowed 15%. Requote with lower slippage.`,
        requiresRequote: true,
      };
    }
  }

  // If quote was retrieved from store but differs from provided expected output (route changed), we already checked asset pair
  // Additional check: if stored quote exists and provided quote differs in expected output, it indicates tampering or stale
  if (quote.quoteId) {
    const stored = getStoredQuote(quote.quoteId);
    if (stored) {
      if (stored.expectedAmountOutStroops !== quote.expectedAmountOutStroops || stored.minAmountOutStroops !== quote.minAmountOutStroops) {
        return {
          valid: false,
          code: "ROUTE_CHANGED",
          reason: "Quote output amounts do not match the server's stored record for this quoteId. Route may have changed — requote required.",
          requiresRequote: true,
        };
      }
      if (stored.inputTokenContract !== quote.inputTokenContract || stored.vaultTokenContract !== quote.vaultTokenContract) {
        return {
          valid: false,
          code: "ASSET_MISMATCH",
          reason: "Stored quote asset pair differs from provided quote — possible tampering. Requote required.",
          requiresRequote: true,
        };
      }
    }
  }

  return {
    valid: true,
    isFallback,
    isExpired: false,
  };
}
