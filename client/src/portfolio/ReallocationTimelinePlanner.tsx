import React from "react";
import { CalendarClock } from "lucide-react";

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
  return (
    <div className="glass-panel p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold">Cross-Vault Reallocation Timeline</h3>
        <span className="text-xs uppercase tracking-wide">{status}</span>
      </div>
      <p className="text-sm text-gray-300">{planName} (planning only, non-executable until explicitly confirmed)</p>
      {steps.length === 0 ? (
        <div
          data-testid="reallocation-timeline-empty"
          className="border border-dashed border-gray-700 rounded-lg p-6 text-center"
        >
          <CalendarClock size={24} className="text-gray-500 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-300">
            No reallocation steps planned yet
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Scheduled steps will appear here once this plan has recommendations
            to execute.
          </p>
        </div>
      ) : (
        steps.map((step) => (
          <div key={step.stepId} className="border border-gray-700 rounded-lg p-4 text-sm">
            <div>When: {new Date(step.scheduledAt).toLocaleString()}</div>
            <div>Expected fee: ${step.expectedFeeUsd.toLocaleString()}</div>
            <div>Recovery window: {step.expectedRecoveryHours}h</div>
            <div>Allocations: {Object.entries(step.allocations).map(([vault, pct]) => `${vault} ${pct}%`).join(" | ")}</div>
          </div>
        ))
      )}
    </div>
  );
};
