import { simulateCampaignDryRun, type CampaignDryRunInput } from "../dryRunSimulator";

const NOW = 1_700_000_000; // fixed reference "now" for deterministic tests

function baseInput(overrides: Partial<CampaignDryRunInput> = {}): CampaignDryRunInput {
  return {
    segments: [
      {
        name: "early-adopters",
        recipients: [
          { address: "GAAA1111111111111111111111111111111111111111111111", amount: "1000" },
          { address: "GBBB2222222222222222222222222222222222222222222222", amount: "2000" },
        ],
      },
      {
        name: "top-holders",
        recipients: [
          { address: "GCCC3333333333333333333333333333333333333333333333", amount: "7000" },
        ],
      },
    ],
    totalBudget: "10000",
    claimWindow: { startTimestamp: NOW, endTimestamp: NOW + 7 * 24 * 3600 },
    now: NOW,
    ...overrides,
  };
}

describe("simulateCampaignDryRun — valid campaigns", () => {
  it("is ok with no errors for a well-formed campaign", () => {
    const report = simulateCampaignDryRun(baseInput());

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.totalRecipients).toBe(3);
    expect(report.totalAllocated).toBe("10000");
    expect(report.budgetRemaining).toBe("0");
  });

  it("includes proof generation input (Merkle root + per-recipient proofs) when clean", () => {
    const report = simulateCampaignDryRun(baseInput());

    expect(report.proofInput).toBeDefined();
    expect(report.proofInput?.root).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(report.proofInput?.claims ?? {})).toHaveLength(3);
    expect(
      report.proofInput?.claims["GAAA1111111111111111111111111111111111111111111111"],
    ).toEqual({ index: 0, amount: "1000", proof: expect.any(Array) });
  });

  it("is deterministic — identical input produces an identical report", () => {
    const input = baseInput();
    const a = simulateCampaignDryRun(input);
    const b = simulateCampaignDryRun(input);

    expect(a).toEqual(b);
  });

  it("warns (but does not block) when a small fraction of the budget is allocated", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        segments: [
          {
            name: "early-adopters",
            recipients: [
              { address: "GAAA1111111111111111111111111111111111111111111111", amount: "50" },
            ],
          },
        ],
        totalBudget: "1000000",
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings.some((w) => w.code === "LOW_BUDGET_UTILIZATION")).toBe(true);
  });
});

describe("simulateCampaignDryRun — duplicate recipients", () => {
  it("blocks when the same address appears twice within one segment", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        segments: [
          {
            name: "early-adopters",
            recipients: [
              { address: "GAAA1111111111111111111111111111111111111111111111", amount: "100" },
              { address: "GAAA1111111111111111111111111111111111111111111111", amount: "200" },
            ],
          },
        ],
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "DUPLICATE_RECIPIENT" }),
    ]);
    expect(report.proofInput).toBeUndefined();
  });

  it("blocks when the same address appears across two different segments", () => {
    const shared = "GDDD4444444444444444444444444444444444444444444444";
    const report = simulateCampaignDryRun(
      baseInput({
        segments: [
          { name: "early-adopters", recipients: [{ address: shared, amount: "100" }] },
          { name: "top-holders", recipients: [{ address: shared, amount: "200" }] },
        ],
      }),
    );

    expect(report.ok).toBe(false);
    const dup = report.errors.find((e) => e.code === "DUPLICATE_RECIPIENT");
    expect(dup?.context?.segments).toEqual(["early-adopters", "top-holders"]);
  });

  it("treats addresses as case-insensitively equal for duplicate detection", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        segments: [
          {
            name: "early-adopters",
            recipients: [
              { address: "gaaa1111111111111111111111111111111111111111111111", amount: "100" },
              { address: "GAAA1111111111111111111111111111111111111111111111", amount: "200" },
            ],
          },
        ],
      }),
    );

    expect(report.errors.some((e) => e.code === "DUPLICATE_RECIPIENT")).toBe(true);
  });
});

