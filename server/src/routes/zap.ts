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
      protocol: b.protocol !== undefined ? String(b.protocol) : undefined,
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
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
      ttlMs: quote.ttlMs,
      protocol: quote.protocol,
      inputTokenContract: quote.inputTokenContract,
      vaultTokenContract: quote.vaultTokenContract,
      amountInStroops: quote.amountInStroops,
      quoteSignature: quote.quoteSignature,
      freezeCheckedAt: quote.freezeCheckedAt,
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
    const { quote, inputTokenContract, vaultTokenContract, amountInStroops, protocol, allowFallback } = req.body as {
      quote: import("../services/zapQuote").ZapQuoteResult;
      inputTokenContract?: string;
      vaultTokenContract?: string;
      amountInStroops?: string;
      protocol?: string;
      allowFallback?: boolean;
    };

    const result = validateZapQuoteForExecution({
      quote,
      inputTokenContract: inputTokenContract ? String(inputTokenContract) : undefined,
      vaultTokenContract: vaultTokenContract ? String(vaultTokenContract) : undefined,
      amountInStroops: amountInStroops ? String(amountInStroops) : undefined,
      protocol: protocol ? String(protocol) : undefined,
      allowFallback: Boolean(allowFallback),
    });

    if (result.valid) {
      res.json({
        valid: true,
        isFallback: result.isFallback,
        quoteId: quote.quoteId,
        expiresAt: quote.expiresAt,
        message: result.isFallback
          ? "Quote is valid but is a fallback quote — execution requires explicit acknowledgement."
          : "Quote is valid and executable.",
      });
    } else {
      res.status(422).json({
        valid: false,
        code: result.code,
        reason: result.reason,
        requiresRequote: result.requiresRequote,
        isFallback: result.isFallback,
        isExpired: result.isExpired,
      });
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
