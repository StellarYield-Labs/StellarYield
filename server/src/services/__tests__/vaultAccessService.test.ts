import {
  VAULT_ROLES,
  ROLE_CAPABILITIES,
  VaultAccessService,
  VaultAccessError,
  canRolePerform,
  canRolePerformAction,
  getCapabilitiesForRole,
  normalizeRole,
} from "../vaultAccessService";

describe("vault permission matrix", () => {
  it("defines four roles", () => {
    expect(VAULT_ROLES).toEqual(["owner", "manager", "reviewer", "viewer"]);
  });

  it("viewer can only view", () => {
    expect(ROLE_CAPABILITIES.viewer).toEqual(["view"]);
    expect(canRolePerform("viewer", "view")).toBe(true);
    expect(canRolePerform("viewer", "propose")).toBe(false);
    expect(canRolePerform("viewer", "approve")).toBe(false);
    expect(canRolePerform("viewer", "execute")).toBe(false);
    expect(canRolePerform("viewer", "manage_members")).toBe(false);
  });

  it("reviewer can view and approve only", () => {
    expect(ROLE_CAPABILITIES.reviewer).toEqual(["view", "approve"]);
    expect(canRolePerform("reviewer", "view")).toBe(true);
    expect(canRolePerform("reviewer", "approve")).toBe(true);
    expect(canRolePerform("reviewer", "propose")).toBe(false);
    expect(canRolePerform("reviewer", "execute")).toBe(false);
  });

  it("manager can view, propose, execute (not approve)", () => {
    expect(ROLE_CAPABILITIES.manager).toEqual(["view", "propose", "execute"]);
    expect(canRolePerform("manager", "view")).toBe(true);
    expect(canRolePerform("manager", "propose")).toBe(true);
    expect(canRolePerform("manager", "execute")).toBe(true);
    expect(canRolePerform("manager", "approve")).toBe(false);
    expect(canRolePerform("manager", "manage_members")).toBe(false);
  });

  it("owner has all capabilities", () => {
    expect(ROLE_CAPABILITIES.owner).toEqual(["view", "propose", "approve", "execute", "manage_members"]);
    for (const cap of ["view", "propose", "approve", "execute", "manage_members"] as const) {
      expect(canRolePerform("owner", cap)).toBe(true);
    }
  });

  it("canRolePerformAction maps actions to capabilities", () => {
    expect(canRolePerformAction("viewer", "view")).toBe(true);
    expect(canRolePerformAction("viewer", "propose")).toBe(false);
    expect(canRolePerformAction("reviewer", "approve")).toBe(true);
    expect(canRolePerformAction("reviewer", "execute")).toBe(false);
    expect(canRolePerformAction("manager", "propose")).toBe(true);
    expect(canRolePerformAction("manager", "approve")).toBe(false);
    expect(canRolePerformAction("manager", "execute")).toBe(true);
    expect(canRolePerformAction("owner", "manage_members")).toBe(true);
    expect(canRolePerformAction("owner", "pause")).toBe(true);
  });

  it("normalizeRole is case-insensitive", () => {
    expect(normalizeRole("OWNER")).toBe("owner");
    expect(normalizeRole("Manager")).toBe("manager");
    expect(normalizeRole("invalid")).toBeNull();
  });

  it("getCapabilitiesForRole returns copy", () => {
    const caps = getCapabilitiesForRole("manager");
    expect(caps).toEqual(["view", "propose", "execute"]);
    caps.push("view" as never);
    expect(getCapabilitiesForRole("manager")).toEqual(["view", "propose", "execute"]);
  });
});

