import { useCallback, useEffect, useState } from "react";
import { apiUrl, isApiUnavailableError } from "../../lib/api";

export interface GovernanceProposalSimulation {
  id: string;
  simulatedAtLedger: number;
  simulationExpiry: string;
  riskWarnings: string[];
  resourceFee: string;
}

export interface GovernanceProposalRecord {
  id: string;
  actionHash: string;
  method: string;
  targetContractId: string;
  proposer: string;
  status: string;
  rationale: string;
  createdAt: string;
  updatedAt: string;
  executionTxHash: string | null;
  simulations: GovernanceProposalSimulation[];
}

/**
 * Fetches the canonical proposal state from the server/indexer rather than
 * relying on local-only state, so proposal status survives a page refresh
 * or switching devices (Issue #81 requirement).
 */
export function useGovernanceProposals() {
  const [proposals, setProposals] = useState<GovernanceProposalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/governance/proposals"));
      if (!response.ok) {
        throw new Error(`Failed to load proposals: ${response.status}`);
      }
      const data = (await response.json()) as { proposals: GovernanceProposalRecord[] };
      setProposals(data.proposals ?? []);
    } catch (err) {
      if (isApiUnavailableError(err)) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load governance proposals");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const cancelProposal = useCallback(
    async (id: string, reason: string) => {
      const response = await fetch(apiUrl(`/api/governance/proposals/${id}/cancel`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        throw new Error(`Failed to cancel proposal: ${response.status}`);
      }
      await refresh();
    },
    [refresh],
  );

  return { proposals, loading, error, refresh, cancelProposal };
}
