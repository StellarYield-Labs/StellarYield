import { getZapQuote, validateZapQuoteForExecution, clearQuoteStore, getQuoteTtlMs, quoteFallback } from "../services/zapQuote";
import { freezeService } from "../services/freezeService";

// Mock yield data
jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
    { protocolName: "Blend", tvl: 5_000_000 },
  ]),
}));

describe("Zap Safety Envelope", () => {
  beforeEach(() => {
    clearQuoteStore();
    freezeService.clearAll();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    delete process.env.DEX_ROUTER_CONTRACT_ID;
    delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
    process.env.ZAP_QUOTE_TTL_MS = "30000";
  });

  afterEach(() => {
    jest.useRealTimers();
    clearQuoteStore();
    freezeService.clearAll();
  });

  describe("quote identifier and expiry/TTL", () => {
    it("adds quoteId, expiresAt, and TTL to backend quotes", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      expect(q.quoteId).toBeDefined();
      expect(typeof q.quoteId).toBe("string");
      expect(q.quoteId!.length).toBeGreaterThan(10);
      expect(q.expiresAt).toBeDefined();
      expect(() => new Date(q.expiresAt!)).not.toThrow();
      expect(q.expiresInMs!).toBe(getQuoteTtlMs());
      const quotedMs = new Date(q.quotedAt).getTime();
      const expiresMs = new Date(q.expiresAt!).getTime();
      expect(expiresMs - quotedMs).toBe(q.expiresInMs!);
    });

    it("persists quote assumptions: route, assets, expected output, slippage, source, protocol, freeze state", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA_INPUT",
        vaultTokenContract: "CB_VAULT",
        amountInStroops: "5000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
        protocol: "Blend",
      });
      expect(q.inputTokenContract!).toBe("CA_INPUT");
      expect(q.vaultTokenContract!).toBe("CB_VAULT");
      expect(q.amountInStroops!).toBe("5000000");
      expect(q.expectedAmountOutStroops).toBeDefined();
      expect(q.minAmountOutStroops).toBeDefined();
      expect(q.slippageApplied).toBeGreaterThan(0);
      expect(q.source).toBeDefined();
      expect(q.protocol!).toBe("Blend");
      expect(q.freezeStateAtQuote!).toBeDefined();
      expect(q.freezeStateAtQuote!.isFrozen).toBe(false);
      expect(q.path).toBeDefined();
      expect(q.signature).toBeDefined();
    });

    it("respects custom TTL via env", async () => {
      process.env.ZAP_QUOTE_TTL_MS = "15000";
      const q = await getZapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      expect(q.expiresInMs!).toBe(15000);
    });
  });

  describe("stale quote rejection", () => {
    it("rejects execution when quote is expired", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

      // Advance past TTL (30s +1s buffer)
      jest.advanceTimersByTime(35000);
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toMatch(/EXPIRED|STALE/);
    });

    it("rejects when quote not found (requires requote)", async () => {
      const result = validateZapQuoteForExecution({
        quoteId: "non-existent-id",
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("QUOTE_NOT_FOUND");
    });

    it("requires fresh quote after TTL even if not yet expired by cache eviction logic", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      // Just before expiry should be valid
      jest.advanceTimersByTime(10000);
      let r = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: true,
      });
      expect(r.valid).toBe(true);

      // Just after expiry
      jest.advanceTimersByTime(25000);
      r = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: true,
      });
      expect(r.valid).toBe(false);
    });
  });

  describe("changed route / asset pair rejection", () => {
    it("rejects execution if asset pair differs from quote", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA_ORIGINAL",
        vaultTokenContract: "CB_VAULT",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });

      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA_DIFFERENT",
        vaultTokenContract: "CB_VAULT",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("ASSET_MISMATCH");
      expect(result.reason).toMatch(/CA_ORIGINAL/);
    });

    it("rejects when vault token changed", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB_ORIGINAL",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB_DIFFERENT",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("ASSET_MISMATCH");
    });

    it("rejects when amount differs", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "9999",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("AMOUNT_MISMATCH");
    });

    it("rejects when protocol differs", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        protocol: "Blend",
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        protocol: "Soroswap",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("PROTOCOL_MISMATCH");
    });
  });

  describe("protocol freeze after quote", () => {
    it("invalidates pending zap quotes after protocol freeze", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        protocol: "Blend",
      });

      // Freeze after quote
      jest.advanceTimersByTime(1000);
      await freezeService.freezeProtocol("Blend", "test freeze", "tester");

      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        protocol: "Blend",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      // Could be PROTOCOL_FROZEN (currently frozen) or FREEZE_INVALIDATED (was frozen after quote)
      expect(["PROTOCOL_FROZEN", "FREEZE_INVALIDATED", "GLOBAL_FROZEN"]).toContain(result.code);
    });

    it("invalidates after global freeze even for default protocol quotes", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      jest.advanceTimersByTime(500);
      await freezeService.freezeGlobal("global freeze", "tester");

      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
    });

    it("still invalidates after resume (freeze after quote remains invalid)", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        protocol: "Blend",
      });
      jest.advanceTimersByTime(500);
      await freezeService.freezeProtocol("Blend", "freeze", "tester");
      jest.advanceTimersByTime(500);
      await freezeService.resumeProtocol("Blend", "tester");

      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        protocol: "Blend",
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("FREEZE_INVALIDATED");
    });

    it("does not invalidate quotes created after freeze", async () => {
      await freezeService.freezeProtocol("Blend", "freeze", "tester");
      jest.advanceTimersByTime(1000);
      await freezeService.resumeProtocol("Blend", "tester");
      jest.advanceTimersByTime(1000);
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        protocol: "Blend",
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        protocol: "Blend",
        allowFallback: true,
      });
      // Should be valid (not invalidated) because quote after freeze
      expect(result.valid).toBe(true);
    });

    it("blocks quoting when protocol is frozen", async () => {
      await freezeService.freezeProtocol("Blend", "freeze", "tester");
      await expect(
        getZapQuote({
          inputTokenContract: "CA",
          vaultTokenContract: "CB",
          amountInStroops: "1000",
          inputDecimals: 7,
          vaultDecimals: 7,
          protocol: "Blend",
        })
      ).rejects.toThrow(/temporarily disabled/);
    });
  });

  describe("fallback vs router distinction", () => {
    it("fallback quotes require explicit allowFallback flag", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      // By default with no router env, quote is fallback
      expect(q.isFallback).toBe(true);
      expect(q.source).toBe("fallback_rate");

      let result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: false,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("FALLBACK_REQUIRES_CONFIRMATION");

      result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: true,
      });
      expect(result.valid).toBe(true);
    });

    it("clearly marks fallback quotes and does not silently treat as router_simulation", async () => {
      const fallback = quoteFallback({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      expect(fallback.isFallback).toBe(true);
      expect(fallback.source).toBe("fallback_rate");

      // Simulate that getZapQuote would have stored a fallback; test validation source mismatch
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      const r = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        source: "router_simulation",
        allowFallback: true,
      });
      expect(r.valid).toBe(false);
      expect(r.code).toBe("SOURCE_MISMATCH");
    });
  });

  describe("user slippage edge cases", () => {
    it("rejects slippage out of bounds (too low)", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        slippageTolerance: 0.0005, // below 0.001
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("SLIPPAGE_OUT_OF_BOUNDS");
    });

    it("rejects slippage out of bounds (too high)", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        slippageTolerance: 0.2, // above 0.15
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("SLIPPAGE_OUT_OF_BOUNDS");
    });

    it("rejects when slippage tolerance changed after quote (requires requote)", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        slippageTolerance: 0.05, // changed
        allowFallback: true,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe("SLIPPAGE_CHANGED");
    });

    it("allows same slippage tolerance as quote", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.02,
      });
      const result = validateZapQuoteForExecution({
        quoteId: q.quoteId!,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        slippageTolerance: 0.02,
        allowFallback: true,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts edge values 0.001 and 0.15", async () => {
      const qLow = await getZapQuote({
        inputTokenContract: "A1",
        vaultTokenContract: "B1",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.001,
      });
      expect(
        validateZapQuoteForExecution({
          quoteId: qLow.quoteId!,
          inputTokenContract: "A1",
          vaultTokenContract: "B1",
          slippageTolerance: 0.001,
          allowFallback: true,
        }).valid
      ).toBe(true);

      const qHigh = await getZapQuote({
        inputTokenContract: "A2",
        vaultTokenContract: "B2",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.15,
      });
      expect(
        validateZapQuoteForExecution({
          quoteId: qHigh.quoteId!,
          inputTokenContract: "A2",
          vaultTokenContract: "B2",
          slippageTolerance: 0.15,
          allowFallback: true,
        }).valid
      ).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("still includes legacy fields for existing clients", async () => {
      const q = await getZapQuote({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
      expect(q.path).toBeDefined();
      expect(q.expectedAmountOutStroops).toBeDefined();
      expect(q.source).toBeDefined();
      expect(q.slippageApplied).toBeDefined();
      expect(q.amountOutAfterSlippage).toBeDefined();
      expect(q.quotedAt).toBeDefined();
      expect(q.minAmountOutStroops).toBeDefined();
      expect(q.quoteAgeMs).toBeDefined();
      expect(typeof q.isFallback).toBe("boolean");
    });
  });
});
