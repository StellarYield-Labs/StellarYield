import {
  generateMerkleTree,
  verifyProof,
  computeLeaf,
  hashPair,
  normalizeMetadataHash,
  ZERO_METADATA_HASH,
  type RewardEntry,
} from "../merkleTree";
import fixture from "./fixtures/rewardMerkleVectors.json";

// ── computeLeaf ─────────────────────────────────────────────────────────

describe("computeLeaf", () => {
  it("produces a 32-byte buffer", () => {
    const leaf = computeLeaf(
      "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      "CTOKEN",
      "1000",
      7,
      "a".repeat(64),
    );
    expect(leaf.length).toBe(32);
  });

  it("produces different hashes for different tokens", () => {
    const a = computeLeaf("GABCDEF", "CTOKEN_A", "1000", 7, ZERO_METADATA_HASH);
    const b = computeLeaf("GABCDEF", "CTOKEN_B", "1000", 7, ZERO_METADATA_HASH);
    expect(a.equals(b)).toBe(false);
  });

  it("produces different hashes for different addresses", () => {
    const a = computeLeaf("GABCDEF", "CTOKEN", "1000", 7, ZERO_METADATA_HASH);
    const b = computeLeaf("GXYZ123", "CTOKEN", "1000", 7, ZERO_METADATA_HASH);
    expect(a.equals(b)).toBe(false);
  });

  it("produces different hashes for different amounts", () => {
    const a = computeLeaf("GABCDEF", "CTOKEN", "1000", 7, ZERO_METADATA_HASH);
    const b = computeLeaf("GABCDEF", "CTOKEN", "2000", 7, ZERO_METADATA_HASH);
    expect(a.equals(b)).toBe(false);
  });

  it("produces different hashes for different campaign IDs", () => {
    const a = computeLeaf("GABCDEF", "CTOKEN", "1000", 7, ZERO_METADATA_HASH);
    const b = computeLeaf("GABCDEF", "CTOKEN", "1000", 8, ZERO_METADATA_HASH);
    expect(a.equals(b)).toBe(false);
  });

  it("produces different hashes for different metadata hashes", () => {
    const a = computeLeaf("GABCDEF", "CTOKEN", "1000", 7, "1".repeat(64));
    const b = computeLeaf("GABCDEF", "CTOKEN", "1000", 7, "2".repeat(64));
    expect(a.equals(b)).toBe(false);
  });

  it("is deterministic", () => {
    const a = computeLeaf("GABCDEF", "CTOKEN", "999", 7, ZERO_METADATA_HASH);
    const b = computeLeaf("GABCDEF", "CTOKEN", "999", 7, ZERO_METADATA_HASH);
    expect(a.equals(b)).toBe(true);
  });
});

describe("normalizeMetadataHash", () => {
  it("defaults to the zero hash when metadata is omitted", () => {
    expect(normalizeMetadataHash()).toBe(ZERO_METADATA_HASH);
  });

  it("normalizes 0x-prefixed metadata hashes", () => {
    expect(normalizeMetadataHash(`0x${"a".repeat(64)}`)).toBe("a".repeat(64));
  });
});

// ── hashPair ────────────────────────────────────────────────────────────

describe("hashPair", () => {
  it("produces a 32-byte buffer", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const result = hashPair(a, b);
    expect(result.length).toBe(32);
  });

  it("is commutative (sorted-pair hashing)", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    expect(hashPair(a, b).equals(hashPair(b, a))).toBe(true);
  });

  it("produces different hashes for different inputs", () => {
    const a = Buffer.alloc(32, 1);
    const b = Buffer.alloc(32, 2);
    const c = Buffer.alloc(32, 3);
    expect(hashPair(a, b).equals(hashPair(a, c))).toBe(false);
  });
});

// ── generateMerkleTree ──────────────────────────────────────────────────

