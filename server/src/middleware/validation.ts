import { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/errorResponse";

export function validateWalletAddress(req: Request, res: Response, next: NextFunction): void {
  const address = req.params.address || req.params.walletAddress;
  if (!address || typeof address !== "string" || address.length < 10 || !/^[GC][A-Z2-7]{55}$/.test(address)) {
    sendError(res, 400, "INVALID_ADDRESS", "Invalid Stellar wallet address.");
    return;
  }
  next();
}

export function validatePagination(req: Request, res: Response, next: NextFunction): void {
  const page = parseInt(req.query.page as string);
  const limit = parseInt(req.query.limit as string);
  if ((page && (isNaN(page) || page < 1)) || (limit && (isNaN(limit) || limit < 1 || limit > 100))) {
    sendError(res, 400, "INVALID_PAGINATION", "Invalid page or limit parameters.");
    return;
  }
  next();
}

export function validateZapQuote(req: Request, res: Response, next: NextFunction): void {
  const { inputTokenContract, vaultTokenContract, amountInStroops, slippageTolerance } = req.body;
  if (!inputTokenContract || !vaultTokenContract || amountInStroops === undefined) {
    sendError(res, 400, "MISSING_FIELDS", "inputTokenContract, vaultTokenContract, and amountInStroops are required.");
    return;
  }
  if (typeof amountInStroops !== "string" || !/^-?\d+$/.test(amountInStroops)) {
    sendError(res, 400, "INVALID_AMOUNT", "amountInStroops must be an integer string.");
    return;
  }
  if (BigInt(amountInStroops) <= BigInt(0)) {
    sendError(res, 400, "INVALID_AMOUNT", "amountInStroops must be a positive integer string.");
    return;
  }
  if (slippageTolerance !== undefined) {
    const v = Number(slippageTolerance);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      sendError(res, 400, "INVALID_SLIPPAGE", "slippageTolerance must be a number in [0, 1] (e.g. 0.005 for 0.5%).");
      return;
    }
  }
  next();
}

export function validateZapVerify(req: Request, res: Response, next: NextFunction): void {
  const { quote } = req.body as { quote?: unknown };
  if (!quote || typeof quote !== "object") {
    sendError(res, 400, "MISSING_QUOTE", "quote object is required for verification.");
    return;
  }
  const q = quote as Record<string, unknown>;
  if (!q.quoteId || typeof q.quoteId !== "string") {
    // For backward compat, allow quotes without quoteId but require quotedAt and expectedAmount
    if (!q.quotedAt || typeof q.quotedAt !== "string") {
      sendError(res, 400, "INVALID_QUOTE", "quote must contain quoteId and quotedAt, or at minimum quotedAt for legacy quotes.");
      return;
    }
  }
  if (!q.expectedAmountOutStroops || typeof q.expectedAmountOutStroops !== "string") {
    sendError(res, 400, "INVALID_QUOTE", "quote must contain expectedAmountOutStroops.");
    return;
  }
  next();
}