import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PortfolioBuilder from "./PortfolioBuilder";

describe("PortfolioBuilder component", () => {
  const mockVaults = [
    { contractId: "v1", name: "Yield Vault A", apy: 12.5 },
    { contractId: "v2", name: "Yield Vault B", apy: 8.0 },
    { contractId: "v3", name: "Yield Vault C", apy: 5.5 },
  ];

  it("renders total allocation sum in a deterministic 100.0% format on initial load", () => {
    render(<PortfolioBuilder walletAddress="GABC123" availableVaults={mockVaults} />);

    const totalDisplay = screen.getByTestId("total-allocation-display");
    expect(totalDisplay).toBeDefined();
    expect(totalDisplay.textContent).toBe("Total: 100.0%");
    expect(totalDisplay.className).toContain("text-green-400");
  });

  it("does not render allocation warning banner when allocations sum to 100%", () => {
    render(<PortfolioBuilder walletAddress="GABC123" availableVaults={mockVaults} />);

    expect(screen.queryByTestId("allocation-warning")).toBeNull();
  });

  it("renders deterministic total sum and warning banner when available vaults are empty (non-100% state)", () => {
    render(<PortfolioBuilder walletAddress="GABC123" availableVaults={[]} />);

    const totalDisplay = screen.getByTestId("total-allocation-display");
    expect(totalDisplay).toBeDefined();
    expect(totalDisplay.textContent).toBe("Total: 0.0%");
    expect(totalDisplay.className).toContain("text-yellow-400");

    const warning = screen.getByTestId("allocation-warning");
    expect(warning).toBeDefined();
    expect(warning.textContent).toContain("Allocations must sum to 100% (currently 0.0%)");
  });

  it("preserves deterministic 100.0% allocation display across presets", () => {
    render(<PortfolioBuilder walletAddress="GABC123" availableVaults={mockVaults} />);

    const presets = ["conservative", "balanced", "aggressive", "stablecoin-heavy"];
    const totalDisplay = screen.getByTestId("total-allocation-display");

    for (const preset of presets) {
      const button = screen.getByRole("button", { name: new RegExp(preset.replace("-", " "), "i") });
      fireEvent.click(button);
      expect(totalDisplay.textContent).toBe("Total: 100.0%");
      expect(totalDisplay.className).toContain("text-green-400");
    }
  });

  it("updates individual vault sliders and maintains deterministic total allocation display", () => {
    render(<PortfolioBuilder walletAddress="GABC123" availableVaults={mockVaults} />);

    const sliders = screen.getAllByRole("slider");
    expect(sliders.length).toBe(3);

    // Adjust first slider
    fireEvent.change(sliders[0], { target: { value: "50" } });

    const totalDisplay = screen.getByTestId("total-allocation-display");
    expect(totalDisplay.textContent).toBe("Total: 100.0%");
  });

  it("disables execution button when total amount is empty or allocation is invalid", () => {
    render(<PortfolioBuilder walletAddress="GABC123" availableVaults={mockVaults} />);

    const executeButton = screen.getByRole("button", { name: /Execute Multi-Vault Deposit/i });
    expect(executeButton).toHaveProperty("disabled", true);
  });
});
