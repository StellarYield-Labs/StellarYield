import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReallocationTimelinePlanner } from "./ReallocationTimelinePlanner";

describe("ReallocationTimelinePlanner", () => {
  it("renders a clear empty state when there are no timeline steps", () => {
    render(
      <ReallocationTimelinePlanner
        planName="May Rotation Plan"
        status="draft"
        steps={[]}
      />,
    );

    expect(screen.getByText("No reallocation steps yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Once your planner generates recommendations/i),
    ).toBeInTheDocument();
  });

  it("renders the planned steps when timeline data is present", () => {
    render(
      <ReallocationTimelinePlanner
        planName="May Rotation Plan"
        status="draft"
        steps={[
          {
            stepId: "step-1",
            scheduledAt: "2026-05-01T09:00:00.000Z",
            expectedFeeUsd: 120,
            expectedRecoveryHours: 8,
            allocations: { "Vault-A": 70, "Vault-B": 20, "Vault-C": 10 },
          },
        ]}
      />,
    );

    expect(screen.getByText(/When:/)).toBeInTheDocument();
    expect(screen.getByText(/Expected fee:/)).toBeInTheDocument();
    expect(screen.getByText(/Recovery window:/)).toBeInTheDocument();
  });
});
