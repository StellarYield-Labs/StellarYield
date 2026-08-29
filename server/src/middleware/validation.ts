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
  const { inputTokenContract, vaultTokenContract, amountInStroops } = req.body;
  if (!inputTokenContract || !vaultTokenContract || amountInStroops === undefined) {
    sendError(res, 400, "MISSING_FIELDS", "inputTokenContract, vaultTokenContract, and amountInStroops are required.");
    return;
  }
  if (typeof amountInStroops !== "string" || !/^-?\d+$/.test(amountInStroops)) {
    sendError(res, 400, "INVALID_AMOUNT", "amountInStroops must be an integer string.");
    return;
  }
  // slippageTolerance is clamped in getZapQuote for backward compatibility; invalid values are handled at verify time
  next();
}

export function validateZapVerify(req: Request, res: Response, next: NextFunction): void {
  const { quoteId, inputTokenContract, vaultTokenContract } = req.body;
  if (!quoteId || !inputTokenContract || !vaultTokenContract) {
    sendError(res, 400, "MISSING_FIELDS", "quoteId, inputTokenContract, and vaultTokenContract are required for verification.");
    return;
  }
  if (typeof quoteId !== "string" || quoteId.trim().length === 0) {
    sendError(res, 400, "INVALID_QUOTE_ID", "quoteId must be a non-empty string.");
    return;
  }
  if (req.body.slippageTolerance !== undefined) {
    const s = Number(req.body.slippageTolerance);
    if (!Number.isFinite(s) || s < 0.001 || s > 0.15) {
      // Allow out-of-bounds to be handled as validation error but block obviously invalid
      // For strict API, reject here
      sendError(res, 400, "INVALID_SLIPPAGE", "slippageTolerance must be a number between 0.001 and 0.15.");
      return;
    }
  }
  next();
}