describe("generateMerkleTree", () => {
  it("returns a zero root for empty entries", () => {
    const result = generateMerkleTree([]);
    expect(result.root).toBe("0".repeat(64));
    expect(Object.keys(result.claims)).toHaveLength(0);
  });

  it("returns a valid root for a single entry", () => {
    const entries: RewardEntry[] = [
      {
        address: "GABCDEF",
        token: "CTOKEN",
        amount: "1000",
        campaignId: 7,
      },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);
    expect(result.claims["GABCDEF"]).toBeDefined();
    expect(result.claims["GABCDEF"].index).toBe(0);
    expect(result.claims["GABCDEF"].proof).toHaveLength(0);
  });

  it("returns valid proofs for two entries", () => {
    const entries: RewardEntry[] = [
      {
        address: "GADDR1",
        token: "CTOKEN",
        amount: "500",
        campaignId: 7,
      },
      {
        address: "GADDR2",
        token: "CTOKEN",
        amount: "300",
        campaignId: 7,
      },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);

    // Each claim should have exactly one proof element (the sibling leaf)
    expect(result.claims["GADDR1"].proof).toHaveLength(1);
    expect(result.claims["GADDR2"].proof).toHaveLength(1);
  });

  it("returns valid proofs for four entries", () => {
    const entries: RewardEntry[] = [
      { address: "G1", token: "CTOKEN", amount: "100", campaignId: 7 },
      { address: "G2", token: "CTOKEN", amount: "200", campaignId: 7 },
      { address: "G3", token: "CTOKEN", amount: "300", campaignId: 7 },
      { address: "G4", token: "CTOKEN", amount: "400", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);

    // 4-leaf tree has depth 2, so each proof should have 2 elements
    expect(result.claims["G1"].proof).toHaveLength(2);
    expect(result.claims["G2"].proof).toHaveLength(2);
    expect(result.claims["G3"].proof).toHaveLength(2);
    expect(result.claims["G4"].proof).toHaveLength(2);
  });

  it("handles odd number of entries (3 leaves)", () => {
    const entries: RewardEntry[] = [
      { address: "GA", token: "CTOKEN", amount: "100", campaignId: 7 },
      { address: "GB", token: "CTOKEN", amount: "200", campaignId: 7 },
      { address: "GC", token: "CTOKEN", amount: "300", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);
    expect(Object.keys(result.claims)).toHaveLength(3);
  });

  it("handles large set of entries (100 users)", () => {
    const entries: RewardEntry[] = Array.from({ length: 100 }, (_, i) => ({
      address: `GADDR${i.toString().padStart(3, "0")}`,
      token: "CTOKEN",
      amount: ((i + 1) * 1000).toString(),
      campaignId: 7,
    }));
    const result = generateMerkleTree(entries);
    expect(result.root).toHaveLength(64);
    expect(Object.keys(result.claims)).toHaveLength(100);
  });

  it("matches the shared fixture vectors exactly", () => {
    const result = generateMerkleTree(fixture.entries);
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

// ── verifyProof ─────────────────────────────────────────────────────────

describe("verifyProof", () => {
  it("verifies a valid single-leaf proof", () => {
    const entries: RewardEntry[] = [
      {
        address: "GABCDEF",
        token: "CTOKEN",
        amount: "1000",
        campaignId: 7,
      },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["GABCDEF"];
    const valid = verifyProof(
      result.root,
      claim.address,
      claim.token,
      claim.amount,
      claim.campaignId,
      claim.metadataHash,
      claim.proof,
    );
    expect(valid).toBe(true);
  });

  it("verifies valid proofs for all entries in a multi-leaf tree", () => {
    const entries: RewardEntry[] = [
      { address: "G1", token: "CTOKEN", amount: "100", campaignId: 7 },
      { address: "G2", token: "CTOKEN", amount: "200", campaignId: 7 },
      { address: "G3", token: "CTOKEN", amount: "300", campaignId: 7 },
      { address: "G4", token: "CTOKEN", amount: "400", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);

    for (const entry of entries) {
      const claim = result.claims[entry.address];
      const valid = verifyProof(
        result.root,
        entry.address,
        entry.token,
        claim.amount,
        entry.campaignId,
        claim.metadataHash,
        claim.proof,
      );
      expect(valid).toBe(true);
    }
  });

  it("rejects a proof with wrong amount", () => {
    const entries: RewardEntry[] = [
      { address: "G1", token: "CTOKEN", amount: "100", campaignId: 7 },
      { address: "G2", token: "CTOKEN", amount: "200", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      result.root,
      "G1",
      claim.token,
      "999",
      claim.campaignId,
      claim.metadataHash,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof with wrong address", () => {
    const entries: RewardEntry[] = [
      { address: "G1", token: "CTOKEN", amount: "100", campaignId: 7 },
      { address: "G2", token: "CTOKEN", amount: "200", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      result.root,
      "GWRONG",
      claim.token,
      claim.amount,
      claim.campaignId,
      claim.metadataHash,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof with wrong campaign", () => {
    const entries: RewardEntry[] = [
      { address: "G1", token: "CTOKEN", amount: "100", campaignId: 7 },
      { address: "G2", token: "CTOKEN", amount: "200", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      result.root,
      "G1",
      claim.token,
      claim.amount,
      99,
      claim.metadataHash,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof with wrong metadata hash", () => {
    const result = generateMerkleTree(fixture.entries);
    const claim =
      result.claims["GALICE1111111111111111111111111111111111111111111111111"];
    const valid = verifyProof(
      result.root,
      claim.address,
      claim.token,
      claim.amount,
      claim.campaignId,
      "2".repeat(64),
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("rejects a proof against a wrong root", () => {
    const entries: RewardEntry[] = [
      { address: "G1", token: "CTOKEN", amount: "100", campaignId: 7 },
    ];
    const result = generateMerkleTree(entries);
    const claim = result.claims["G1"];
    const valid = verifyProof(
      "f".repeat(64),
      "G1",
      claim.token,
      claim.amount,
      claim.campaignId,
      claim.metadataHash,
      claim.proof,
    );
    expect(valid).toBe(false);
  });

  it("verifies proofs for 100 users", () => {
    const entries: RewardEntry[] = Array.from({ length: 100 }, (_, i) => ({
      address: `GADDR${i.toString().padStart(3, "0")}`,
      token: "CTOKEN",
      amount: ((i + 1) * 1000).toString(),
      campaignId: 7,
    }));
    const result = generateMerkleTree(entries);

    for (const entry of entries) {
      const claim = result.claims[entry.address];
      const valid = verifyProof(
        result.root,
        entry.address,
        entry.token,
        claim.amount,
        entry.campaignId,
        claim.metadataHash,
        claim.proof,
      );
      expect(valid).toBe(true);
    }
  });
});
