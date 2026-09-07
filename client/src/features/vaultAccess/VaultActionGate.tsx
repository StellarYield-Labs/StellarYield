import type { ReactNode } from "react";
import type { VaultCapability, VaultRole } from "./types";
import { canRolePerform, canRolePerformAction } from "./permissions";

export interface VaultActionGateProps {
  role: VaultRole | null | undefined;
  requiredCapability?: VaultCapability;
  requiredAction?: string;
  children: ReactNode;
  /** Content shown when forbidden; if mode=hide and no fallback, renders nothing */
  fallback?: ReactNode;
  /** If hide, gate hides children; if disable, wraps children in a disabled fieldset-like span */
  mode?: "hide" | "disable";
  /** Optional disabled tooltip reason */
  disabledReason?: string;
}

/**
 * Client-side gating component. Hides or disables actions the wallet cannot perform.
 * Note: server still enforces authorization — this is UX-only.
 */
export function VaultActionGate({
  role,
  requiredCapability,
  requiredAction,
  children,
  fallback = null,
  mode = "hide",
  disabledReason,
}: VaultActionGateProps) {
  let allowed = false;
  if (requiredCapability) allowed = canRolePerform(role, requiredCapability);
  else if (requiredAction) allowed = canRolePerformAction(role, requiredAction);
  else allowed = false;

  if (allowed) return <>{children}</>;

  if (mode === "hide") return <>{fallback}</>;

  // mode === "disable"
  const reason = disabledReason ?? `Disabled for role ${role ?? "none"}`;
  return (
    <span
      aria-disabled="true"
      title={reason}
      style={{ opacity: 0.5, pointerEvents: "none" as const, display: "inline-block" }}
      data-vault-gate="disabled"
      data-required={requiredCapability ?? requiredAction}
      data-role={role ?? "none"}
    >
      {children}
    </span>
  );
}

export interface VaultRouteGuardProps {
  role: VaultRole | null | undefined;
  requiredCapability: VaultCapability;
  children: ReactNode;
  fallback?: ReactNode;
}

export function VaultRouteGuard({ role, requiredCapability, children, fallback }: VaultRouteGuardProps) {
  const allowed = canRolePerform(role, requiredCapability);
  if (allowed) return <>{children}</>;
  return (
    <>
      {fallback ?? (
        <div className="glass-panel p-8 text-center space-y-3" data-testid="vault-route-forbidden">
          <p className="text-sm font-bold uppercase tracking-widest text-red-400">Access Denied</p>
          <p className="text-gray-400">
            Your role <code className="text-white">{role ?? "none"}</code> lacks capability{" "}
            <code className="text-amber-300">{requiredCapability}</code>. Contact the vault owner.
          </p>
        </div>
      )}
    </>
  );
}
