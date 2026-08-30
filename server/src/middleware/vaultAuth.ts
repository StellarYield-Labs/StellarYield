import { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/errorResponse";
import {
  VaultCapability,
  VaultRole,
  normalizeVaultId,
  normalizeWalletAddress,
  vaultAccessService,
  canRolePerform,
  resolveRequiredCapability,
} from "../services/vaultAccessService";

/**
 * Resolve wallet address from request.
 * Priority:
 *  1. req.user.walletAddress (if auth middleware populated it)
 *  2. x-wallet-address header
 *  3. query.walletAddress / query.wallet / query.address
 *  4. body.walletAddress / body.wallet / body.actorWalletAddress
 */
export function resolveWalletAddress(req: Request): string | null {
  const user = (req as unknown as Record<string, unknown>).user as
    | { walletAddress?: string; id?: string }
    | undefined;
  if (user?.walletAddress) return normalizeWalletAddress(user.walletAddress);

  const header = req.headers["x-wallet-address"];
  if (typeof header === "string" && header.trim()) return normalizeWalletAddress(header);

  const q = req.query as Record<string, unknown>;
  for (const key of ["walletAddress", "wallet", "address", "actor"]) {
    const val = q[key];
    if (typeof val === "string" && val.trim()) return normalizeWalletAddress(val);
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const key of ["walletAddress", "wallet", "actorWalletAddress", "actor"]) {
    const val = body[key];
    if (typeof val === "string" && (val as string).trim()) return normalizeWalletAddress(val as string);
  }

  return null;
}

export function resolveVaultId(req: Request): string | null {
  const params = req.params as Record<string, string>;
  if (params.vaultId) return normalizeVaultId(params.vaultId);
  if (params.vault) return normalizeVaultId(params.vault);
  if (params.id) return normalizeVaultId(params.id);
  const q = req.query as Record<string, unknown>;
  if (typeof q.vaultId === "string" && q.vaultId.trim()) return normalizeVaultId(q.vaultId);
  return null;
}

/**
 * Middleware factory: require that the wallet has a specific capability in the vault.
 * Server-side authorization check — response is 403 if denied, 401 if no wallet.
 */
export function requireVaultCapability(capability: VaultCapability) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const vaultId = resolveVaultId(req);
    if (!vaultId) {
      sendError(res, 400, "MISSING_VAULT_ID", "vaultId is required");
      return;
    }
    const wallet = resolveWalletAddress(req);
    if (!wallet) {
      sendError(res, 401, "WALLET_REQUIRED", "Wallet address is required (x-wallet-address header or walletAddress query)");
      return;
    }

    const role = vaultAccessService.getRole(vaultId, wallet);
    if (!role || !canRolePerform(role as VaultRole, capability)) {
      sendError(
        res,
        403,
        "VAULT_FORBIDDEN",
        `Wallet ${wallet} with role ${role ?? "none"} lacks capability ${capability} for vault ${vaultId}`
      );
      return;
    }

    // Attach resolved role for downstream handlers
    (req as unknown as Record<string, unknown>).vaultRole = role;
    (req as unknown as Record<string, unknown>).vaultId = vaultId;
    (req as unknown as Record<string, unknown>).walletAddress = wallet;
    next();
  };
}

/**
 * Middleware factory: require that the wallet has a specific role (or one of several).
 */
export function requireVaultRole(...allowed: VaultRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const vaultId = resolveVaultId(req);
    if (!vaultId) {
      sendError(res, 400, "MISSING_VAULT_ID", "vaultId is required");
      return;
    }
    const wallet = resolveWalletAddress(req);
    if (!wallet) {
      sendError(res, 401, "WALLET_REQUIRED", "Wallet address is required");
      return;
    }
    const role = vaultAccessService.getRole(vaultId, wallet);
    if (!role || !allowed.includes(role as VaultRole)) {
      sendError(
        res,
        403,
        "VAULT_FORBIDDEN",
        `Wallet ${wallet} role ${role ?? "none"} is not in allowed ${allowed.join(",")}`
      );
      return;
    }
    (req as unknown as Record<string, unknown>).vaultRole = role;
    (req as unknown as Record<string, unknown>).vaultId = vaultId;
    (req as unknown as Record<string, unknown>).walletAddress = wallet;
    next();
  };
}

/**
 * Middleware factory: require that wallet can perform an action (mapped via VAULT_ACTION_REQUIREMENTS).
 */
export function requireVaultAction(actionParam = "action") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const vaultId = resolveVaultId(req);
    const wallet = resolveWalletAddress(req);
    if (!vaultId) {
      sendError(res, 400, "MISSING_VAULT_ID", "vaultId is required");
      return;
    }
    if (!wallet) {
      sendError(res, 401, "WALLET_REQUIRED", "Wallet address is required");
      return;
    }
    const action = (req.params[actionParam] as string) ?? (req.body?.action as string) ?? "";
    const required = resolveRequiredCapability(action);
    if (!required) {
      sendError(res, 400, "UNKNOWN_ACTION", `Unknown vault action: ${action}`);
      return;
    }
    const role = vaultAccessService.getRole(vaultId, wallet);
    if (!role || !canRolePerform(role as VaultRole, required)) {
      sendError(
        res,
        403,
        "VAULT_FORBIDDEN",
        `Role ${role ?? "none"} cannot perform ${action} (requires ${required})`
      );
      return;
    }
    (req as unknown as Record<string, unknown>).vaultRole = role;
    next();
  };
}
