import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import OffRampPanel from "./OffRampPanel";

const props = {
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  vaultContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  vaultTokenSymbol: "SYV",
};

describe("OffRampPanel configuration state", () => {
  it("renders a safe disabled state when partner configuration is missing", () => {
    render(<OffRampPanel {...props} configured={false} />);

    expect(screen.getByRole("status")).toHaveTextContent("Bank withdrawals are not configured yet");
    expect(screen.getByRole("button", { name: /withdraw to bank/i })).toBeDisabled();
  });

  it("does not expose secret-like configuration values", () => {
    const { container } = render(<OffRampPanel {...props} configured={false} />);
    expect(container.textContent).not.toMatch(/api[_ -]?key|secret|bearer/i);
  });

  it("leaves the configured withdrawal action enabled", () => {
    render(<OffRampPanel {...props} configured />);
    expect(screen.getByRole("button", { name: /withdraw to bank/i })).toBeEnabled();
  });
});
