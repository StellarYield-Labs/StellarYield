import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import {
  VAULT_ROLES,
  ROLE_CAPABILITIES,
  VaultRole,
  normalizeRole,
  normalizeVaultId,
  normalizeWalletAddress,
  vaultAccessService,
  VaultAccessError,
  buildRoleResponse,
  getCapabilitiesForRole,
  canRolePerform,
  resolveRequiredCapability,
} from "../services/vaultAccessService";
import { resolveWalletAddress } from "../middleware/vaultAuth";
import { setAuditContext } from "../middleware/audit";

const router = Router();

/**
 * GET /api/vaults/:vaultId/access/role
 * Resolve wallet role and capabilities for a vault.
 * Query: walletAddress OR x-wallet-address header
 */
router.get("/:vaultId/access/role", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const wallet = resolveWalletAddress(req);
  if (!wallet) {
    sendError(res, 400, "WALLET_REQUIRED", "walletAddress query param or x-wallet-address header required");
    return;
  }
  const data = buildRoleResponse(vaultId, wallet);
  res.json(data);
});

/**
 * GET /api/vaults/:vaultId/access/capabilities
 * Return the static role->capabilities matrix (for client UI).
 */
router.get("/:vaultId/access/capabilities", (_req: Request, res: Response): void => {
  res.json({
    roles: VAULT_ROLES,
    matrix: ROLE_CAPABILITIES,
    actionRequirements: {
      view: "view",
      propose: "propose",
      approve: "approve",
      execute: "execute",
    },
    description: {
      viewer: "view only — can inspect vault state and proposals",
      reviewer: "view + approve — can review and approve/reject proposals",
      manager: "view + propose + execute — can create and execute proposals",
      owner: "all capabilities including member management",
    },
  });
});

/**
 * GET /api/vaults/:vaultId/access/members
 * List vault members.
 * Requires view capability if vault has members; otherwise public for bootstrap.
 */
router.get("/:vaultId/access/members", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const members = vaultAccessService.listMembers(vaultId);
  // If vault has members, require view capability
  if (members.length > 0) {
    const wallet = resolveWalletAddress(req);
    if (!wallet) {
      sendError(res, 401, "WALLET_REQUIRED", "Wallet required to list members of a private vault");
      return;
    }
    const role = vaultAccessService.getRole(vaultId, wallet);
    if (!role || !canRolePerform(role, "view")) {
      sendError(res, 403, "VAULT_FORBIDDEN", `Wallet ${wallet} cannot view members`);
      return;
    }
  }
  res.json({ vaultId, members, count: members.length });
});

/**
 * POST /api/vaults/:vaultId/access/role
 * Set a member's role (owner only).
 * Body: { targetWalletAddress, role }
 * Actor: x-wallet-address header or body.actorWalletAddress
 */
router.post("/:vaultId/access/role", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const { targetWalletAddress, role, actorWalletAddress } = req.body as {
    targetWalletAddress?: string;
    role?: string;
    actorWalletAddress?: string;
  };
  const headerActor = req.headers["x-wallet-address"] as string | undefined;
  const actor = normalizeWalletAddress(actorWalletAddress || headerActor || resolveWalletAddress(req) || "");

  if (!targetWalletAddress || typeof targetWalletAddress !== "string") {
    sendError(res, 400, "MISSING_TARGET", "targetWalletAddress is required");
    return;
  }
  if (!role || typeof role !== "string") {
    sendError(res, 400, "MISSING_ROLE", "role is required (owner, manager, reviewer, viewer)");
    return;
  }
  const normalized = normalizeRole(role);
  if (!normalized) {
    sendError(res, 400, "INVALID_ROLE", `Invalid role ${role}. Allowed: ${VAULT_ROLES.join(", ")}`);
    return;
  }
  if (!actor) {
    sendError(res, 401, "WALLET_REQUIRED", "Actor wallet required via x-wallet-address header or actorWalletAddress body");
    return;
  }

  try {
    const result = vaultAccessService.setRole({
      vaultId,
      targetWalletAddress: normalizeWalletAddress(targetWalletAddress),
      role: normalized,
      actorWalletAddress: actor,
    });

    setAuditContext(req, {
      action: "VAULT_SET_ROLE",
      resource: "VAULT_MEMBERSHIP",
      resourceId: vaultId,
      changes: {
        targetWalletAddress: normalizeWalletAddress(targetWalletAddress),
        role: normalized,
        actor,
        created: result.created,
      },
    });

    res.status(result.created ? 201 : 200).json({
      success: true,
      vaultId,
      member: result.member,
      created: result.created,
    });
  } catch (error) {
    if (error instanceof VaultAccessError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    sendError(res, 500, "INTERNAL", error instanceof Error ? error.message : "Failed to set role");
  }
});

/**
 * DELETE /api/vaults/:vaultId/access/members/:walletAddress
 * Remove a member (owner only).
 */
