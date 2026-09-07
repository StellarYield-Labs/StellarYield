import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../contracts/registry.json", () => ({
  default: {
    testnet: {
      vault: "CDTESTVAULT",
      zap: "",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
    },
    mainnet: {},
    local: {},
  },
}));

vi.mock("../../../../contracts/registry.previous.json", () => ({
  default: {
    testnet: {
      vault: "",
      zap: "",
      token: "",
      governance: "",
      strategy: "",
      emissionController: "",
      liquidStaking: "",
      stableswap: "",
    },
    mainnet: {},
    local: {},
  },
}));

import RegistryDiffPage from "./RegistryDiff";

describe("RegistryDiffPage copy actions", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("copies contract address and shows success feedback", async () => {
    render(<RegistryDiffPage />);
    const buttons = screen.getAllByRole("button", { name: "Copy" });

    fireEvent.click(buttons[0]);

    expect(await screen.findByText("Copied!")).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });
});
