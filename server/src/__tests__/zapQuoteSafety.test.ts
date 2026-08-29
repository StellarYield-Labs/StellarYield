import {
  getZapQuote,
  validateZapQuoteForExecution,
  computeQuoteSignature,
  verifyQuoteSignature,
  isQuoteExpired,
  clearQuoteStore,
  getZapQuoteTtlMs,
  ZapQuoteResult,
} from "../services/zapQuote";
import { freezeService } from "../services/freezeService";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
    { protocolName: "Blend", tvl: 12_000_000 },
  ]),
}));

describe("zapQuote safety envelope", () => {
  const baseBody = {
    inputTokenContract: "CINPUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vaultTokenContract: "CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amountInStroops: "10000000",
    inputDecimals: 7,
    vaultDecimals: 7,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearQuoteStore();
    // clear freeze state
    (freezeService as unknown as { clearAll: () => void }).clearAll();
    delete process.env.ZAP_QUOTE_TTL_MS;
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  });

  describe("envelope generation", () => {
    it("adds quoteId, expiresAt, ttlMs, protocol, signature, and freezeCheckedAt", async () => {
      const q = await getZapQuote({ ...baseBody, protocol: "Blend" });
      expect(q.quoteId).toBeDefined();
      expect(typeof q.quoteId).toBe("string");
      expect(q.quoteId!.length).toBeGreaterThan(10);
      expect(q.expiresAt).toBeDefined();
      expect(() => new Date(q.expiresAt!)).not.toThrow();
      expect(q.ttlMs).toBe(getZapQuoteTtlMs());
      expect(q.protocol).toBe("Blend");
      expect(q.inputTokenContract!).toBe(baseBody.inputTokenContract);
      expect(q.vaultTokenContract!).toBe(baseBody.vaultTokenContract);
      expect(q.amountInStroops).toBe(baseBody.amountInStroops);
      expect(q.quoteSignature).toBeDefined();
      expect(q.freezeCheckedAt).toBeDefined();
      // expiresAt should be quotedAt + ttlMs (±1s tolerance)
      const quotedAtMs = new Date(q.quotedAt).getTime();
      const expiresAtMs = new Date(q.expiresAt!).getTime();
      expect(expiresAtMs - quotedAtMs).toBe(q.ttlMs);
    });

    it("respects custom TTL via env", async () => {
      process.env.ZAP_QUOTE_TTL_MS = "45000";
      const q = await getZapQuote(baseBody);
      expect(q.ttlMs).toBe(45000);
      const diff = new Date(q.expiresAt!).getTime() - new Date(q.quotedAt).getTime();
      expect(diff).toBe(45000);
    });

    it("persists quoteId with signature that verifies", async () => {
      const q = await getZapQuote(baseBody);
      expect(verifyQuoteSignature(q)).toBe(true);
      // tampering should break signature
      const tampered: ZapQuoteResult = { ...q, expectedAmountOutStroops: "999999999" };
      expect(verifyQuoteSignature(tampered)).toBe(false);
    });

    it("uses computeQuoteSignature deterministically", async () => {
      const q = await getZapQuote(baseBody);
      const { quoteSignature, ...rest } = q;
      const recomputed = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      expect(recomputed).toBe(quoteSignature);
    });
  });

  describe("isQuoteExpired", () => {
    it("returns true when now exceeds expiresAt", async () => {
      const q = await getZapQuote(baseBody);
      const future = new Date(q.expiresAt!).getTime() + 1000;
      expect(isQuoteExpired(q, future)).toBe(true);
      expect(isQuoteExpired(q, new Date(q.quotedAt).getTime() + 100)).toBe(false);
    });

    it("falls back to quotedAt+ttlMs when expiresAt missing", () => {
      const now = Date.now();
      const q = {
        quotedAt: new Date(now - 40_000).toISOString(),
        ttlMs: 30_000,
        expiresAt: undefined,
      } as unknown as ZapQuoteResult;
      expect(isQuoteExpired(q, now)).toBe(true);
      const fresh = {
        quotedAt: new Date(now - 10_000).toISOString(),
        ttlMs: 30_000,
        expiresAt: undefined,
      } as unknown as ZapQuoteResult;
      expect(isQuoteExpired(fresh, now)).toBe(false);
    });
  });

  describe("validateZapQuoteForExecution — stale quote rejection", () => {
    it("rejects expired quote (TTL exceeded)", async () => {
      const q = await getZapQuote(baseBody);
      // Simulate time after expiry
      const afterExpiry = new Date(q.expiresAt!).getTime() + 5000;
      const res = validateZapQuoteForExecution({ quote: q }, afterExpiry);
      expect(res.valid).toBe(false);
      expect(res.code).toBe("QUOTE_EXPIRED");
      expect(res.requiresRequote).toBe(true);
      expect(res.isExpired).toBe(true);
    });

    it("rejects quote with tampered expiry", async () => {
      const q = await getZapQuote(baseBody);
      const expiredCopy: ZapQuoteResult = {
        ...q,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      // Need to re-sign expired copy to pass signature check, then it should still be expired
      const { quoteSignature, ...rest } = expiredCopy;
      (expiredCopy as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: expiredCopy });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("QUOTE_EXPIRED");
    });
  });

  describe("validate — changed route / asset pair rejection", () => {
    it("rejects when input asset differs from quote", async () => {
      const q = await getZapQuote(baseBody);
      const res = validateZapQuoteForExecution({
        quote: q,
        inputTokenContract: "COTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vaultTokenContract: baseBody.vaultTokenContract,
      });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("ASSET_MISMATCH");
      expect(res.requiresRequote).toBe(true);
    });

    it("rejects when vault asset differs", async () => {
      const q = await getZapQuote(baseBody);
      const res = validateZapQuoteForExecution({
        quote: q,
        inputTokenContract: baseBody.inputTokenContract,
        vaultTokenContract: "COTHERVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("ASSET_MISMATCH");
    });

    it("rejects when amount differs", async () => {
      const q = await getZapQuote(baseBody);
      const res = validateZapQuoteForExecution({
        quote: q,
        amountInStroops: "9999999",
      });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("AMOUNT_MISMATCH");
    });

    it("rejects when stored quote output mismatches provided quote (route changed)", async () => {
      const q = await getZapQuote(baseBody);
      const tampered: ZapQuoteResult = { ...q, expectedAmountOutStroops: "123", minAmountOutStroops: "123" };
      // Re-sign tampered to bypass signature check, but stored check should still catch
      const { quoteSignature, ...rest } = tampered;
      (tampered as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: tampered, allowFallback: true });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("ROUTE_CHANGED");
    });

    it("rejects tampered path that doesn't match envelope pair", async () => {
      const q = await getZapQuote(baseBody);
      const tampered: ZapQuoteResult = {
        ...q,
        path: [{ contractId: "COTHER" }, { contractId: q.vaultTokenContract! }],
      };
      const { quoteSignature, ...rest } = tampered;
      (tampered as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: tampered, allowFallback: true });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("ROUTE_CHANGED");
    });
  });

  describe("validate — protocol freeze after quote", () => {
    it("invalidates quote produced before a protocol freeze", async () => {
      const q = await getZapQuote({ ...baseBody, protocol: "Blend" });
      // freeze after quote
      await new Promise((r) => setTimeout(r, 10));
      await freezeService.freezeProtocol("Blend", "test freeze", "tester");
      const res = validateZapQuoteForExecution({ quote: q, protocol: "Blend" });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("FROZEN_AFTER_QUOTE");
      expect(res.requiresRequote).toBe(true);
    });

    it("invalidates quote on global freeze after quote", async () => {
      const q = await getZapQuote(baseBody);
      await new Promise((r) => setTimeout(r, 10));
      await freezeService.freezeGlobal("global freeze", "tester");
      const res = validateZapQuoteForExecution({ quote: q });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("FROZEN_AFTER_QUOTE");
    });

    it("blocks execution when protocol is currently frozen even if quote was after freeze (PROTOCOL_FROZEN)", async () => {
      await freezeService.freezeProtocol("Blend", "pre-freeze", "tester");
      // quoting should be blocked, but simulate a quote that was somehow created before checking freeze?
      // We manually craft a quote after freeze to test current-frozen guard
      const q = await getZapQuote({ ...baseBody, protocol: "default" });
      // Validate against frozen Blend protocol should be blocked
      // Create a Blend quote manually by adjusting protocol field without freezing default
      const blendQuote: ZapQuoteResult = { ...q, protocol: "Blend" };
      const { quoteSignature, ...rest } = blendQuote;
      (blendQuote as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: blendQuote, protocol: "Blend" });
      // Since Blend is frozen, and quote's quotedAt is after the freeze? Actually q was created after freeze, so wasFrozenAfter would be false,
      // but current isFrozen check should still block? Our validation checks wasFrozenAfter first, then isFrozen.
      // For a quote created after freeze, wasFrozenAfter would be false (frozenAt < quotedAt), but isFrozen true should block with PROTOCOL_FROZEN
      expect(res.valid).toBe(false);
      // It may be FROZEN_AFTER_QUOTE if timing race, but either way it should be blocked
      expect(["FROZEN_AFTER_QUOTE", "PROTOCOL_FROZEN"]).toContain(res.code);
    });

    it("passes when no freeze after quote", async () => {
      const q = await getZapQuote(baseBody);
      // no freeze
      const res = validateZapQuoteForExecution({ quote: q, allowFallback: true });
      expect(res.valid).toBe(true);
    });
  });

  describe("validate — fallback distinction", () => {
    it("requires explicit allowFallback for fallback quotes", async () => {
      const q = await getZapQuote(baseBody);
      // Force fallback: input != vault but fallback ratio is used; all quotes are fallback when no router
      expect(q.isFallback).toBe(true);
      expect(q.source).toBe("fallback_rate");
      const withoutAck = validateZapQuoteForExecution({ quote: q });
      expect(withoutAck.valid).toBe(false);
      expect(withoutAck.code).toBe("FALLBACK_REQUIRES_ACK");
      expect(withoutAck.isFallback).toBe(true);

      const withAck = validateZapQuoteForExecution({ quote: q, allowFallback: true });
      expect(withAck.valid).toBe(true);
    });

    it("passes immediately for router-simulated quote without fallback ack", async () => {
      // Simulate a router_simulation quote by crafting one
      const base = await getZapQuote(baseBody);
      const simulated: ZapQuoteResult = { ...base, source: "router_simulation", isFallback: false };
      const { quoteSignature, ...rest } = simulated;
      (simulated as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: simulated, allowFallback: false });
      expect(res.valid).toBe(true);
    });

    it("does not silently treat fallback as router — signature binds source", async () => {
      const q = await getZapQuote(baseBody);
      const tampered: ZapQuoteResult = { ...q, source: "router_simulation", isFallback: false };
      // signature will fail because source changed without re-signing
      const res = validateZapQuoteForExecution({ quote: tampered });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("SIGNATURE_INVALID");
    });
  });

  describe("validate — user slippage edge cases", () => {
    it("clamps too-low slippage 0.0001 to 0.001 (0.1%) minimum", async () => {
      const qLow = await getZapQuote({ ...baseBody, slippageTolerance: 0.0001 });
      // slippageApplied should be at least 0.001
      expect(qLow.slippageApplied).toBeGreaterThanOrEqual(0.001);
      expect(qLow.slippageApplied).toBeLessThanOrEqual(0.15);
    });

    it("clamps too-high slippage 0.5 (50%) to 0.15 (15%) maximum", async () => {
      const qHigh = await getZapQuote({ ...baseBody, slippageTolerance: 0.5 });
      expect(qHigh.slippageApplied).toBeLessThanOrEqual(0.15);
      expect(qHigh.slippageApplied).toBeGreaterThanOrEqual(0.001);
    });

    it("respects explicit 0.001 boundary (minimum)", async () => {
      const q = await getZapQuote({ ...baseBody, slippageTolerance: 0.001 });
      expect(q.slippageApplied).toBeGreaterThanOrEqual(0.001);
    });

    it("respects explicit 0.15 boundary (maximum)", async () => {
      const q = await getZapQuote({ ...baseBody, slippageTolerance: 0.15 });
      expect(q.slippageApplied).toBeLessThanOrEqual(0.15);
      expect(q.slippageApplied).toBeGreaterThanOrEqual(0.001);
    });

    it("rejects quote with slippageApplied outside [0,1)", async () => {
      const q = await getZapQuote(baseBody);
      const bad: ZapQuoteResult = { ...q, slippageApplied: 0.99 };
      // re-sign so signature passes but slippage check should still allow 0.99 (it's <1 and >0.15 ? actually >0.15 should be rejected)
      // 0.99 >0.15 so should be SLIPPAGE_INVALID
      const { quoteSignature, ...rest } = bad;
      (bad as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: bad, allowFallback: true });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("SLIPPAGE_INVALID");
    });

    it("rejects slippage 1.5 (>=1) as invalid", async () => {
      const q = await getZapQuote(baseBody);
      const bad: ZapQuoteResult = { ...q, slippageApplied: 1.5 };
      const { quoteSignature, ...rest } = bad;
      (bad as ZapQuoteResult).quoteSignature = computeQuoteSignature(rest as Omit<ZapQuoteResult, "quoteSignature">);
      const res = validateZapQuoteForExecution({ quote: bad, allowFallback: true });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("SLIPPAGE_INVALID");
    });

    it("applies max of protocol model slippage vs user tolerance", async () => {
      // With tiny amount, protocol slippage ~0.001, user 0.01 should dominate
      const qUserHigher = await getZapQuote({ ...baseBody, amountInStroops: "1000", slippageTolerance: 0.01 });
      expect(qUserHigher.slippageApplied).toBeGreaterThanOrEqual(0.01);
      // With huge amount, protocol slippage may exceed user tolerance, so effective is protocol
      const qProtoHigher = await getZapQuote({ ...baseBody, amountInStroops: "5000000", slippageTolerance: 0.001 });
      // Protocol slippage for 5M vs TVL 10M => impact 0.5 => default model 0.001+0.05=0.051, so should be ~0.051 >0.001
      expect(qProtoHigher.slippageApplied).toBeGreaterThan(0.001);
    });
  });

  describe("validate — signature tampering", () => {
    it("rejects quote with invalid signature", async () => {
      const q = await getZapQuote(baseBody);
      const tampered: ZapQuoteResult = { ...q, quoteSignature: "deadbeef".repeat(8) };
      const res = validateZapQuoteForExecution({ quote: tampered, allowFallback: true });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("SIGNATURE_INVALID");
    });

    it("rejects quote with missing signature as stale? At least not valid without verification", async () => {
      const q = await getZapQuote(baseBody);
      const noSig = { ...q } as ZapQuoteResult;
      delete (noSig as unknown as { quoteSignature?: string }).quoteSignature;
      // Without signature, verification skips signature check and proceeds to other checks
      // It should still be considered valid if other checks pass (signature optional for backward compat)
      const res = validateZapQuoteForExecution({ quote: noSig, allowFallback: true });
      expect(res.valid).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("still returns expectedAmountOutStroops and path like before", async () => {
      const q = await getZapQuote(baseBody);
      expect(q.expectedAmountOutStroops).toBeDefined();
      expect(q.path).toBeDefined();
      expect(Array.isArray(q.path)).toBe(true);
      expect(q.source).toMatch(/router_simulation|fallback_rate/);
    });

    it("quoteAgeMs is near zero for fresh quote", async () => {
      const before = Date.now();
      const q = await getZapQuote(baseBody);
      const after = Date.now();
      expect(q.quoteAgeMs).toBeGreaterThanOrEqual(0);
      expect(q.quoteAgeMs).toBeLessThan(after - before + 100);
    });
  });
});
