import { useState } from "react";
import { ShieldAlert, RefreshCw } from "lucide-react";
import { useGovernanceProposals } from "./useGovernanceProposals";
import ApiErrorBanner from "../../components/ApiErrorBanner/ApiErrorBanner";

const STATUS_COLOR: Record<string, string> = {
  PENDING: "text-gray-300 bg-gray-500/10",
  CHALLENGED: "text-orange-300 bg-orange-500/10",
  APPROVED: "text-blue-300 bg-blue-500/10",
  EXECUTABLE: "text-yellow-300 bg-yellow-500/10",
  SUBMITTED: "text-yellow-300 bg-yellow-500/10",
  CONFIRMED: "text-green-300 bg-green-500/10",
  FAILED: "text-red-300 bg-red-500/10",
  CANCELLED: "text-gray-400 bg-gray-500/10",
  EXPIRED: "text-gray-400 bg-gray-500/10",
};

/**
 * Canonical, server-backed view of governance proposals. Unlike the local
 * multi-sig transaction builder above, this list is reconciled from
 * on-chain events via the indexer, so it survives a page refresh or
 * switching devices instead of relying on localStorage (Issue #81).
 */
export default function GovernanceProposalsPanel() {
  const { proposals, loading, error, refresh, cancelProposal } = useGovernanceProposals();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  async function handleCancel(id: string) {
    setCancellingId(id);
    try {
      await cancelProposal(id, "Cancelled from governance dashboard");
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div className="glass-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <ShieldAlert size={18} className="text-indigo-400" />
            On-Chain Governance Proposals
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Canonical proposal state reconciled from the optimistic_governance contract.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="btn-secondary px-3 py-2 text-xs flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {error && <ApiErrorBanner message={error} onRetry={() => void refresh()} />}

      {!error && proposals.length === 0 && !loading && (
        <p className="text-sm text-gray-500">No governance proposals recorded yet.</p>
      )}

      <div className="space-y-3">
        {proposals.map((proposal) => {
          const latestSimulation = proposal.simulations[0];
          const colorClass = STATUS_COLOR[proposal.status] ?? "text-gray-300 bg-gray-500/10";
          const cancellable = !["CONFIRMED", "CANCELLED", "EXPIRED"].includes(proposal.status);

          return (
            <div key={proposal.id} className="bg-[#1a1a2e] rounded-lg p-4 space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-semibold text-white">{proposal.method}</p>
                  <p className="text-xs text-gray-500 mt-1">{proposal.rationale}</p>
                </div>
                <span className={`text-xs font-medium px-2 py-1 rounded ${colorClass}`}>
                  {proposal.status}
                </span>
              </div>

              <p className="text-xs text-gray-500 font-mono break-all">
                hash: {proposal.actionHash}
              </p>

              {latestSimulation && latestSimulation.riskWarnings.length > 0 && (
                <div className="text-xs text-orange-300 bg-orange-500/10 rounded p-2">
                  {latestSimulation.riskWarnings.map((warning, idx) => (
                    <p key={idx}>{warning}</p>
                  ))}
                </div>
              )}

              {cancellable && (
                <button
                  onClick={() => void handleCancel(proposal.id)}
                  disabled={cancellingId === proposal.id}
                  className="text-xs text-red-300 border border-red-500/30 rounded px-3 py-1 hover:bg-red-500/10 disabled:opacity-50"
                >
                  {cancellingId === proposal.id ? "Cancelling..." : "Cancel Proposal"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
