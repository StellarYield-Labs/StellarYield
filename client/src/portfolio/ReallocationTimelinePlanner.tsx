import React from "react";

export interface ReallocationTimelineStep {
  stepId: string;
  scheduledAt: string;
  expectedFeeUsd: number;
  expectedRecoveryHours: number;
  allocations: Record<string, number>;
}

interface ReallocationTimelinePlannerProps {
  planName: string;
  status: "draft" | "paused" | "cancelled" | "ready";
  steps: ReallocationTimelineStep[];
}

export const ReallocationTimelinePlanner: React.FC<ReallocationTimelinePlannerProps> = ({ planName, status, steps }) => {
  const hasSteps = steps.length > 0;

  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold">Cross-Vault Reallocation Timeline</h3>
        <span className="text-xs uppercase tracking-wide">{status}</span>
      </div>
      <p className="text-sm text-gray-300">{planName} (planning only, non-executable until explicitly confirmed)</p>
      {hasSteps ? (
        steps.map((step) => (
          <div key={step.stepId} className="border border-gray-700 rounded-lg p-4 text-sm">
            <div>When: {new Date(step.scheduledAt).toLocaleString()}</div>
            <div>Expected fee: ${step.expectedFeeUsd.toLocaleString()}</div>
            <div>Recovery window: {step.expectedRecoveryHours}h</div>
            <div>Allocations: {Object.entries(step.allocations).map(([vault, pct]) => `${vault} ${pct}%`).join(" | ")}</div>
          </div>
        ))
      ) : (
        <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/40 p-6 text-center text-sm text-gray-300">
          <div className="text-base font-semibold text-white">No reallocation steps yet</div>
          <p className="mt-2 text-gray-400">
            Once your planner generates recommendations, this timeline will show each scheduled reallocation step.
          </p>
        </div>
      )}
    </div>
  );
};