describe("VaultAccessService — allow/deny and role changes", () => {
  let service: VaultAccessService;
  const VAULT = "usdc";
  const OWNER = "GOWNER11111111111111111111111111111111111111111111111111";
  const MANAGER = "GMANAGER22222222222222222222222222222222222222222222222";
  const REVIEWER = "GREVIEWER33333333333333333333333333333333333333333333333";
  const VIEWER = "GVIEWER44444444444444444444444444444444444444444444444444";
  const OUTSIDER = "GOUTSIDER5555555555555555555555555555555555555555555555";

  beforeEach(() => {
    service = new VaultAccessService(new Map());
    service.seedMember(VAULT, OWNER, "owner");
    service.seedMember(VAULT, MANAGER, "manager");
    service.seedMember(VAULT, REVIEWER, "reviewer");
    service.seedMember(VAULT, VIEWER, "viewer");
  });

  it("allows viewing for all members, denies outsider", () => {
    expect(service.canPerformAction(VAULT, VIEWER, "view")).toBe(true);
    expect(service.canPerformAction(VAULT, REVIEWER, "view")).toBe(true);
    expect(service.canPerformAction(VAULT, MANAGER, "view")).toBe(true);
    expect(service.canPerformAction(VAULT, OWNER, "view")).toBe(true);
    expect(service.canPerformAction(VAULT, OUTSIDER, "view")).toBe(false);
  });

  it("denies propose for viewer and reviewer, allows for manager and owner", () => {
    expect(service.canPerformAction(VAULT, VIEWER, "propose")).toBe(false);
    expect(service.canPerformAction(VAULT, REVIEWER, "propose")).toBe(false);
    expect(service.canPerformAction(VAULT, MANAGER, "propose")).toBe(true);
    expect(service.canPerformAction(VAULT, OWNER, "propose")).toBe(true);
  });

  it("denies approve for viewer and manager, allows for reviewer and owner", () => {
    expect(service.canPerformAction(VAULT, VIEWER, "approve")).toBe(false);
    expect(service.canPerformAction(VAULT, MANAGER, "approve")).toBe(false);
    expect(service.canPerformAction(VAULT, REVIEWER, "approve")).toBe(true);
    expect(service.canPerformAction(VAULT, OWNER, "approve")).toBe(true);
  });

  it("denies execute for viewer and reviewer, allows for manager and owner", () => {
    expect(service.canPerformAction(VAULT, VIEWER, "execute")).toBe(false);
    expect(service.canPerformAction(VAULT, REVIEWER, "execute")).toBe(false);
    expect(service.canPerformAction(VAULT, MANAGER, "execute")).toBe(true);
    expect(service.canPerformAction(VAULT, OWNER, "execute")).toBe(true);
  });

  it("enforces server-side: viewer cannot propose, reviewer cannot execute — third role combo coverage", () => {
    // This test documents at least three distinct denied combinations as required
    const combos: Array<[string, string, boolean]> = [
      [VIEWER, "propose", false],
      [REVIEWER, "execute", false],
      [MANAGER, "approve", false],
      [OWNER, "manage_members", true],
    ];
    for (const [wallet, action, expected] of combos) {
      expect(service.canPerformAction(VAULT, wallet, action)).toBe(expected);
    }
  });

  it("owner can change viewer to manager; role change reflected immediately without reset", () => {
    expect(service.getRole(VAULT, VIEWER)).toBe("viewer");
    expect(service.canPerformAction(VAULT, VIEWER, "propose")).toBe(false);

    // Owner promotes viewer -> manager
    const result = service.setRole({
      vaultId: VAULT,
      targetWalletAddress: VIEWER,
      role: "manager",
      actorWalletAddress: OWNER,
    });
    expect(result.member.role).toBe("manager");
    expect(service.getRole(VAULT, VIEWER)).toBe("manager");
    // Now the same wallet can propose without any app reset
    expect(service.canPerformAction(VAULT, VIEWER, "propose")).toBe(true);
    expect(service.canPerformAction(VAULT, VIEWER, "execute")).toBe(true);
    expect(service.canPerformAction(VAULT, VIEWER, "approve")).toBe(false);
  });

  it("role demotion is reflected immediately", () => {
    expect(service.canPerformAction(VAULT, MANAGER, "propose")).toBe(true);
    service.setRole({ vaultId: VAULT, targetWalletAddress: MANAGER, role: "viewer", actorWalletAddress: OWNER });
    expect(service.getRole(VAULT, MANAGER)).toBe("viewer");
    expect(service.canPerformAction(VAULT, MANAGER, "propose")).toBe(false);
    expect(service.canPerformAction(VAULT, MANAGER, "view")).toBe(true);
  });

  it("forbids non-owner from managing members", () => {
    expect(() =>
      service.setRole({ vaultId: VAULT, targetWalletAddress: VIEWER, role: "viewer", actorWalletAddress: MANAGER })
    ).toThrow(VaultAccessError);
    expect(() =>
      service.setRole({ vaultId: VAULT, targetWalletAddress: VIEWER, role: "viewer", actorWalletAddress: REVIEWER })
    ).toThrow(VaultAccessError);
    expect(() =>
      service.setRole({ vaultId: VAULT, targetWalletAddress: VIEWER, role: "viewer", actorWalletAddress: VIEWER })
    ).toThrow(VaultAccessError);
  });

  it("bootstrap requires owner", () => {
    const fresh = new VaultAccessService(new Map());
    expect(() =>
      fresh.setRole({ vaultId: "new-vault", targetWalletAddress: OWNER, role: "viewer", actorWalletAddress: OWNER })
    ).toThrow(VaultAccessError);
    const res = fresh.setRole({ vaultId: "new-vault", targetWalletAddress: OWNER, role: "owner", actorWalletAddress: OWNER });
    expect(res.member.role).toBe("owner");
  });

  it("prevents removing last owner", () => {
    const soloVault = "solo";
    const soloService = new VaultAccessService(new Map());
    soloService.seedMember(soloVault, OWNER, "owner");
    expect(() => soloService.removeMember(soloVault, OWNER, OWNER)).toThrow(VaultAccessError);
    // Add second owner then removal succeeds
    soloService.seedMember(soloVault, MANAGER, "owner");
    expect(() => soloService.removeMember(soloVault, OWNER, MANAGER)).not.toThrow();
  });

  it("listMembers returns all seeded members", () => {
    const members = service.listMembers(VAULT);
    expect(members).toHaveLength(4);
    const roles = members.map((m) => m.role).sort();
    expect(roles).toEqual(["manager", "owner", "reviewer", "viewer"]);
  });
});