router.delete("/:vaultId/access/members/:walletAddress", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const target = normalizeWalletAddress(req.params.walletAddress);
  const actor = resolveWalletAddress(req);
  if (!actor) {
    sendError(res, 401, "WALLET_REQUIRED", "Actor wallet required");
    return;
  }
  try {
    vaultAccessService.removeMember(vaultId, target, actor);
    setAuditContext(req, {
      action: "VAULT_REMOVE_MEMBER",
      resource: "VAULT_MEMBERSHIP",
      resourceId: vaultId,
      changes: { target, actor },
    });
    res.json({ success: true, vaultId, removed: target });
  } catch (error) {
    if (error instanceof VaultAccessError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
    sendError(res, 500, "INTERNAL", error instanceof Error ? error.message : "Failed to remove member");
  }
});

// ── Protected vault actions (demonstrate server-side checks) ────────────

/**
 * POST /api/vaults/:vaultId/actions/:action
 * Execute a protected vault action. Requires the capability mapped to the action.
 * Actions: view, propose, approve, execute, pause, resume, rebalance, etc.
 */
router.post("/:vaultId/actions/:action", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const actionRaw = String(req.params.action);
  const action = actionRaw.toLowerCase();
  const requiredCap = resolveRequiredCapability(action);
  if (!requiredCap) {
    sendError(res, 400, "UNKNOWN_ACTION", `Unknown action ${actionRaw}. Allowed: view, propose, approve, execute, pause, resume, etc.`);
    return;
  }
  const wallet = resolveWalletAddress(req);
  if (!wallet) {
    sendError(res, 401, "WALLET_REQUIRED", "Wallet address required");
    return;
  }
  const role = vaultAccessService.getRole(vaultId, wallet);
  if (!role || !canRolePerform(role as VaultRole, requiredCap)) {
    sendError(
      res,
      403,
      "VAULT_FORBIDDEN",
      `Role ${role ?? "none"} cannot perform ${action} (requires ${requiredCap})`
    );
    return;
  }

  // Simulate successful execution - in production this would trigger on-chain or queue work.
  setAuditContext(req, {
    action: `VAULT_${action.toUpperCase()}`,
    resource: "VAULT_ACTION",
    resourceId: vaultId,
    changes: {
      action,
      requiredCapability: requiredCap,
      actor: wallet,
      role,
      body: req.body,
    },
  });

  res.json({
    success: true,
    vaultId,
    action,
    requiredCapability: requiredCap,
    actor: wallet,
    role,
    message: `Action ${action} executed for vault ${vaultId} by ${wallet} (${role})`,
    executionId: `${vaultId}:${action}:${Date.now()}`,
  });
});

/**
 * GET /api/vaults/:vaultId/actions
 * List available actions for the caller's role (requires view).
 */
router.get("/:vaultId/actions", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const wallet = resolveWalletAddress(req);
  if (!wallet) {
    sendError(res, 401, "WALLET_REQUIRED", "Wallet required");
    return;
  }
  const role = vaultAccessService.getRole(vaultId, wallet);
  if (!role || !canRolePerform(role as VaultRole, "view")) {
    sendError(res, 403, "VAULT_FORBIDDEN", `Role ${role ?? "none"} cannot view actions`);
    return;
  }
  const caps = getCapabilitiesForRole(role as VaultRole);
  const actions = [
    { action: "view", allowed: caps.includes("view"), required: "view" },
    { action: "propose", allowed: caps.includes("propose"), required: "propose" },
    { action: "approve", allowed: caps.includes("approve"), required: "approve" },
    { action: "execute", allowed: caps.includes("execute"), required: "execute" },
    { action: "pause", allowed: caps.includes("execute"), required: "execute" },
    { action: "resume", allowed: caps.includes("execute"), required: "execute" },
  ];
  res.json({ vaultId, wallet, role, capabilities: caps, actions });
});

// ── Bootstrap helper for dev/preview (no auth) — only allowed when vault empty ──
router.post("/:vaultId/access/bootstrap", (req: Request, res: Response): void => {
  const vaultId = normalizeVaultId(req.params.vaultId);
  const existing = vaultAccessService.listMembers(vaultId);
  if (existing.length > 0) {
    sendError(res, 400, "ALREADY_BOOTSTRAPPED", "Vault already has members; use POST /access/role with owner auth");
    return;
  }
  const { walletAddress, role } = req.body as { walletAddress?: string; role?: string };
  if (!walletAddress) {
    sendError(res, 400, "MISSING_WALLET", "walletAddress required");
    return;
  }
  const normalized = normalizeRole(role || "owner");
  if (normalized !== "owner") {
    sendError(res, 400, "BOOTSTRAP_REQUIRES_OWNER", "Bootstrap role must be owner");
    return;
  }
  const member = vaultAccessService.seedMember(vaultId, normalizeWalletAddress(walletAddress), normalized);
  res.status(201).json({ success: true, vaultId, member });
});

export default router;