describe("simulateCampaignDryRun — exhausted / invalid budget", () => {
  it("blocks when allocated amounts exceed the total budget", () => {
    const report = simulateCampaignDryRun(baseInput({ totalBudget: "5000" }));

    expect(report.ok).toBe(false);
    const overBudget = report.errors.find((e) => e.code === "BUDGET_EXCEEDED");
    expect(overBudget).toBeDefined();
    expect(overBudget?.context).toMatchObject({
      totalAllocated: "10000",
      totalBudget: "5000",
      overage: "5000",
    });
    expect(report.proofInput).toBeUndefined();
  });

  it("reports the exact overage and remaining-budget figures", () => {
    const report = simulateCampaignDryRun(baseInput({ totalBudget: "9999" }));

    expect(report.totalAllocated).toBe("10000");
    expect(report.totalBudget).toBe("9999");
    expect(report.budgetRemaining).toBe("-1");
  });

  it("blocks on a non-numeric totalBudget", () => {
    const report = simulateCampaignDryRun(baseInput({ totalBudget: "not-a-number" }));

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "INVALID_BUDGET")).toBe(true);
  });

  it("blocks on a non-numeric or non-positive recipient amount", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        segments: [
          {
            name: "early-adopters",
            recipients: [
              { address: "GAAA1111111111111111111111111111111111111111111111", amount: "abc" },
              { address: "GBBB2222222222222222222222222222222222222222222222", amount: "0" },
            ],
          },
        ],
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors.filter((e) => e.code === "INVALID_AMOUNT")).toHaveLength(2);
  });
});

describe("simulateCampaignDryRun — empty segments", () => {
  it("blocks when a segment has no recipients", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        segments: [
          { name: "early-adopters", recipients: [] },
          {
            name: "top-holders",
            recipients: [
              { address: "GCCC3333333333333333333333333333333333333333333333", amount: "100" },
            ],
          },
        ],
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(
      expect.objectContaining({ code: "EMPTY_SEGMENT", context: { segment: "early-adopters" } }),
    );
  });
});

describe("simulateCampaignDryRun — invalid claim windows", () => {
  it("blocks when the end timestamp is before the start timestamp", () => {
    const report = simulateCampaignDryRun(
      baseInput({ claimWindow: { startTimestamp: NOW + 1000, endTimestamp: NOW } }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "INVALID_CLAIM_WINDOW")).toBe(true);
  });

  it("blocks when the end timestamp equals the start timestamp", () => {
    const report = simulateCampaignDryRun(
      baseInput({ claimWindow: { startTimestamp: NOW, endTimestamp: NOW } }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "INVALID_CLAIM_WINDOW")).toBe(true);
  });

  it("blocks when the claim window has already ended relative to now", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        claimWindow: { startTimestamp: NOW - 10_000, endTimestamp: NOW - 1000 },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "INVALID_CLAIM_WINDOW")).toBe(true);
  });

  it("blocks on non-finite timestamps", () => {
    const report = simulateCampaignDryRun(
      baseInput({
        claimWindow: { startTimestamp: NaN, endTimestamp: NOW + 1000 },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "INVALID_CLAIM_WINDOW")).toBe(true);
  });

  it("warns (but does not block) on a very short claim window", () => {
    const report = simulateCampaignDryRun(
      baseInput({ claimWindow: { startTimestamp: NOW, endTimestamp: NOW + 60 } }),
    );

    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.code === "SHORT_CLAIM_WINDOW")).toBe(true);
  });
});

describe("simulateCampaignDryRun — mixed failures", () => {
  it("reports every blocking issue at once, not just the first", () => {
    const report = simulateCampaignDryRun({
      segments: [
        { name: "empty-segment", recipients: [] },
        {
          name: "over-budget",
          recipients: [
            { address: "GAAA1111111111111111111111111111111111111111111111", amount: "999999" },
          ],
        },
      ],
      totalBudget: "100",
      claimWindow: { startTimestamp: NOW, endTimestamp: NOW - 1 },
      now: NOW,
    });

    const codes = report.errors.map((e) => e.code).sort();
    expect(codes).toEqual(
      ["BUDGET_EXCEEDED", "EMPTY_SEGMENT", "INVALID_CLAIM_WINDOW"].sort(),
    );
    expect(report.ok).toBe(false);
  });
});
