import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import {
  ReallocationTimelinePlanner,
  ReallocationTimelineStep,
} from "./ReallocationTimelinePlanner";

const steps: ReallocationTimelineStep[] = [
  {
    stepId: "step-1",
    scheduledAt: "2026-08-20T12:00:00.000Z",
    expectedFeeUsd: 12.5,
    expectedRecoveryHours: 48,
    allocations: { "Vault A": 60, "Vault B": 40 },
  },
];

describe("ReallocationTimelinePlanner", () => {
  it("renders the plan header and status", () => {
    render(
      <ReallocationTimelinePlanner planName="Q3 Rebalance" status="draft" steps={[]} />,
    );
    expect(screen.getByText("Cross-Vault Reallocation Timeline")).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
    expect(screen.getByText(/Q3 Rebalance/)).toBeInTheDocument();
  });

  it("renders a clear empty state when there are no planned steps", () => {
    render(
      <ReallocationTimelinePlanner planName="Q3 Rebalance" status="draft" steps={[]} />,
    );
    const empty = screen.getByTestId("reallocation-timeline-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/no reallocation steps planned yet/i);
    expect(empty).toHaveTextContent(/scheduled steps will appear here/i);
  });

  it("does not render the empty state when steps are present", () => {
    render(
      <ReallocationTimelinePlanner planName="Q3 Rebalance" status="ready" steps={steps} />,
    );
    expect(screen.queryByTestId("reallocation-timeline-empty")).not.toBeInTheDocument();
  });

  it("renders the scheduled steps when data is present", () => {
    render(
      <ReallocationTimelinePlanner planName="Q3 Rebalance" status="ready" steps={steps} />,
    );
    expect(screen.getByText("Expected fee: $12.5")).toBeInTheDocument();
    expect(screen.getByText("Recovery window: 48h")).toBeInTheDocument();
    expect(
      screen.getByText("Allocations: Vault A 60% | Vault B 40%"),
    ).toBeInTheDocument();
  });
});
