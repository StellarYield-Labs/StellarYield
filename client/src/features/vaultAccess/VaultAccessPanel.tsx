import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../lib/api";
import { useWallet } from "../../context/useWallet";
import { useVaultRole, notifyVaultRoleChanged } from "./useVaultRole";
import { VaultActionGate } from "./VaultActionGate";
import type { VaultMember, VaultRole } from "./types";
import { VAULT_ROLES } from "./types";

interface Props {
  vaultId: string;
}

export function VaultAccessPanel({ vaultId }: Props) {
  const { walletAddress } = useWallet();
  const { role, capabilities, canView, canPropose, canApprove, canExecute, canManageMembers, loading, error, lastUpdated, refresh } =
    useVaultRole({ vaultId, walletAddress, pollIntervalMs: 5000 });

  const [members, setMembers] = useState<VaultMember[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState("");
  const [assignRole, setAssignRole] = useState<VaultRole>("viewer");
  const [assigning, setAssigning] = useState(false);

  const fetchMembers = useCallback(async () => {
    if (!walletAddress) return;
    try {
      setMembersError(null);
      const url = `${apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/access/members`)}?walletAddress=${encodeURIComponent(walletAddress)}`;
      const headers: Record<string, string> = {};
      if (walletAddress) headers["x-wallet-address"] = walletAddress;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
      }
      const json = (await res.json()) as { members: VaultMember[] };
      setMembers(json.members);
    } catch (e) {
      setMembersError(e instanceof Error ? e.message : "Failed to load members");
    }
  }, [vaultId, walletAddress]);

  useEffect(() => {
    void fetchMembers();
  }, [fetchMembers, lastUpdated]);

  const runAction = async (action: string) => {
    if (!walletAddress) return;
    setActionStatus(null);
    setActionError(null);
    try {
      const res = await fetch(apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/actions/${action}`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wallet-address": walletAddress,
        },
        body: JSON.stringify({ walletAddress, note: `client ${action}` }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) throw new Error(body.error || `Forbidden for role ${role}`);
      setActionStatus(body.message || `${action} succeeded`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    }
  };

  const handleAssignRole = async () => {
    if (!walletAddress || !assignTarget) return;
    setAssigning(true);
    setActionError(null);
    setActionStatus(null);
    try {
      const res = await fetch(apiUrl(`/api/vaults/${encodeURIComponent(vaultId)}/access/role`), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": walletAddress },
        body: JSON.stringify({
          targetWalletAddress: assignTarget,
          role: assignRole,
          actorWalletAddress: walletAddress,
        }),
      });
      const body = (await res.json()) as { error?: string; member?: VaultMember };
      if (!res.ok) throw new Error(body.error || "Failed to set role");
      setActionStatus(`Role ${assignRole} assigned to ${assignTarget}`);
      notifyVaultRoleChanged(vaultId);
      void refresh();
      void fetchMembers();
      setAssignTarget("");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to assign role");
    } finally {
      setAssigning(false);
    }
  };

  if (!vaultId) return null;

  const needsWallet = !walletAddress;

  return (
    <div className="glass-panel p-6 space-y-6" data-testid="vault-access-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">Vault Access</h3>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-xs px-3 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
          aria-label="Refresh vault role"
        >
          Refresh
        </button>
      </div>

      {needsWallet ? (
        <p className="text-sm text-amber-300">Connect a wallet to see your vault role.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-slate-900/60 p-3 border border-slate-700">
              <p className="text-xs uppercase tracking-widest text-gray-500">Your Role</p>
              <p className="font-mono text-white text-base" data-testid="vault-role-value">
                {loading ? "Loading…" : (role ?? "none (not a member)")}
              </p>
              <p className="text-xs text-gray-400 mt-1">vault {vaultId}</p>
              {lastUpdated && <p className="text-[10px] text-gray-500 mt-1">updated {new Date(lastUpdated).toLocaleTimeString()}</p>}
              {error && <p className="text-xs text-red-400 mt-1" role="alert">{error}</p>}
            </div>
            <div className="rounded-lg bg-slate-900/60 p-3 border border-slate-700">
              <p className="text-xs uppercase tracking-widest text-gray-500">Capabilities</p>
              <p className="font-mono text-white text-sm" data-testid="vault-capabilities">
                {capabilities.length ? capabilities.join(", ") : "none"}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                view:{String(canView)} propose:{String(canPropose)} approve:{String(canApprove)} execute:{String(canExecute)}
              </p>
            </div>
          </div>

          {/* Action buttons with gating */}
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">Vault Actions</p>
            <div className="flex flex-wrap gap-2">
              <VaultActionGate role={role} requiredCapability="view" mode="disable" disabledReason="Requires view">
                <button
                  type="button"
                  onClick={() => void runAction("view")}
                  className="px-3 py-1.5 rounded bg-slate-700 text-white text-sm hover:bg-slate-600"
                  data-testid="action-view"
                >
                  View
                </button>
              </VaultActionGate>

              <VaultActionGate role={role} requiredCapability="propose" mode="disable" disabledReason="Requires propose (manager/owner)">
                <button
                  type="button"
                  onClick={() => void runAction("propose")}
                  className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm hover:bg-blue-500"
                  data-testid="action-propose"
                >
                  Propose
                </button>
              </VaultActionGate>

              <VaultActionGate role={role} requiredCapability="approve" mode="disable" disabledReason="Requires approve (reviewer/owner)">
                <button
                  type="button"
                  onClick={() => void runAction("approve")}
                  className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm hover:bg-emerald-500"
                  data-testid="action-approve"
                >
                  Approve
                </button>
              </VaultActionGate>

              <VaultActionGate role={role} requiredCapability="execute" mode="disable" disabledReason="Requires execute (manager/owner)">
                <button
                  type="button"
                  onClick={() => void runAction("execute")}
                  className="px-3 py-1.5 rounded bg-amber-600 text-white text-sm hover:bg-amber-500"
                  data-testid="action-execute"
                >
                  Execute
                </button>
              </VaultActionGate>
            </div>
            {/* Also demonstrate hide mode */}
            <div className="mt-3 flex flex-wrap gap-2">
              <VaultActionGate role={role} requiredCapability="propose" mode="hide">
                <span className="text-xs text-blue-300" data-testid="hint-propose">You can propose</span>
              </VaultActionGate>
              <VaultActionGate role={role} requiredCapability="approve" mode="hide">
                <span className="text-xs text-emerald-300" data-testid="hint-approve">You can approve</span>
              </VaultActionGate>
              <VaultActionGate role={role} requiredCapability="execute" mode="hide">
                <span className="text-xs text-amber-300" data-testid="hint-execute">You can execute</span>
              </VaultActionGate>
              <VaultActionGate role={role} requiredCapability="manage_members" mode="hide">
                <span className="text-xs text-purple-300" data-testid="hint-manage">You can manage members</span>
              </VaultActionGate>
            </div>
            {actionStatus && <p className="text-sm text-green-400 mt-2" role="status">{actionStatus}</p>}
            {actionError && <p className="text-sm text-red-400 mt-2" role="alert">{actionError}</p>}
          </div>

          {/* Member list */}
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">Members</p>
            {membersError ? (
              <p className="text-sm text-amber-400" role="alert">{membersError}</p>
            ) : members.length === 0 ? (
              <p className="text-sm text-gray-500">No members yet. Owner can bootstrap.</p>
            ) : (
              <ul className="space-y-1 text-sm" data-testid="vault-members-list">
                {members.map((m) => (
                  <li key={m.walletAddress} className="flex items-center justify-between rounded bg-slate-900/40 px-3 py-2 border border-slate-800">
                    <span className="font-mono text-xs text-white">{m.walletAddress}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-200">{m.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Role assignment — only owner */}
          <VaultActionGate role={role} requiredCapability="manage_members" mode="hide">
            <div className="rounded-lg border border-purple-900/50 bg-purple-950/20 p-4 space-y-3">
              <p className="text-sm font-semibold text-purple-200">Manage Members (owner)</p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  aria-label="Target wallet address"
                  placeholder="G... wallet address"
                  value={assignTarget}
                  onChange={(e) => setAssignTarget(e.target.value)}
                  className="flex-1 rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white placeholder:text-slate-500"
                />
                <select
                  aria-label="Select role"
                  value={assignRole}
                  onChange={(e) => setAssignRole(e.target.value as VaultRole)}
                  className="rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
                >
                  {VAULT_ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleAssignRole()}
                  disabled={assigning || !assignTarget}
                  className="px-4 py-2 rounded bg-purple-600 text-white text-sm hover:bg-purple-500 disabled:opacity-50"
                >
                  {assigning ? "Saving…" : "Assign"}
                </button>
              </div>
              <p className="text-xs text-gray-500">Changes take effect without a page reload; members are polled every 5s and on focus.</p>
            </div>
          </VaultActionGate>

          {!canManageMembers && (
            <p className="text-xs text-gray-500" data-testid="manage-hidden-notice">
              Role assignment is hidden — requires owner.
            </p>
          )}
        </>
      )}
    </div>
  );
}
