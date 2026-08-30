import { useParams, Link } from "react-router-dom";
import { useWallet } from "../../context/useWallet";
import { useVaultRole } from "../../features/vaultAccess/useVaultRole";
import { VaultRouteGuard } from "../../features/vaultAccess/VaultActionGate";
import { VaultAccessPanel } from "../../features/vaultAccess/VaultAccessPanel";
import { validateVaultSlug } from "../../lib/vaultData";
import { ArrowLeft } from "lucide-react";

export default function VaultManagePage() {
  const { slug } = useParams<{ slug?: string }>();
  const { walletAddress } = useWallet();
  const { valid, normalized } = validateVaultSlug(slug || "usdc");
  const { role, loading } = useVaultRole({ vaultId: normalized, walletAddress });

  if (!valid) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <p className="text-red-400">Invalid vault slug: {slug}</p>
        <Link to="/" className="text-green-400">Back</Link>
      </div>
    );
  }
  if (!walletAddress) {
    return (
      <div className="max-w-3xl mx-auto glass-panel p-8 text-center space-y-4">
        <p className="text-amber-300">Connect a wallet to manage vault {normalized}.</p>
        <Link to={`/vault/${normalized}`} className="text-green-400 flex items-center justify-center gap-2"><ArrowLeft size={16}/> Back to vault</Link>
      </div>
    );
  }
  if (loading) {
    return <div className="max-w-3xl mx-auto p-8 text-gray-400">Loading role…</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">Manage Vault {normalized}</h2>
        <Link to={`/vault/${normalized}`} className="text-sm text-slate-400 hover:text-white flex items-center gap-1"><ArrowLeft size={14}/> Vault</Link>
      </div>

      {/* Route-level gating: only members with view can see management; stronger gates inside */}
      <VaultRouteGuard role={role} requiredCapability="view">
        <p className="text-sm text-gray-400">Role <code className="text-white">{role ?? "none"}</code> — management view requires `view` capability. Below, individual sections are gated further.</p>
        <VaultAccessPanel vaultId={normalized} />
      </VaultRouteGuard>

      {/* Example of a propose-only route section */}
      <div className="glass-panel p-6">
        <h3 className="font-semibold text-white mb-2">Propose Section (requires propose)</h3>
        <VaultRouteGuard
          role={role}
          requiredCapability="propose"
          fallback={<p className="text-sm text-gray-500" data-testid="propose-gate-fallback">You lack propose permission (need manager/owner).</p>}
        >
          <p className="text-sm text-green-300" data-testid="propose-gate-allowed">Propose access granted — form would appear here.</p>
        </VaultRouteGuard>
      </div>

      <div className="glass-panel p-6">
        <h3 className="font-semibold text-white mb-2">Approve Section (requires approve)</h3>
        <VaultRouteGuard
          role={role}
          requiredCapability="approve"
          fallback={<p className="text-sm text-gray-500" data-testid="approve-gate-fallback">You lack approve permission (need reviewer/owner).</p>}
        >
          <p className="text-sm text-emerald-300" data-testid="approve-gate-allowed">Approve access granted.</p>
        </VaultRouteGuard>
      </div>
    </div>
  );
}
