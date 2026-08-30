import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../../lib/api";
import type { VaultRole, VaultCapability, VaultRoleResponse } from "./types";
import { getCapabilitiesForRole } from "./permissions";

export interface UseVaultRoleOptions {
  vaultId: string | null | undefined;
  walletAddress: string | null | undefined;
  pollIntervalMs?: number;
  enabled?: boolean;
}

export interface UseVaultRoleReturn {
  role: VaultRole | null;
  capabilities: VaultCapability[];
  canView: boolean;
  canPropose: boolean;
  canApprove: boolean;
  canExecute: boolean;
  canManageMembers: boolean;
  isMember: boolean;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;
  refresh: () => Promise<void>;
}

const DEFAULT_POLL_MS = 5000;

export function useVaultRole(options: UseVaultRoleOptions): UseVaultRoleReturn {
  const { vaultId, walletAddress, pollIntervalMs = DEFAULT_POLL_MS, enabled = true } = options;

  const [data, setData] = useState<VaultRoleResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<number | null>(null);

  const fetchRole = useCallback(async () => {
    if (!vaultId || !walletAddress || !enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Cancel previous
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      const url = `${apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/access/role`)}?walletAddress=${encodeURIComponent(walletAddress)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Failed to fetch role: ${res.status}`);
      }
      const json = (await res.json()) as VaultRoleResponse;
      if (controller.signal.aborted) return;
      setData(json);
      setLastUpdated(new Date().toISOString());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Failed to fetch role");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [vaultId, walletAddress, enabled]);

  // Initial + wallet/vault change
  useEffect(() => {
    void fetchRole();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchRole]);

  // Polling for role changes without full app reset + live event listeners
  useEffect(() => {
    if (!vaultId || !walletAddress || !enabled) return;

    let intervalId: number | null = null;
    if (pollIntervalMs > 0) {
      intervalId = window.setInterval(() => {
        void fetchRole();
      }, pollIntervalMs);
      pollRef.current = intervalId;
    }

    const onFocus = () => void fetchRole();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchRole();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // Listen to custom event for immediate refresh (e.g., after role change)
    const onVaultRoleChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail as { vaultId?: string };
      if (!detail?.vaultId || detail.vaultId === vaultId) void fetchRole();
    };
    window.addEventListener("vault-role-changed", onVaultRoleChanged as EventListener);

    return () => {
      if (intervalId !== null) window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("vault-role-changed", onVaultRoleChanged as EventListener);
    };
  }, [vaultId, walletAddress, enabled, pollIntervalMs, fetchRole]);

  const role = data?.role ?? null;
  const capabilities: VaultCapability[] = data?.capabilities ?? getCapabilitiesForRole(role);

  return {
    role,
    capabilities,
    canView: data?.canView ?? capabilities.includes("view"),
    canPropose: data?.canPropose ?? capabilities.includes("propose"),
    canApprove: data?.canApprove ?? capabilities.includes("approve"),
    canExecute: data?.canExecute ?? capabilities.includes("execute"),
    canManageMembers: data?.canManageMembers ?? capabilities.includes("manage_members"),
    isMember: data?.isMember ?? role !== null,
    loading,
    error,
    lastUpdated,
    refresh: fetchRole,
  };
}

/** Broadcast that a vault's roles changed so all hooks can re-fetch */
export function notifyVaultRoleChanged(vaultId: string): void {
  window.dispatchEvent(new CustomEvent("vault-role-changed", { detail: { vaultId } }));
}
