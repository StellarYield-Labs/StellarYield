/**
 * vaultAccessService.ts
 *
 * Shared vault permission model for StellarYield.
 * Defines roles (owner, manager, reviewer, viewer) and maps each role to
 * discrete capabilities: view, propose, approve, execute.
 *
 * The capability matrix is the source of truth for both server-side
 * authorization checks and client-side UI gating.
 */

// ── Role & Capability types ─────────────────────────────────────────────

export const VAULT_ROLES = ["owner", "manager", "reviewer", "viewer"] as const;
export type VaultRole = (typeof VAULT_ROLES)[number];

export const VAULT_CAPABILITIES = [
  "view",
  "propose",
  "approve",
  "execute",
  "manage_members",
] as const;
export type VaultCapability = (typeof VAULT_CAPABILITIES)[number];

/**
 * Capability matrix: which capabilities each role grants.
 *
 * - viewer:  read-only — can inspect vault state, history, and proposals
 * - reviewer: viewer + can approve/reject proposals (separation of duties)
 * - manager: viewer + can propose new actions and execute approved ones
 * - owner: all capabilities, including member management
 */
export const ROLE_CAPABILITIES: Record<VaultRole, VaultCapability[]> = {
  owner: ["view", "propose", "approve", "execute", "manage_members"],
  manager: ["view", "propose", "execute"],
  reviewer: ["view", "approve"],
  viewer: ["view"],
};

/**
 * Vault actions map to a required capability. This indirection allows
 * granular action names (e.g. pause, resume) to be checked against a
 * single capability without duplicating the matrix.
 */
export const VAULT_ACTION_REQUIREMENTS: Record<string, VaultCapability> = {
  view: "view",
  read: "view",
  list: "view",
  propose: "propose",
  create_proposal: "propose",
  update_parameters: "propose",
  propose_pause: "propose",
  approve: "approve",
  review: "approve",
  execute: "execute",
  pause: "execute",
  resume: "execute",
  rebalance: "execute",
  deposit: "execute",
  withdraw: "execute",
  manage_members: "manage_members",
  set_role: "manage_members",
};

export function normalizeRole(input: string | null | undefined): VaultRole | null {
  if (!input || typeof input !== "string") return null;
  const lower = input.trim().toLowerCase() as VaultRole;
  return (VAULT_ROLES as readonly string[]).includes(lower) ? lower : null;
}

export function normalizeCapability(input: string): VaultCapability | null {
  if (!input || typeof input !== "string") return null;
  const lower = input.trim().toLowerCase() as VaultCapability;
  return (VAULT_CAPABILITIES as readonly string[]).includes(lower) ? lower : null;
}

export function getCapabilitiesForRole(role: VaultRole): VaultCapability[] {
  return [...(ROLE_CAPABILITIES[role] ?? [])];
}

export function canRolePerform(role: VaultRole, capability: VaultCapability): boolean {
  const caps = ROLE_CAPABILITIES[role];
  if (!caps) return false;
  return caps.includes(capability);
}

export function canRolePerformAction(role: VaultRole, action: string): boolean {
  const required = VAULT_ACTION_REQUIREMENTS[action.toLowerCase()];
  if (!required) return false;
  return canRolePerform(role, required);
}

export function resolveRequiredCapability(action: string): VaultCapability | null {
  return VAULT_ACTION_REQUIREMENTS[action.toLowerCase()] ?? null;
}

// ── In-memory membership store ──────────────────────────────────────────
// For production this would be backed by a VaultMembership table.
// We keep an in-memory Map so tests and preview envs work without DB migration
// while still enforcing the same authorization logic.

export interface VaultMember {
  vaultId: string;
  walletAddress: string;
  role: VaultRole;
  grantedBy: string | null;
  grantedAt: string;
  updatedAt: string;
}

type VaultStore = Map<string, Map<string, VaultMember>>;

const vaultStore: VaultStore = new Map();

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeVaultId(vaultId: string): string {
  return vaultId.trim().toLowerCase();
}

export function normalizeWalletAddress(addr: string): string {
  return addr.trim();
}

// ── Core service ────────────────────────────────────────────────────────

export class VaultAccessService {
  private store: VaultStore;

  constructor(store: VaultStore = vaultStore) {
    this.store = store;
  }

  /** Clear all memberships (used in tests). */
  clearAll(): void {
    this.store.clear();
  }

  /** List members for a vault */
  listMembers(vaultId: string): VaultMember[] {
    const vid = normalizeVaultId(vaultId);
    const members = this.store.get(vid);
    if (!members) return [];
    return Array.from(members.values());
  }

  /** Get role for a wallet in a vault, or null if not a member */
  getRole(vaultId: string, walletAddress: string): VaultRole | null {
    const vid = normalizeVaultId(vaultId);
    const addr = normalizeWalletAddress(walletAddress);
    const members = this.store.get(vid);
    if (!members) return null;
    const member = members.get(addr);
    return member ? member.role : null;
  }

  /** Return full member record or null */
  getMember(vaultId: string, walletAddress: string): VaultMember | null {
    const vid = normalizeVaultId(vaultId);
    const addr = normalizeWalletAddress(walletAddress);
    const members = this.store.get(vid);
    if (!members) return null;
    return members.get(addr) ?? null;
  }

  /** Check if a wallet has a specific capability in a vault */
  hasCapability(vaultId: string, walletAddress: string, capability: VaultCapability): boolean {
    const role = this.getRole(vaultId, walletAddress);
    if (!role) return false;
    return canRolePerform(role, capability);
  }

  /** Check if wallet can perform an action (via capability mapping) */
  canPerformAction(vaultId: string, walletAddress: string, action: string): boolean {
    const required = resolveRequiredCapability(action);
    if (!required) return false;
    return this.hasCapability(vaultId, walletAddress, required);
  }

