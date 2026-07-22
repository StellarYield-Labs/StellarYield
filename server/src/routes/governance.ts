import { Router, Request, Response } from "express";
import {
  forecastGovernanceProposal,
  type GovernanceForecastInput,
  type ProposalType,
} from "../services/governanceForecastService";
import {
  createProposal,
  getProposal,
  listProposals,
  simulateProposal,
  cancelProposal,
  isSimulationStale,
  ProposalNotFoundError,
} from "../governance/governanceProposalService";
import {
  validateGovernanceAction,
  GovernanceActionValidationError,
  type GovernanceAction,
} from "../governance/actionSchema";

const router = Router();

function actorFromRequest(req: Request): string {
  return (
    (req as unknown as { user?: { id?: string; walletAddress?: string } }).user?.walletAddress ??
    (req as unknown as { user?: { id?: string } }).user?.id ??
    "unknown"
  );
}

/**
 * GET /api/governance/proposals
 * List governance proposals, most recent first. This is the canonical
 * source of proposal state - the client refetches from here after refresh
 * or on another device rather than relying on local-only state.
 */
router.get("/proposals", async (req: Request, res: Response) => {
  try {
    const { status, proposer } = req.query;
    const proposals = await listProposals({
      status: typeof status === "string" ? status : undefined,
      proposer: typeof proposer === "string" ? proposer : undefined,
    });
    res.json({ proposals });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to list proposals",
    });
  }
});

/**
 * GET /api/governance/proposals/:id
 * Fetch a single proposal with its latest simulation evidence and full
 * on-chain event history, plus whether its simulation is stale.
 */
router.get("/proposals/:id", async (req: Request, res: Response) => {
  try {
    const proposal = await getProposal(req.params.id);
    const stale = await isSimulationStale(req.params.id);
    res.json({ proposal, simulationStale: stale });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch proposal",
    });
  }
});

/**
 * POST /api/governance/proposals
 * Create a governance proposal from a canonical GovernanceAction payload.
 * This is the same path admin routes call internally - exposed directly so
 * clients can build and preview a proposal before it is bound to a specific
 * admin route.
 */
router.post("/proposals", async (req: Request, res: Response) => {
  try {
    const action = req.body.action as GovernanceAction;
    validateGovernanceAction(action);

    const proposal = await createProposal({
      action,
      strategyVersionId: req.body.strategyVersionId,
      riskForecastId: req.body.riskForecastId,
      auditLogId: req.body.auditLogId,
    });

    res.status(202).json({ proposal });
  } catch (error) {
    if (error instanceof GovernanceActionValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create proposal",
    });
  }
});

/**
 * POST /api/governance/proposals/:id/simulate
 * Run (or re-run) a Soroban simulation for the proposal's target
 * invocation and persist the resulting evidence. Required before a stale
 * or missing simulation blocks approval.
 */
router.post("/proposals/:id/simulate", async (req: Request, res: Response) => {
  try {
    const evidence = await simulateProposal(req.params.id);
    res.json({ evidence });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to simulate proposal",
    });
  }
});

/**
 * POST /api/governance/proposals/:id/cancel
 * Cancel a proposal that has not yet executed or been confirmed on-chain.
 */
router.post("/proposals/:id/cancel", async (req: Request, res: Response) => {
  try {
    const { reason } = req.body as { reason?: string };
    const proposal = await cancelProposal(
      req.params.id,
      actorFromRequest(req),
      reason || "No reason provided",
    );
    res.json({ proposal });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof GovernanceActionValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to cancel proposal",
    });
  }
});

const VALID_PROPOSAL_TYPES: ProposalType[] = [
  "fee_change",
  "allocation_limit",
  "strategy_param",
  "reward_change",
];

/**
 * POST /api/governance/forecast
 * Returns an estimated impact forecast for a governance proposal.
 * Read-only — does not execute any on-chain operation.
 */
router.post("/forecast", (req: Request, res: Response) => {
  const { proposalType, parameters, baseline } = req.body as Partial<GovernanceForecastInput>;

  if (!proposalType || !VALID_PROPOSAL_TYPES.includes(proposalType)) {
    res.status(400).json({
      error: `proposalType must be one of: ${VALID_PROPOSAL_TYPES.join(", ")}`,
    });
    return;
  }

  if (!parameters || typeof parameters !== "object") {
    res.status(400).json({ error: "parameters must be an object" });
    return;
  }

  if (
    !baseline ||
    typeof baseline.yieldPct !== "number" ||
    typeof baseline.exposurePct !== "number" ||
    typeof baseline.feeRatePct !== "number" ||
    typeof baseline.tvlUsd !== "number"
  ) {
    res.status(400).json({
      error: "baseline must include yieldPct, exposurePct, feeRatePct, and tvlUsd as numbers",
    });
    return;
  }

  const result = forecastGovernanceProposal({ proposalType, parameters, baseline });
  res.json(result);
});

export default router;
