import { Router, Request, Response } from "express";
import {
  setAuditContext,
  getAuditLogs,
  getAuditStatistics,
  exportAuditLogsToCSV,
  verifyAuditTrailIntegrity,
} from "../middleware/audit";
import { uploadVaultMetadata } from "../services/ipfs/vaultMetadataService";
import { freezeService } from "../services/freezeService";
import { PROTOCOLS } from "../config/protocols";
import { strategyStateTransitionAuditService } from "../services/strategyStateTransitionAuditService";
import { createProposal } from "../governance/governanceProposalService";
import {
  GovernanceActionValidationError,
  type GovernanceAction,
  type GovernanceActionArg,
  type GovernanceMethod,
} from "../governance/actionSchema";

const GOVERNANCE_NETWORK = (process.env.STELLAR_NETWORK ?? "TESTNET").toUpperCase() as
  | "TESTNET"
  | "MAINNET"
  | "FUTURENET";
const GOVERNANCE_EXECUTION_WINDOW_SECONDS = parseInt(
  process.env.GOVERNANCE_EXECUTION_WINDOW_SECONDS ?? "259200", // 3 days
  10,
);

function adminActor(req: Request): string {
  return (
    (req as unknown as { user?: { id?: string; walletAddress?: string } }).user?.walletAddress ??
    (req as unknown as { user?: { id?: string } }).user?.id ??
    "admin"
  );
}

/**
 * Build and persist a governance proposal for a privileged admin mutation
 * instead of applying the change directly. The response reflects proposal
 * creation, not execution - the action only takes effect once the
 * optimistic_governance contract executes it after its challenge window.
 */
async function proposeGovernanceAction(
  req: Request,
  res: Response,
  params: {
    method: GovernanceMethod;
    args: GovernanceActionArg[];
    expectedCurrentState: Record<string, string | number | boolean>;
    rationale: string;
  },
): Promise<void> {
  const targetContractId = process.env.VAULT_CONTRACT_ID;
  if (!targetContractId) {
    res.status(500).json({
      error: "VAULT_CONTRACT_ID is not configured; cannot build a governance proposal",
    });
    return;
  }

  const proposer = adminActor(req);

  const action: GovernanceAction = {
    schemaVersion: 1,
    network: GOVERNANCE_NETWORK,
    targetContractId,
    method: params.method,
    args: params.args,
    expectedCurrentState: params.expectedCurrentState,
    proposer,
    creationLedger: 0,
    executionWindowSeconds: GOVERNANCE_EXECUTION_WINDOW_SECONDS,
    rationale: params.rationale,
  };

  const proposal = await createProposal({ action });

  res.status(202).json({
    success: true,
    status: "PROPOSED",
    message:
      "Action recorded as a governance proposal. It has not been executed on-chain and will not take effect until the proposal is simulated, approved, and executed by the optimistic_governance contract.",
    proposal: {
      id: proposal.id,
      actionHash: proposal.actionHash,
      method: proposal.method,
      status: proposal.status,
      createdAt: proposal.createdAt,
    },
  });
}

const adminRouter = Router();

/**
 * Admin authentication middleware (implement based on your auth system)
 */
function requireAdmin(req: Request, res: Response, next: () => void): void {
  const user = (req as unknown as Record<string, unknown>).user as
    | { role?: string }
    | undefined;

  if (!user || user.role !== "ADMIN") {
    res.status(403).json({ error: "Unauthorized: Admin access required" });
    return;
  }

  next();
}

/**
 * Update vault parameters
 * POST /api/admin/vaults/:vaultId/parameters
 */
