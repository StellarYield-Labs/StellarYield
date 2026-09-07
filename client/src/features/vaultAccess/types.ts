/**
 * Vault access types — mirrors server/src/services/vaultAccessService.ts
 * Keep this in sync with the server matrix.
 */

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

export const ROLE_CAPABILITIES: Record<VaultRole, VaultCapability[]> = {
  owner: ["view", "propose", "approve", "execute", "manage_members"],
  manager: ["view", "propose", "execute"],
  reviewer: ["view", "approve"],
  viewer: ["view"],
};

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

export interface VaultRoleResponse {
  vaultId: string;
  walletAddress: string;
  role: VaultRole | null;
  capabilities: VaultCapability[];
  canView: boolean;
  canPropose: boolean;
  canApprove: boolean;
  canExecute: boolean;
  canManageMembers: boolean;
  isMember: boolean;
}

export interface VaultMember {
  vaultId: string;
  walletAddress: string;
  role: VaultRole;
  grantedBy: string | null;
  grantedAt: string;
  updatedAt: string;
}

export interface VaultActionInfo {
  action: string;
  allowed: boolean;
  required: VaultCapability;
}
