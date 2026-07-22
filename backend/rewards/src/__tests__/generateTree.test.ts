import {
  calculateRewards,
  generateWeeklyDistribution,
  getUserProof,
  type UserRewardInput,
  type RewardDistributionContext,
} from "../generateTree";
import {
  verifyProof,
  computeLeaf,
  ZERO_METADATA_HASH,
} from "../merkleTree";
import fixture from "./fixtures/rewardMerkleVectors.json";

const context: RewardDistributionContext = {
  token: "CTOKEN",
  campaignId: 7,
};

// ── calculateRewards ────────────────────────────────────────────────────

describe("calculateRewards", () => {
  it("distributes proportionally based on shares", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "500", totalShares: "1000" },
      { address: "G2", shares: "300", totalShares: "1000" },
      { address: "G3", shares: "200", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000", context);
    expect(entries).toHaveLength(3);
    expect(entries[0].amount).toBe("5000");
    expect(entries[1].amount).toBe("3000");
    expect(entries[2].amount).toBe("2000");
  });

  it("attaches the distribution context to each reward entry", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "500", totalShares: "1000" },
      { address: "G2", shares: "500", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000", {
      token: "CTOKEN",
      campaignId: 13,
      metadataHash: "a".repeat(64),
    });
    expect(entries[0].token).toBe("CTOKEN");
    expect(entries[0].campaignId).toBe(13);
    expect(entries[0].metadataHash).toBe("a".repeat(64));
    expect(entries[1].campaignId).toBe(13);
  });

  it("skips users with zero shares", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "0", totalShares: "1000" },
      { address: "G2", shares: "500", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000", context);
    expect(entries).toHaveLength(1);
    expect(entries[0].address).toBe("G2");
  });

  it("skips users with negative shares", () => {
    const users: UserRewardInput[] = [
      { address: "G1", shares: "-100", totalShares: "1000" },
      { address: "G2", shares: "500", totalShares: "1000" },
    ];
    const entries = calculateRewards(users, "10000", context);
    expect(entries).toHaveLength(1);
  });

  it("returns empty for no users", () => {
    const entries = calculateRewards([], "10000", context);
    expect(entries).toHaveLength(0);
  });

  it("handles very large amounts", () => {
    const users: UserRewardInput[] = [
      {
        address: "G1",
        shares: "1000000000000",
        totalShares: "2000000000000",
      },
    ];
    const entries = calculateRewards(users, "5000000000000", context);
    expect(entries[0].amount).toBe("2500000000000");
  });
});

// ── generateWeeklyDistribution ──────────────────────────────────────────

describe("generateWeeklyDistribution", () => {
  it("produces a valid distribution with root and claims", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
      { address: "GADDR2", shares: "300", totalShares: "1000" },
      { address: "GADDR3", shares: "200", totalShares: "1000" },
    ];
    const result = generateWeeklyDistribution(users, "10000", context);

    expect(result.root).toHaveLength(64);
    expect(Object.keys(result.claims)).toHaveLength(3);
    expect(result.claims["GADDR1"].amount).toBe("5000");
    expect(result.claims["GADDR2"].amount).toBe("3000");
    expect(result.claims["GADDR3"].amount).toBe("2000");
    expect(result.claims["GADDR1"].campaignId).toBe(7);
  });

  it("produces verifiable proofs for all users", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
      { address: "GADDR2", shares: "300", totalShares: "1000" },
      { address: "GADDR3", shares: "200", totalShares: "1000" },
    ];
    const result = generateWeeklyDistribution(users, "10000", context);

    for (const [address, claim] of Object.entries(result.claims)) {
      const valid = verifyProof(
        result.root,
        address,
        claim.token,
        claim.amount,
        claim.campaignId,
        claim.metadataHash,
        claim.proof,
      );
      expect(valid).toBe(true);
    }
  });

  it("returns empty distribution when all shares are zero", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "0", totalShares: "1000" },
    ];
    const result = generateWeeklyDistribution(users, "10000", context);
    expect(result.root).toBe("0".repeat(64));
    expect(Object.keys(result.claims)).toHaveLength(0);
  });

  it("matches the shared fixture vectors for a campaign-aware distribution", () => {
    const users: UserRewardInput[] = [
      {
        address: fixture.entries[0].address,
        shares: "500",
        totalShares: "1000",
      },
      {
        address: fixture.entries[1].address,
        shares: "300",
        totalShares: "1000",
      },
      {
        address: fixture.entries[2].address,
        shares: "200",
        totalShares: "1000",
      },
    ];
    const result = generateWeeklyDistribution(users, "10000", fixture.distribution);

    expect(result.root).toBe(fixture.root);
    for (const [address, claim] of Object.entries(result.claims)) {
      const fixtureClaim = fixture.claims[address];
      expect(claim).toEqual({
        index: fixtureClaim.index,
        address: fixtureClaim.address,
        token: fixtureClaim.token,
        amount: fixtureClaim.amount,
        campaignId: fixtureClaim.campaignId,
        metadataHash: fixtureClaim.metadataHash,
        proof: fixtureClaim.proof,
      });
      expect(
        computeLeaf(
          claim.address,
          claim.token,
          claim.amount,
          claim.campaignId,
          claim.metadataHash,
        ).toString("hex"),
      ).toBe(fixtureClaim.leaf);
    }
  });
});

// ── getUserProof ────────────────────────────────────────────────────────

describe("getUserProof", () => {
  it("returns proof for existing user", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
      { address: "GADDR2", shares: "500", totalShares: "1000" },
    ];
    const dist = generateWeeklyDistribution(users, "10000", {
      token: "CTOKEN",
      campaignId: 7,
    });
    const proof = getUserProof("GADDR1", dist);

    expect(proof).not.toBeNull();
    expect(proof!.index).toBe(0);
    expect(proof!.token).toBe("CTOKEN");
    expect(proof!.amount).toBe("5000");
    expect(proof!.metadataHash).toBe(ZERO_METADATA_HASH);
    expect(proof!.proof).toBeInstanceOf(Array);
  });

  it("returns null for non-existent user", () => {
    const users: UserRewardInput[] = [
      { address: "GADDR1", shares: "500", totalShares: "1000" },
    ];
    const dist = generateWeeklyDistribution(users, "10000", context);
    const proof = getUserProof("GNONEXISTENT", dist);

    expect(proof).toBeNull();
  });
});
