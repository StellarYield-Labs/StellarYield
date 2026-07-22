import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RelayerStatusPage from "./RelayerStatusPage";

const onlineStatus = {
  isOnline: true,
  serviceState: "online" as const,
  network: "testnet",
  queueDepth: 1,
  totalRelayed: 12,
  successCount: 11,
  failureCount: 1,
  successRate: 92,
  avgDurationMs: 180,
  lastRelayAt: new Date().toISOString(),
  lastRelayAgeMs: 1_000,
  recentEvents: [],
  replayProtection: {
    enabled: true,
    trackedHashes: 2,
    oldestHashAge: "5m",
    deduplicationWindow: "24h",
  },
  uptime: "1h 10m",
  checkedAt: new Date().toISOString(),
  alerts: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RelayerStatusPage", () => {
  it("renders degraded status alerts without crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ...onlineStatus,
            serviceState: "degraded",
            alerts: ["Last successful relay is stale (420s ago)."],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    render(<RelayerStatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/degraded/i)).toBeInTheDocument();
      expect(
        screen.getByText(/last successful relay is stale/i),
      ).toBeInTheDocument();
    });
  });

  it("keeps the last known status when a manual refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(onlineStatus), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("Backend unavailable"));

    vi.stubGlobal("fetch", fetchMock);

    render(<RelayerStatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/bridge relayer status/i)).toBeInTheDocument();
      expect(screen.getByText(/online/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/showing the last known status/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/backend unavailable/i)).toBeInTheDocument();
      expect(screen.getByText(/queue depth/i)).toBeInTheDocument();
    });
  });
});