adminRouter.post(
  "/vaults/:vaultId/parameters",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;
      const changes = req.body as Record<string, string | number | boolean>;

      setAuditContext(req, {
        action: "PROPOSE_VAULT_PARAMETERS_UPDATE",
        resource: "VAULT",
        resourceId: vaultId,
        changes,
      });

      const args: GovernanceActionArg[] = [
        { name: "vault_id", type: "symbol", value: vaultId },
        ...Object.entries(changes).map(([name, value]) => ({
          name,
          type: (typeof value === "number" ? "i128" : typeof value === "boolean" ? "bool" : "string") as GovernanceActionArg["type"],
          value,
        })),
      ];

      await proposeGovernanceAction(req, res, {
        method: "strategy_config_update",
        args,
        expectedCurrentState: { vaultId },
        rationale: `Update parameters for vault ${vaultId}`,
      });
    } catch (error) {
      if (error instanceof GovernanceActionValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to propose vault parameters update",
      });
    }
  },
);

/**
 * Upload vault metadata to IPFS and return metadata URI for contract updates
 * POST /api/admin/vaults/:vaultId/metadata
 */
adminRouter.post(
  "/vaults/:vaultId/metadata",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;
      const { vaultName, description, iconSvg } = req.body as {
        vaultName?: string;
        description?: string;
        iconSvg?: string;
      };

      if (!vaultName || !description || !iconSvg) {
        res.status(400).json({
          error: "vaultName, description, and iconSvg are required",
        });
        return;
      }

      const uploadResult = await uploadVaultMetadata({
        vaultName,
        description,
        iconSvg,
      });

      setAuditContext(req, {
        action: "UPDATE_VAULT_METADATA_URI",
        resource: "VAULT",
        resourceId: vaultId,
        changes: {
          metadataUri: uploadResult.metadataUri,
          cid: uploadResult.cid,
          uploadMode: uploadResult.uploadMode,
        },
      });

      res.json({
        success: true,
        vaultId,
        cid: uploadResult.cid,
        metadataUri: uploadResult.metadataUri,
        iconUri: uploadResult.iconUri,
        uploadMode: uploadResult.uploadMode,
        metadata: uploadResult.metadata,
        transactionPayload: {
          method: "set_metadata_uri",
          args: {
            vaultId,
            metadataUri: uploadResult.metadataUri,
          },
        },
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to upload vault metadata",
      });
    }
  },
);

/**
 * Pause vault
 * POST /api/admin/vaults/:vaultId/pause
 */
adminRouter.post(
  "/vaults/:vaultId/pause",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;
      const { reason } = req.body as { reason?: string };

      setAuditContext(req, {
        action: "PROPOSE_VAULT_PAUSE",
        resource: "VAULT",
        resourceId: vaultId,
        changes: { reason },
      });

      await proposeGovernanceAction(req, res, {
        method: "vault_pause",
        args: [{ name: "vault_id", type: "symbol", value: vaultId }],
        expectedCurrentState: { vaultId, paused: false },
        rationale: reason || `Pause vault ${vaultId}`,
      });
    } catch (error) {
      if (error instanceof GovernanceActionValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to propose vault pause",
      });
    }
  },
);

/**
 * Resume vault
 * POST /api/admin/vaults/:vaultId/resume
 */
adminRouter.post(
  "/vaults/:vaultId/resume",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { vaultId } = req.params;

      setAuditContext(req, {
        action: "PROPOSE_VAULT_RESUME",
        resource: "VAULT",
        resourceId: vaultId,
      });

      await proposeGovernanceAction(req, res, {
        method: "vault_resume",
        args: [{ name: "vault_id", type: "symbol", value: vaultId }],
        expectedCurrentState: { vaultId, paused: true },
        rationale: `Resume vault ${vaultId}`,
      });
    } catch (error) {
      if (error instanceof GovernanceActionValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Failed to propose vault resume",
      });
    }
  },
);

/**
 * Update fee configuration
 * POST /api/admin/fees/config
 */
