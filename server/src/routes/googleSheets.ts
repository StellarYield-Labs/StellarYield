import { Router } from "express";
import { sendError } from "../utils/errorResponse";

const router = Router();

router.post("/token", (_req, res) => {
  sendError(
    res,
    501,
    "GOOGLE_SHEETS_UNAVAILABLE",
    "Google Sheets integration is not enabled on this server.",
  );
});

router.post("/verify", (_req, res) => {
  sendError(
    res,
    501,
    "GOOGLE_SHEETS_UNAVAILABLE",
    "Google Sheets integration is not enabled on this server.",
  );
});

router.post("/append", (_req, res) => {
  sendError(
    res,
    501,
    "GOOGLE_SHEETS_UNAVAILABLE",
    "Google Sheets integration is not enabled on this server.",
  );
});

export default router;
