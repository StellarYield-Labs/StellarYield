import {
  DEFAULT_TREASURY_REALLOCATION_POLICY,
  evaluateTreasuryReallocation,
  executeTreasuryReallocation,
  type TreasuryReallocationPolicy,
  type TreasuryReallocationProposal,
} from "../services/treasuryReallocationPolicyService";
import request from "supertest";
import { createApp } from "../app";

const makeProposal = (
  overrides: Partial<TreasuryReallocationProposal> = {},
): TreasuryReallocationProposal => ({
  id: "reallocation-226",
  amountUsd: 50_000,
  treasuryValueUsd: 1_000_000,
  currentRiskScore: 30,
  proposedRiskScore: 34,
  assetExposurePct: { USDC: 20, XLM: 10 },
  protocolExposurePct: { Blend: 25, Soroswap: 10 },
  recentIncidentState: "none",
  ...overrides,
});

const makePolicy = (
  overrides: Partial<TreasuryReallocationPolicy> = {},
): TreasuryReallocationPolicy => ({
  ...DEFAULT_TREASURY_REALLOCATION_POLICY,
  ...overrides,
});

describe("evaluateTreasuryReallocation", () => {
  it("auto-approves a proposal that satisfies every configured policy", () => {
    expect(evaluateTreasuryReallocation(makeProposal())).toEqual({
      decision: "auto_approved",
      proposalId: "reallocation-226",
      blockedRules: [],
    });
  });

  it("requires approval and identifies every automation rule that was exceeded", () => {
    const result = evaluateTreasuryReallocation(
      makeProposal({
        amountUsd: 150_000,
        proposedRiskScore: 38,
        assetExposurePct: { USDC: 30 },
        protocolExposurePct: { Blend: 40 },
        recentIncidentState: "resolved",
      }),
    );

    expect(result.decision).toBe("approval_required");
    expect(result.blockedRules.map((rule) => rule.ruleId)).toEqual([
      "size.max_auto_approved_amount_usd",
      "size.max_auto_approved_treasury_pct",
      "risk.max_auto_approved_score_increase",
      "asset_exposure.max_auto_approved_exposure_pct",
      "protocol_exposure.max_auto_approved_exposure_pct",
      "incident.approval_required_states",
    ]);
    expect(result.blockedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "size.max_auto_approved_amount_usd",
          actual: 150_000,
          threshold: 100_000,
          effect: "require_approval",
        }),
      ]),
    );
    expect(result.blockedRules.every((rule) => rule.message.length > 0)).toBe(true);
  });

  it.each([
    ["size", makeProposal({ amountUsd: 500_000 }), "size.max_treasury_pct"],
    ["risk score", makeProposal({ proposedRiskScore: 85 }), "risk.max_proposed_score"],
    ["risk change", makeProposal({ currentRiskScore: 20, proposedRiskScore: 45 }), "risk.max_score_increase"],
    ["asset exposure", makeProposal({ assetExposurePct: { USDC: 55 } }), "asset_exposure.max_exposure_pct"],
    ["protocol exposure", makeProposal({ protocolExposurePct: { Blend: 65 } }), "protocol_exposure.max_exposure_pct"],
    ["incident", makeProposal({ recentIncidentState: "active" }), "incident.rejected_states"],
  ])("rejects proposals violating the %s hard limit", (_name, proposal, ruleId) => {
    const result = evaluateTreasuryReallocation(proposal);
    expect(result.decision).toBe("rejected");
    expect(result.blockedRules).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId, effect: "reject" })]),
    );
  });

  it("rejects denied assets and protocols configured by treasury", () => {
    const policy = makePolicy({
      assetExposure: {
        ...DEFAULT_TREASURY_REALLOCATION_POLICY.assetExposure,
        denied: ["RISKY"],
      },
      protocolExposure: {
        ...DEFAULT_TREASURY_REALLOCATION_POLICY.protocolExposure,
        denied: ["Compromised"],
      },
    });
    const result = evaluateTreasuryReallocation(
      makeProposal({
        assetExposurePct: { RISKY: 1 },
        protocolExposurePct: { Compromised: 1 },
      }),
      policy,
    );

    expect(result.decision).toBe("rejected");
    expect(result.blockedRules.map((rule) => rule.ruleId)).toEqual([
      "asset_exposure.denied",
      "protocol_exposure.denied",
    ]);
  });

  it("returns byte-for-byte equivalent evaluations for the same input", () => {
    const proposal = makeProposal({
      assetExposurePct: { Z: 30, A: 31 },
      protocolExposurePct: { Zeta: 35, Alpha: 36 },
    });

    const first = evaluateTreasuryReallocation(proposal);
    const second = evaluateTreasuryReallocation(proposal);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.blockedRules.map((rule) => String(rule.actual))).toEqual([
      "31",
      "30",
      "36",
      "35",
    ]);
  });

  it("rejects invalid and internally inconsistent inputs before evaluation", () => {
    expect(() =>
      evaluateTreasuryReallocation(makeProposal({ amountUsd: Number.NaN })),
    ).toThrow("proposal.amountUsd");
    expect(() =>
      evaluateTreasuryReallocation(
        makeProposal(),
        makePolicy({
          size: {
            ...DEFAULT_TREASURY_REALLOCATION_POLICY.size,
            maxAutoApprovedAmountUsd: 2_000_000,
          },
        }),
      ),
    ).toThrow("maxAutoApprovedAmountUsd");
  });
});

