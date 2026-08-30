import {
  VAULT_ROLES,
  ROLE_CAPABILITIES,
  VAULT_ACTION_REQUIREMENTS,
  type VaultRole,
  type VaultCapability,
} from "./types";

export function normalizeRole(input: string | null | undefined): VaultRole | null {
  if (!input || typeof input !== "string") return null;
  const lower = input.trim().toLowerCase() as VaultRole;
  return (VAULT_ROLES as readonly string[]).includes(lower) ? lower : null;
}

export function getCapabilitiesForRole(role: VaultRole | null | undefined): VaultCapability[] {
  if (!role) return [];
  return [...(ROLE_CAPABILITIES[role] ?? [])];
}

export function canRolePerform(role: VaultRole | null | undefined, capability: VaultCapability): boolean {
  if (!role) return false;
  const caps = ROLE_CAPABILITIES[role];
  return caps ? caps.includes(capability) : false;
}

export function canRolePerformAction(role: VaultRole | null | undefined, action: string): boolean {
  if (!role) return false;
  const required = VAULT_ACTION_REQUIREMENTS[action.toLowerCase()];
  if (!required) return false;
  return canRolePerform(role, required);
}

export function getRequiredCapability(action: string): VaultCapability | null {
  return VAULT_ACTION_REQUIREMENTS[action.toLowerCase()] ?? null;
}

export function describeRole(role: VaultRole): string {
  switch (role) {
    case "owner":
      return "Owner — all permissions including member management";
    case "manager":
      return "Manager — can propose and execute, but not approve";
    case "reviewer":
      return "Reviewer — can approve, but not propose or execute";
    case "viewer":
      return "Viewer — read-only access";
    default:
      return "No access";
  }
}

export function isValidRole(value: unknown): value is VaultRole {
  return typeof value === "string" && (VAULT_ROLES as readonly string[]).includes(value.toLowerCase());
}