adminRouter.post(
  "/fees/config",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const changes = req.body as Record<string, string | number | boolean>;

      setAuditContext(req, {
        action: "PROPOSE_FEE_CONFIG_UPDATE",
        resource: "FEE_CONFIG",
        changes,
      });

      const args: GovernanceActionArg[] = Object.entries(changes).map(([name, value]) => ({
        name,
        type: (typeof value === "number" ? "u32" : typeof value === "boolean" ? "bool" : "string") as GovernanceActionArg["type"],
        value,
      }));

      await proposeGovernanceAction(req, res, {
        method: "fee_config_update",
        args,
        expectedCurrentState: {},
        rationale: "Update protocol fee configuration",
      });
    } catch (error) {
      if (error instanceof GovernanceActionValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to propose fee configuration update",
      });
    }
  },
);

/**
 * Update risk parameters
 * POST /api/admin/risk/parameters
 */
adminRouter.post(
  "/risk/parameters",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const changes = req.body as Record<string, string | number | boolean>;

      setAuditContext(req, {
        action: "PROPOSE_RISK_PARAMETERS_UPDATE",
        resource: "RISK_CONFIG",
        changes,
      });

      const args: GovernanceActionArg[] = Object.entries(changes).map(([name, value]) => ({
        name,
        type: (typeof value === "number" ? "i128" : typeof value === "boolean" ? "bool" : "string") as GovernanceActionArg["type"],
        value,
      }));

      await proposeGovernanceAction(req, res, {
        method: "risk_parameter_update",
        args,
        expectedCurrentState: {},
        rationale: "Update protocol risk parameters",
      });
    } catch (error) {
      if (error instanceof GovernanceActionValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to propose risk parameters update",
      });
    }
  },
);

/**
 * Get audit logs
 * GET /api/admin/audit-logs
 */
adminRouter.get(
  "/audit-logs",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, action, resource, startDate, endDate, limit } = req.query;

      const logs = await getAuditLogs({
        userId: userId as string,
        action: action as string,
        resource: resource as string,
        startDate: startDate as string,
        endDate: endDate as string,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      res.json({
        success: true,
        count: logs.length,
        logs,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve audit logs",
      });
    }
  },
);

/**
 * Get audit statistics
 * GET /api/admin/audit-stats
 */
adminRouter.get(
  "/audit-stats",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getAuditStatistics();

      res.json({
        success: true,
        stats,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to retrieve audit statistics",
      });
    }
  },
);

/**
 * Export audit logs as CSV
 * GET /api/admin/audit-logs/export
 */
adminRouter.get(
  "/audit-logs/export",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, action, resource, startDate, endDate } = req.query;

      const csv = await exportAuditLogsToCSV({
        userId: userId as string,
        action: action as string,
        resource: resource as string,
        startDate: startDate as string,
        endDate: endDate as string,
      });

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="audit-logs.csv"',
      );
      res.send(csv);
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to export audit logs",
      });
    }
  },
);

/**
 * Verify audit trail integrity
 * GET /api/admin/audit-verify
 */
adminRouter.get(
  "/audit-verify",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const logs = await getAuditLogs({ limit: 10000 });
      const verification = verifyAuditTrailIntegrity(logs);

      res.json({
        success: true,
        isValid: verification.isValid,
        totalEntries: logs.length,
        invalidEntries: verification.invalidEntries,
        deletedEntries: verification.deletedEntries,
        reorderedEntries: verification.reorderedEntries,
        message: verification.isValid
          ? "Audit trail integrity verified"
          : `Found ${verification.invalidEntries.length} invalid entries, ${verification.deletedEntries.length} deleted, ${verification.reorderedEntries.length} reordered`,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to verify audit trail",
      });
    }
  },
);

/**
 * Revoke user access
 * POST /api/admin/users/:userId/revoke-access
 */
adminRouter.post(
  "/users/:userId/revoke-access",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const { reason } = req.body;

      setAuditContext(req, {
        action: "REVOKE_USER_ACCESS",
        resource: "USER",
        resourceId: userId,
        changes: { reason },
      });

      // TODO: Implement actual user access revocation logic
      // Example: await revokeUserAccess(userId, reason);

      res.json({
        success: true,
        message: `Access revoked for user ${userId}`,
        userId,
        reason,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to revoke user access",
      });
    }
  },
);