describe("executeTreasuryReallocation", () => {
  it("executes auto-approved proposals without manual approval", async () => {
    const executor = jest.fn(async () => ({ transactionHash: "tx-auto" }));

    const result = await executeTreasuryReallocation(makeProposal(), executor);

    expect(result).toEqual(
      expect.objectContaining({
        status: "executed",
        approvalMode: "automatic",
        executionResult: { transactionHash: "tx-auto" },
      }),
    );
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("pauses an approval-required proposal and returns actionable rules", async () => {
    const executor = jest.fn(async () => ({ transactionHash: "should-not-run" }));

    const result = await executeTreasuryReallocation(
      makeProposal({ amountUsd: 150_000 }),
      executor,
    );

    expect(result.status).toBe("approval_required");
    expect(result.evaluation.blockedRules[0]).toEqual(
      expect.objectContaining({
        ruleId: "size.max_auto_approved_amount_usd",
        actual: 150_000,
        threshold: 100_000,
      }),
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("executes an approval-required proposal after attributable manual approval", async () => {
    const executor = jest.fn(async () => ({ transactionHash: "tx-manual" }));

    const result = await executeTreasuryReallocation(
      makeProposal({ amountUsd: 150_000 }),
      executor,
      {
        manualApproval: {
          approvedBy: "treasury-operator-1",
          approvedAt: "2026-08-26T10:00:00.000Z",
        },
      },
    );

    expect(result).toEqual(
      expect.objectContaining({ status: "executed", approvalMode: "manual" }),
    );
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("never executes rejected proposals, even when manual approval is supplied", async () => {
    const executor = jest.fn(async () => ({ transactionHash: "should-not-run" }));

    const result = await executeTreasuryReallocation(
      makeProposal({ recentIncidentState: "critical" }),
      executor,
      {
        manualApproval: {
          approvedBy: "treasury-operator-1",
          approvedAt: "2026-08-26T10:00:00.000Z",
        },
      },
    );

    expect(result.status).toBe("rejected");
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("POST /api/treasury/reallocations/evaluate", () => {
  const app = createApp();

  it.each([
    [makeProposal(), 200, "auto_approved"],
    [makeProposal({ amountUsd: 150_000 }), 202, "approval_required"],
    [makeProposal({ recentIncidentState: "critical" }), 422, "rejected"],
  ])("returns the policy decision as an actionable HTTP response", async (proposal, status, decision) => {
    const response = await request(app)
      .post("/api/treasury/reallocations/evaluate")
      .send({ proposal });

    expect(response.status).toBe(status);
    expect(response.body.decision).toBe(decision);
    if (decision !== "auto_approved") {
      expect(response.body.blockedRules[0]).toEqual(
        expect.objectContaining({ ruleId: expect.any(String), message: expect.any(String) }),
      );
    }
  });

  it("returns a 400 response for malformed proposals", async () => {
    const response = await request(app)
      .post("/api/treasury/reallocations/evaluate")
      .send({ proposal: { id: "incomplete" } });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({ error: "INVALID_REALLOCATION", message: expect.any(String) }),
    );
  });
});
