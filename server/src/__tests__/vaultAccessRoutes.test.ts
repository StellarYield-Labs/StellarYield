process.env.AUDIT_SIGNING_KEY = process.env.AUDIT_SIGNING_KEY || "test-audit-key-for-vault-access";
import request from "supertest";
import { createApp } from "../app";
import { vaultAccessService } from "../services/vaultAccessService";

describe("vaultAccess routes — server-side authorization", () => {
  const app = createApp();
  const VAULT = "usdc-routes-test";
  const OWNER = "GOWNER_ROUTES1111111111111111111111111111111111111111";
  const MANAGER = "GMANAGER_ROUTES2222222222222222222222222222222222222";
  const REVIEWER = "GREVIEWER_ROUTES333333333333333333333333333333333333";
  const VIEWER = "GVIEWER_ROUTES44444444444444444444444444444444444444";

  beforeEach(() => {
    vaultAccessService.clearAll();
    vaultAccessService.seedMember(VAULT, OWNER, "owner");
    vaultAccessService.seedMember(VAULT, MANAGER, "manager");
    vaultAccessService.seedMember(VAULT, REVIEWER, "reviewer");
    vaultAccessService.seedMember(VAULT, VIEWER, "viewer");
  });

  describe("GET /api/vaults/:vaultId/access/role", () => {
    it("returns role and capabilities for viewer", async () => {
      const res = await request(app).get(`/api/vaults/${VAULT}/access/role`).query({ walletAddress: VIEWER });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("viewer");
      expect(res.body.canView).toBe(true);
      expect(res.body.canPropose).toBe(false);
      expect(res.body.canApprove).toBe(false);
      expect(res.body.canExecute).toBe(false);
    });

    it("returns manager capabilities (propose+execute, not approve)", async () => {
      const res = await request(app).get(`/api/vaults/${VAULT}/access/role`).query({ walletAddress: MANAGER });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("manager");
      expect(res.body.canPropose).toBe(true);
      expect(res.body.canExecute).toBe(true);
      expect(res.body.canApprove).toBe(false);
    });

    it("returns reviewer capabilities (approve, not propose/execute)", async () => {
      const res = await request(app).get(`/api/vaults/${VAULT}/access/role`).query({ walletAddress: REVIEWER });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("reviewer");
      expect(res.body.canApprove).toBe(true);
      expect(res.body.canPropose).toBe(false);
      expect(res.body.canExecute).toBe(false);
    });

    it("supports x-wallet-address header", async () => {
      const res = await request(app).get(`/api/vaults/${VAULT}/access/role`).set("x-wallet-address", OWNER);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("owner");
    });
  });

  describe("POST /api/vaults/:vaultId/actions/:action — server-side checks", () => {
    it("allows viewer to view (allowed)", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/view`)
        .set("x-wallet-address", VIEWER)
        .send({ walletAddress: VIEWER });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("denies viewer from proposing (forbidden) — role combo 1", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/propose`)
        .set("x-wallet-address", VIEWER)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("VAULT_FORBIDDEN");
    });

    it("denies reviewer from executing (forbidden) — role combo 2", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/execute`)
        .set("x-wallet-address", REVIEWER)
        .send({});
      expect(res.status).toBe(403);
    });

    it("denies manager from approving (forbidden) — role combo 3", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/approve`)
        .set("x-wallet-address", MANAGER)
        .send({});
      expect(res.status).toBe(403);
    });

    it("allows manager to propose (allowed)", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/propose`)
        .set("x-wallet-address", MANAGER)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("manager");
    });

    it("allows reviewer to approve (allowed)", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/approve`)
        .set("x-wallet-address", REVIEWER)
        .send({});
      expect(res.status).toBe(200);
    });

    it("allows owner to execute (allowed)", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/execute`)
        .set("x-wallet-address", OWNER)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("owner");
    });

    it("returns 401 when wallet missing", async () => {
      const res = await request(app).post(`/api/vaults/${VAULT}/actions/view`).send({});
      expect(res.status).toBe(401);
    });

    it("returns 400 for unknown action", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/unknownActionXYZ`)
        .set("x-wallet-address", OWNER)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/vaults/:vaultId/access/role — owner-only", () => {
    it("allows owner to promote viewer to reviewer", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/access/role`)
        .set("x-wallet-address", OWNER)
        .send({ targetWalletAddress: VIEWER, role: "reviewer" });
      expect(res.status).toBe(200);
      expect(res.body.member.role).toBe("reviewer");
    });

    it("forbids manager from changing roles", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/access/role`)
        .set("x-wallet-address", MANAGER)
        .send({ targetWalletAddress: VIEWER, role: "manager" });
      expect(res.status).toBe(403);
    });

    it("forbids reviewer from changing roles", async () => {
      const res = await request(app)
        .post(`/api/vaults/${VAULT}/access/role`)
        .set("x-wallet-address", REVIEWER)
        .send({ targetWalletAddress: VIEWER, role: "manager" });
      expect(res.status).toBe(403);
    });
  });

  describe("role changes reflected without app reset", () => {
    it("promotion takes effect on next request without restart", async () => {
      // Viewer cannot propose initially
      let res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/propose`)
        .set("x-wallet-address", VIEWER)
        .send({});
      expect(res.status).toBe(403);

      // Owner promotes viewer -> manager
      const promote = await request(app)
        .post(`/api/vaults/${VAULT}/access/role`)
        .set("x-wallet-address", OWNER)
        .send({ targetWalletAddress: VIEWER, role: "manager" });
      expect(promote.status).toBe(200);

      // Same wallet (viewer address) can now propose without any server restart — re-resolve
      res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/propose`)
        .set("x-wallet-address", VIEWER)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("manager");

      // And GET role reflects new role instantly
      const roleRes = await request(app).get(`/api/vaults/${VAULT}/access/role`).query({ walletAddress: VIEWER });
      expect(roleRes.body.role).toBe("manager");
      expect(roleRes.body.canPropose).toBe(true);
    });

    it("demotion immediately revokes capability", async () => {
      // Manager can propose
      let res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/propose`)
        .set("x-wallet-address", MANAGER)
        .send({});
      expect(res.status).toBe(200);

      // Owner demotes manager -> viewer
      await request(app)
        .post(`/api/vaults/${VAULT}/access/role`)
        .set("x-wallet-address", OWNER)
        .send({ targetWalletAddress: MANAGER, role: "viewer" });

      res = await request(app)
        .post(`/api/vaults/${VAULT}/actions/propose`)
        .set("x-wallet-address", MANAGER)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/vaults/:vaultId/access/members", () => {
    it("allows viewer to list members (view capability)", async () => {
      const res = await request(app).get(`/api/vaults/${VAULT}/access/members`).set("x-wallet-address", VIEWER);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(4);
    });

    it("denies outsider from listing members", async () => {
      const res = await request(app)
        .get(`/api/vaults/${VAULT}/access/members`)
        .set("x-wallet-address", "GOUTSIDER9999999999999999999999999999999999999999");
      expect(res.status).toBe(403);
    });
  });
});