/**
 * Grant user access
 * POST /api/admin/users/:userId/grant-access
 */
adminRouter.post(
  "/users/:userId/grant-access",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;
      const { role, permissions } = req.body;

      setAuditContext(req, {
        action: "GRANT_USER_ACCESS",
        resource: "USER",
        resourceId: userId,
        changes: { role, permissions },
      });

      // TODO: Implement actual user access grant logic
      // Example: await grantUserAccess(userId, role, permissions);

      res.json({
        success: true,
        message: `Access granted for user ${userId}`,
        userId,
        role,
        permissions,
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : "Failed to grant user access",
      });
    }
  },
);

/**
 * Global or protocol-specific recommendation freeze
 * POST /api/admin/recommendations/freeze
 */
adminRouter.post(
  "/recommendations/freeze",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { protocol, reason } = req.body;
      const actor = (req as unknown as { user?: { id: string } }).user?.id || "admin";

      let state;
      if (protocol) {
        state = await freezeService.freezeProtocol(protocol, reason, actor);

        // #371 operator intervention: record lifecycle transition to frozen.
        try {
          strategyStateTransitionAuditService.recordOperatorIntervention(
            String(protocol).toLowerCase(),
            "frozen",
            `freeze_reason=${reason}`,
            actor,
          );
        } catch (err) {
          console.warn("Failed to record frozen transition:", err);
        }
      } else {
        state = await freezeService.freezeGlobal(reason, actor);

        // #371 operator intervention: record frozen transition for all known strategies.
        for (const p of PROTOCOLS) {
          try {
            strategyStateTransitionAuditService.recordOperatorIntervention(
              p.protocolName.toLowerCase(),
              "frozen",
              `freeze_reason=${reason}`,
              actor,
            );
          } catch {
            // Best-effort only; never break the admin endpoint.
          }
        }
      }

      setAuditContext(req, {
        action: "FREEZE_RECOMMENDATIONS",
        resource: protocol ? "PROTOCOL" : "GLOBAL",
        resourceId: protocol || "GLOBAL",
        changes: { reason },
      });

      res.json({ success: true, state });
    } catch {
      res.status(500).json({ error: "Failed to freeze recommendations" });
    }
  },
);

/**
 * Global or protocol-specific recommendation resume
 * POST /api/admin/recommendations/resume
 */
adminRouter.post(
  "/recommendations/resume",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { protocol } = req.body;
      const actor = (req as unknown as { user?: { id: string } }).user?.id || "admin";

      let state;
      if (protocol) {
        state = await freezeService.resumeProtocol(protocol, actor);

        // #371 operator intervention: record lifecycle transition to recovered.
        try {
          strategyStateTransitionAuditService.recordOperatorIntervention(
            String(protocol).toLowerCase(),
            "recovered",
            "resume_reason=operator",
            actor,
          );
        } catch (err) {
          console.warn("Failed to record recovered transition:", err);
        }
      } else {
        state = await freezeService.resumeGlobal(actor);

        for (const p of PROTOCOLS) {
          try {
            strategyStateTransitionAuditService.recordOperatorIntervention(
              p.protocolName.toLowerCase(),
              "recovered",
              "resume_reason=operator",
              actor,
            );
          } catch {
            // Best-effort only; never break the admin endpoint.
          }
        }
      }

      setAuditContext(req, {
        action: "RESUME_RECOMMENDATIONS",
        resource: protocol ? "PROTOCOL" : "GLOBAL",
        resourceId: protocol || "GLOBAL",
      });

      res.json({ success: true, state });
    } catch {
      res.status(500).json({ error: "Failed to resume recommendations" });
    }
  },
);

export default adminRouter;
