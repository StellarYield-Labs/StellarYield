import { Router, Request, Response } from "express";
import { getZapSupportedAssetsPayload } from "../config/zapAssetsConfig";
import { getZapQuote, validateZapQuoteForExecution, type ZapQuoteBody } from "../services/zapQuote";
import { sendError } from "../utils/errorResponse";
import { validateZapQuote, validateZapVerify } from "../middleware/validation";

const router = Router();

router.get("/supported-assets", (_req: Request, res: Response) => {
  try {
    res.json(getZapSupportedAssetsPayload());
  } catch (error) {
    sendError(
      res,
      503,
      "CONFIG_UNAVAILABLE",
      "Supported assets configuration is unavailable.",
      error instanceof Error ? error.message : undefined
    );
  }
});

router.post("/quote", validateZapQuote, async (req: Request, res: Response) => {
  try {
    const b = req.body as ZapQuoteBody;

    const body: ZapQuoteBody = {
      inputTokenContract: String(b.inputTokenContract),
      vaultTokenContract: String(b.vaultTokenContract),
      amountInStroops: String(b.amountInStroops),
      inputDecimals: Number(b.inputDecimals ?? 7),
      vaultDecimals: Number(b.vaultDecimals ?? 7),
      slippageTolerance: b.slippageTolerance !== undefined ? Number(b.slippageTolerance) : undefined,
      protocol: b.protocol ? String(b.protocol) : undefined,
    };

    const quote = await getZapQuote(body);
    res.json({
      path: quote.path,
      expectedAmountOutStroops: quote.expectedAmountOutStroops,
      source: quote.source,
      slippageApplied: quote.slippageApplied,
      amountOutAfterSlippage: quote.amountOutAfterSlippage,
      quotedAt: quote.quotedAt,
      minAmountOutStroops: quote.minAmountOutStroops,
      quoteAgeMs: quote.quoteAgeMs,
      isFallback: quote.isFallback,
      // Safety envelope
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
      expiresInMs: quote.expiresInMs,
      inputTokenContract: quote.inputTokenContract,
      vaultTokenContract: quote.vaultTokenContract,
      amountInStroops: quote.amountInStroops,
      protocol: quote.protocol,
      tvlAtQuote: quote.tvlAtQuote,
      slippageTolerance: quote.slippageTolerance,
      freezeStateAtQuote: quote.freezeStateAtQuote,
      signature: quote.signature,
    });
  } catch (e) {
    sendError(
      res,
      500,
      "QUOTE_FAILED",
      "Quote failed",
      e instanceof Error ? e.message : undefined
    );
  }
});

router.post("/verify", validateZapVerify, async (req: Request, res: Response) => {
  try {
    const b = req.body as {
      quoteId: string;
      inputTokenContract: string;
      vaultTokenContract: string;
      amountInStroops?: string;
      slippageTolerance?: number;
      allowFallback?: boolean;
      protocol?: string;
      quotedAt?: string;
      expiresAt?: string;
      expectedAmountOutStroops?: string;
      minAmountOutStroops?: string;
      source?: string;
      signature?: string;
    };

    const result = validateZapQuoteForExecution({
      quoteId: String(b.quoteId),
      inputTokenContract: String(b.inputTokenContract),
      vaultTokenContract: String(b.vaultTokenContract),
      amountInStroops: b.amountInStroops ? String(b.amountInStroops) : undefined,
      slippageTolerance: b.slippageTolerance !== undefined ? Number(b.slippageTolerance) : undefined,
      allowFallback: Boolean(b.allowFallback),
      protocol: b.protocol ? String(b.protocol) : undefined,
      quotedAt: b.quotedAt ? String(b.quotedAt) : undefined,
      expiresAt: b.expiresAt ? String(b.expiresAt) : undefined,
      expectedAmountOutStroops: b.expectedAmountOutStroops ? String(b.expectedAmountOutStroops) : undefined,
      minAmountOutStroops: b.minAmountOutStroops ? String(b.minAmountOutStroops) : undefined,
      source: b.source ? String(b.source) : undefined,
      signature: b.signature ? String(b.signature) : undefined,
    });

    if (result.valid) {
      res.json({ valid: true, code: result.code, reason: result.reason, quote: result.quote });
    } else {
      // Map error codes to appropriate status
      const statusMap: Record<string, number> = {
        QUOTE_EXPIRED: 409,
        QUOTE_STALE: 409,
        QUOTE_NOT_FOUND: 404,
        MISSING_QUOTE_ID: 400,
        ASSET_MISMATCH: 409,
        AMOUNT_MISMATCH: 409,
        PROTOCOL_MISMATCH: 409,
        PROTOCOL_FROZEN: 423,
        GLOBAL_FROZEN: 423,
        FREEZE_INVALIDATED: 409,
        SLIPPAGE_OUT_OF_BOUNDS: 400,
        SLIPPAGE_CHANGED: 409,
        SLIPPAGE_TOO_LOW: 400,
        FALLBACK_REQUIRES_CONFIRMATION: 409,
        SOURCE_MISMATCH: 409,
        SIGNATURE_INVALID: 401,
        SIGNATURE_MISMATCH: 401,
      };
      const status = statusMap[result.code] ?? 400;
      res.status(status).json({ valid: false, code: result.code, reason: result.reason, quote: result.quote });
    }
  } catch (e) {
    sendError(
      res,
      500,
      "VERIFY_FAILED",
      "Quote verification failed",
      e instanceof Error ? e.message : undefined
    );
  }
});

export default router;
