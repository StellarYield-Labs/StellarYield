import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Vault from "../Vault";
import * as vaultData from "../../lib/vaultData";

// Mock hooks
vi.mock("../../context/useWallet", () => ({
  useWallet: () => ({ walletAddress: "G123..." }),
}));

vi.mock("../../hooks/useVaultOgMeta", () => ({
  useVaultOgMeta: () => ({
    title: "Mock Title",
    tags: [],
  }),
}));

// Mock components that might do their own fetching or have complex logic
vi.mock("../AIAdvisor/RecoveryAdvisor", () => ({
  RecoveryAdvisor: () => <div data-testid="recovery-advisor" />,
}));

vi.mock("../../features/zap", () => ({
  ZapDepositPanel: () => <div data-testid="zap-panel" />,
}));

describe("Vault Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", async () => {
    // Delay the mock response
    vi.spyOn(vaultData, "fetchVaultStats").mockReturnValue(
      new Promise((resolve) => setTimeout(() => resolve(null), 100))
    );

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText(/Loading vault details.../i)).toBeInTheDocument();
  });

  it("shows not found state for unknown slug", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={["/vault/unknown-slug"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Vault Not Found/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/"unknown-slug"/i)).toBeInTheDocument();
  });

  it("shows unavailable state when live data is missing", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 0,
      tvl: 0,
      live: false,
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Live Data Unavailable/i)).toBeInTheDocument();
  });

  it("renders vault details when data is loaded successfully", async () => {
    vi.spyOn(vaultData, "fetchVaultStats").mockResolvedValue({
      name: "USDC Yield Vault",
      asset: "USDC",
      protocol: "Blend",
      apy: 12.5,
      tvl: 1000000,
      live: true,
    });

    render(
      <MemoryRouter initialEntries={["/vault/usdc"]}>
        <Routes>
          <Route path="/vault/:slug" element={<Vault />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Vault/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/12.50%/)).toBeInTheDocument();
    expect(screen.getByText(/\$1.00M/)).toBeInTheDocument();
    expect(screen.getByTestId("recovery-advisor")).toBeInTheDocument();
    expect(screen.getByTestId("zap-panel")).toBeInTheDocument();
  });
});
