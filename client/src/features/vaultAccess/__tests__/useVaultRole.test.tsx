import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useVaultRole } from "../useVaultRole";

describe("useVaultRole — live polling & role changes without reset", () => {
  const vaultId = "usdc";
  const viewerAddr = "GVIEWER_TEST_1111111111111111111111111111111111111111";
  const managerAddr = "GMANAGER_TEST_2222222222222222222222222222222222222";

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  function mockRoleResponse(role: string | null, caps: string[]) {
    return {
      vaultId,
      walletAddress: viewerAddr,
      role,
      capabilities: caps,
      canView: caps.includes("view"),
      canPropose: caps.includes("propose"),
      canApprove: caps.includes("approve"),
      canExecute: caps.includes("execute"),
      canManageMembers: caps.includes("manage_members"),
      isMember: role !== null,
    };
  }

  it("fetches role and exposes capabilities (allowed action)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockRoleResponse("viewer", ["view"]),
    });

    const { result } = renderHook(() => useVaultRole({ vaultId, walletAddress: viewerAddr, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.role).toBe("viewer");
    expect(result.current.canView).toBe(true);
    expect(result.current.canPropose).toBe(false);
    expect(result.current.isMember).toBe(true);
  });

  it("reflects role change via refresh() without unmount (simulates live update)", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => mockRoleResponse("viewer", ["view"]) })
      .mockResolvedValueOnce({ ok: true, json: async () => mockRoleResponse("manager", ["view", "propose", "execute"]) });

    const { result } = renderHook(() => useVaultRole({ vaultId, walletAddress: viewerAddr, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.role).toBe("viewer"));
    expect(result.current.canPropose).toBe(false);

    // Simulate server-side promotion: next fetch returns manager
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.role).toBe("manager"));
    expect(result.current.canPropose).toBe(true);
    expect(result.current.canExecute).toBe(true);
    expect(result.current.canApprove).toBe(false);
  });

  it("denies propose for viewer, allows for manager — distinct role combos", async () => {
    // First render as viewer
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => mockRoleResponse("viewer", ["view"]) });
    const { result, rerender } = renderHook(
      ({ addr }: { addr: string }) => useVaultRole({ vaultId, walletAddress: addr, pollIntervalMs: 0 }),
      { initialProps: { addr: viewerAddr } }
    );
    await waitFor(() => expect(result.current.role).toBe("viewer"));
    expect(result.current.canPropose).toBe(false);
    expect(result.current.canApprove).toBe(false);

    // Re-render same hook but with a different wallet that is manager — simulates wallet switch / role change
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...mockRoleResponse("manager", ["view", "propose", "execute"]), walletAddress: managerAddr }) });
    rerender({ addr: managerAddr });

    await waitFor(() => expect(result.current.role).toBe("manager"));
    expect(result.current.canPropose).toBe(true);
  });

  it("updates via vault-role-changed event without full reset (live update)", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => mockRoleResponse("viewer", ["view"]) })
      .mockResolvedValueOnce({ ok: true, json: async () => mockRoleResponse("manager", ["view", "propose", "execute"]) });

    const { result } = renderHook(() => useVaultRole({ vaultId, walletAddress: viewerAddr, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.role).toBe("viewer"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate server pushing role change via custom event (e.g., after owner promoted viewer)
    await act(async () => {
      window.dispatchEvent(new CustomEvent("vault-role-changed", { detail: { vaultId } }));
      // allow event handler to trigger fetch
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(result.current.role).toBe("manager"));
    expect(result.current.canPropose).toBe(true);
  });

  it("handles fetch error gracefully", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "not found" }) } as unknown as Response);

    const { result } = renderHook(() => useVaultRole({ vaultId, walletAddress: viewerAddr, pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 2000 });
    // error state should be set
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 2000 });
    expect(result.current.error).toMatch(/not found|Failed/);
  });
});
