import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DepositSimulator } from "./DepositSimulator";
import * as simulationService from "./simulationService";

describe("DepositSimulator (#161)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders prompt message when amount is 0 (empty input)", () => {
    const spy = vi.spyOn(simulationService, "fetchDepositSimulation");
    render(<DepositSimulator strategyId="strat-1" amount={0} token="USDC" />);
    expect(screen.getByText("Enter an amount to see the preview.")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("renders validation message for non-numeric (NaN) or negative amount input", () => {
    const spy = vi.spyOn(simulationService, "fetchDepositSimulation");
    const { rerender } = render(
      <DepositSimulator strategyId="strat-1" amount={Number.NaN} token="USDC" />,
    );
    expect(
      screen.getByText("Please enter a valid positive deposit amount."),
    ).toBeTruthy();

    rerender(<DepositSimulator strategyId="strat-1" amount={-50} token="USDC" />);
    expect(
      screen.getByText("Please enter a valid positive deposit amount."),
    ).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("simulates and displays preview for valid positive amount", async () => {
    vi.spyOn(simulationService, "fetchDepositSimulation").mockResolvedValueOnce({
      expectedShares: 998.5,
      postDepositExposure: { expectedApy: 0.085 },
      allocations: [{ protocol: "Blend", amount: 1000, percentage: 100 }],
      fees: [{ type: "Protocol Fee", amount: 1.5 }],
      warnings: [],
    } as any);

    render(<DepositSimulator strategyId="strat-1" amount={1000} token="USDC" />);

    await waitFor(() => {
      expect(screen.getByText("Deposit Simulation")).toBeTruthy();
    });
    expect(screen.getByText("8.50%")).toBeTruthy();
    expect(screen.getByText("Blend")).toBeTruthy();
  });
});
