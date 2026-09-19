import { Request, Response, Router } from "express";
import { validateBacktestRequest } from "../services/backtestService";
import type { BacktestRequest } from "../services/types";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  const vaultContractId = String(req.query.vaultContractId ?? "");
  const startDate = String(req.query.startDate ?? "");
  const endDate = String(req.query.endDate ?? "");

  let depositAmount = 0n;
  try {
    depositAmount = BigInt(String(req.query.depositAmount ?? "0"));
  } catch {
    depositAmount = 0n;
  }

  const request: BacktestRequest = {
    vaultContractId,
    startDate,
    endDate,
    depositAmount,
  };

  const validation = validateBacktestRequest(request);
  if (!validation.isValid) {
    res.status(400).json({
      request,
      isValid: false,
      errors: validation.errors,
    });
    return;
  }

  res.json({
    request,
    isValid: true,
    errors: [],
  });
});

export default router;
