import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useWallet } from "../../context/useWallet";
import { DEFAULT_APP_URL } from "./referralLink";

vi.mock("../../context/useWallet", () => ({
  useWallet: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  getApiBaseUrl: () => "http://localhost:3000",
  apiUrl: (path: string) => `http://localhost:3000${path}`,
}));

const WALLET_ADDRESS = "GABCDEF";

/**
 * The dashboard resolves `VITE_APP_URL` once at module scope, so each case
 * stubs the env var and re-imports the module with a fresh registry.
 */
async function renderDashboard(appUrl: string | undefined) {
  vi.resetModules();
  if (appUrl === undefined) {
    vi.stubEnv("VITE_APP_URL", undefined as unknown as string);
  } else {
    vi.stubEnv("VITE_APP_URL", appUrl);
  }
  const { default: ReferralDashboard } = await import("./ReferralDashboard");
  render(<ReferralDashboard />);
}

describe("ReferralDashboard referral link domain", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Spy (not just assert) so the misconfiguration warning never reaches the
    // test output as noise.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(useWallet).mockReturnValue({
      isConnected: true,
      walletAddress: WALLET_ADDRESS,
    } as unknown as ReturnType<typeof useWallet>);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          referredTvl: 0,
          unclaimedRewards: 0,
          totalReferrals: 0,
          referralLink: "",
        }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    warnSpy.mockRestore();
  });

  it("renders the referral link using the default domain when VITE_APP_URL is missing", async () => {
    await renderDashboard(undefined);

    await waitFor(() => {
      expect(screen.getByText("Your Referral Link")).toBeInTheDocument();
    });

    expect(
      screen.getByDisplayValue(`${DEFAULT_APP_URL}/?ref=${WALLET_ADDRESS}`),
    ).toBeInTheDocument();
  });

  it("warns once about the missing configuration without crashing", async () => {
    await renderDashboard(undefined);

    await waitFor(() => {
      expect(screen.getByText("Referral Program")).toBeInTheDocument();
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("VITE_APP_URL");
  });

  it("falls back to the default domain when VITE_APP_URL is blank", async () => {
    await renderDashboard("   ");

    await waitFor(() => {
      expect(
        screen.getByDisplayValue(`${DEFAULT_APP_URL}/?ref=${WALLET_ADDRESS}`),
      ).toBeInTheDocument();
    });
  });

  it("keeps using the configured domain when VITE_APP_URL is set", async () => {
    await renderDashboard("https://app.example.com");

    await waitFor(() => {
      expect(
        screen.getByDisplayValue(`https://app.example.com/?ref=${WALLET_ADDRESS}`),
      ).toBeInTheDocument();
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