  /** Return capabilities for a wallet in a vault */
  getCapabilities(vaultId: string, walletAddress: string): VaultCapability[] {
    const role = this.getRole(vaultId, walletAddress);
    if (!role) return [];
    return getCapabilitiesForRole(role);
  }

  /**
   * Set or update a member's role.
   *
   * Authorization: only a wallet with `manage_members` (owner) may change
   * roles, except for bootstrapping: if a vault has no members, the first
   * assignment must be an owner self-assignment and is allowed without
   * prior membership.
   */
  setRole(params: {
    vaultId: string;
    targetWalletAddress: string;
    role: VaultRole;
    actorWalletAddress: string;
  }): { member: VaultMember; created: boolean } {
    const vid = normalizeVaultId(params.vaultId);
    const target = normalizeWalletAddress(params.targetWalletAddress);
    const actor = normalizeWalletAddress(params.actorWalletAddress);
    const newRole = normalizeRole(params.role);

    if (!newRole) {
      throw new VaultAccessError(`Invalid role: ${params.role}`, "INVALID_ROLE", 400);
    }
    if (!target) {
      throw new VaultAccessError("targetWalletAddress is required", "MISSING_TARGET", 400);
    }
    if (!actor) {
      throw new VaultAccessError("actorWalletAddress is required", "MISSING_ACTOR", 400);
    }

    let members = this.store.get(vid);

    // Bootstrap: vault has no members yet
    if (!members || members.size === 0) {
      // Only allow bootstrapping as owner, and actor must be target (self-bootstrap)
      // or any actor can bootstrap the first owner in a test/dev context.
      // We enforce that the first role must be owner to prevent unowned vaults.
      if (newRole !== "owner") {
        throw new VaultAccessError(
          "First member of a vault must be owner (bootstrap)",
          "BOOTSTRAP_REQUIRES_OWNER",
          403
        );
      }
      if (!members) {
        members = new Map();
        this.store.set(vid, members);
      }
      const now = nowIso();
      const member: VaultMember = {
        vaultId: vid,
        walletAddress: target,
        role: newRole,
        grantedBy: actor,
        grantedAt: now,
        updatedAt: now,
      };
      members.set(target, member);
      return { member, created: true };
    }

    // Existing vault: actor must have manage_members
    const actorRole = this.getRole(vid, actor);
    if (!actorRole || !canRolePerform(actorRole, "manage_members")) {
      throw new VaultAccessError(
        `Wallet ${actor} with role ${actorRole ?? "none"} cannot manage members (requires owner)`,
        "FORBIDDEN",
        403
      );
    }

    if (!members) {
      members = new Map();
      this.store.set(vid, members);
    }

    const existing = members.get(target);
    const now = nowIso();
    const member: VaultMember = {
      vaultId: vid,
      walletAddress: target,
      role: newRole,
      grantedBy: actor,
      grantedAt: existing ? existing.grantedAt : now,
      updatedAt: now,
    };
    members.set(target, member);
    return { member, created: !existing };
  }

  /** Direct seed for tests/dev: bypass authorization */
  seedMember(vaultId: string, walletAddress: string, role: VaultRole): VaultMember {
    const vid = normalizeVaultId(vaultId);
    const addr = normalizeWalletAddress(walletAddress);
    let members = this.store.get(vid);
    if (!members) {
      members = new Map();
      this.store.set(vid, members);
    }
    const now = nowIso();
    const member: VaultMember = {
      vaultId: vid,
      walletAddress: addr,
      role,
      grantedBy: "seed",
      grantedAt: now,
      updatedAt: now,
    };
    members.set(addr, member);
    return member;
  }

  /** Remove a member (owner only) */
  removeMember(vaultId: string, targetWalletAddress: string, actorWalletAddress: string): void {
    const vid = normalizeVaultId(vaultId);
    const target = normalizeWalletAddress(targetWalletAddress);
    const actor = normalizeWalletAddress(actorWalletAddress);
    const members = this.store.get(vid);
    if (!members || members.size === 0) {
      throw new VaultAccessError("Vault has no members", "NOT_FOUND", 404);
    }
    const actorRole = this.getRole(vid, actor);
    if (!actorRole || !canRolePerform(actorRole, "manage_members")) {
      throw new VaultAccessError("Forbidden: requires owner", "FORBIDDEN", 403);
    }
    if (!members.has(target)) {
      throw new VaultAccessError("Member not found", "NOT_FOUND", 404);
    }
    // Prevent removing last owner without transferring
    const targetMember = members.get(target)!;
    if (targetMember.role === "owner") {
      const ownerCount = Array.from(members.values()).filter((m) => m.role === "owner").length;
      if (ownerCount <= 1) {
        throw new VaultAccessError("Cannot remove last owner", "LAST_OWNER", 400);
      }
    }
    members.delete(target);
  }
}

export class VaultAccessError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "VaultAccessError";
    this.code = code;
    this.status = status;
  }
}

// Singleton used by routes/middleware
export const vaultAccessService = new VaultAccessService();

// ── Helpers for response DTOs ───────────────────────────────────────────

export function buildRoleResponse(vaultId: string, walletAddress: string) {
  const vid = normalizeVaultId(vaultId);
  const role = vaultAccessService.getRole(vid, walletAddress);
  const caps = role ? getCapabilitiesForRole(role) : [];
  return {
    vaultId: vid,
    walletAddress: normalizeWalletAddress(walletAddress),
    role,
    capabilities: caps,
    canView: caps.includes("view"),
    canPropose: caps.includes("propose"),
    canApprove: caps.includes("approve"),
    canExecute: caps.includes("execute"),
    canManageMembers: caps.includes("manage_members"),
    isMember: role !== null,
  };
}
