import request from "supertest";
import { createApp } from "../app";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([
    { protocolName: "default", tvl: 10_000_000 },
    { protocolName: "Blend", tvl: 5_000_000 },
  ]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [{ protocolName: "default", tvl: 10_000_000 }],
    cacheStatus: "MISS",
  }),
}));

// Do not mock freezeService - use real implementation but clear between tests
import { freezeService } from "../services/freezeService";
import { clearQuoteStore } from "../services/zapQuote";

describe("POST /api/zap/verify", () => {
  beforeEach(() => {
    clearQuoteStore();
    freezeService.clearAll();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    jest.useRealTimers();
    clearQuoteStore();
    freezeService.clearAll();
  });

  it("verifies a fresh quote as valid (with fallback confirmation)", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
      });
    expect(quoteRes.status).toBe(200);
    const q = quoteRes.body;
    expect(q.quoteId).toBeDefined();

    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000000",
        slippageTolerance: 0.01,
        allowFallback: true,
      });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.valid).toBe(true);
    expect(verifyRes.body.code).toBe("OK");
  });

  it("rejects fallback quote without confirmation", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
    const q = quoteRes.body;
    // Without router env, quote is fallback
    expect(q.isFallback).toBe(true);

    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: false,
      });
    expect(verifyRes.status).toBe(409);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.code).toBe("FALLBACK_REQUIRES_CONFIRMATION");
  });

  it("rejects expired quote", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
    const q = quoteRes.body;
    jest.advanceTimersByTime(40000);
    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        allowFallback: true,
      });
    expect(verifyRes.status).toBe(409);
    expect(verifyRes.body.valid).toBe(false);
    expect(verifyRes.body.code).toMatch(/EXPIRED|STALE/);
  });

  it("rejects changed asset pair", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA_ORIGINAL",
        vaultTokenContract: "CB_VAULT",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
      });
    const q = quoteRes.body;
    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA_DIFFERENT",
        vaultTokenContract: "CB_VAULT",
        allowFallback: true,
      });
    expect(verifyRes.status).toBe(409);
    expect(verifyRes.body.code).toBe("ASSET_MISMATCH");
  });

  it("rejects when protocol freeze invalidates quote", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        protocol: "Blend",
      });
    const q = quoteRes.body;
    jest.advanceTimersByTime(100);
    await freezeService.freezeProtocol("Blend", "test freeze", "tester");
    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        protocol: "Blend",
        allowFallback: true,
      });
    expect(verifyRes.status).toBeGreaterThanOrEqual(400);
    expect(verifyRes.body.valid).toBe(false);
    expect(["PROTOCOL_FROZEN", "FREEZE_INVALIDATED", "GLOBAL_FROZEN"]).toContain(verifyRes.body.code);
  });

  it("rejects slippage out of bounds", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
      });
    const q = quoteRes.body;
    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        slippageTolerance: 0.2,
        allowFallback: true,
      });
    expect(verifyRes.status).toBe(400);
    // The route validation middleware will reject slippage out of bounds before service validation
    expect(verifyRes.body.code ?? verifyRes.body.error).toBeDefined();
  });

  it("requires requote when slippage changed", async () => {
    const app = createApp();
    const quoteRes = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
      });
    const q = quoteRes.body;
    const verifyRes = await request(app)
      .post("/api/zap/verify")
      .send({
        quoteId: q.quoteId,
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        slippageTolerance: 0.05,
        allowFallback: true,
      });
    expect(verifyRes.status).toBe(409);
    expect(verifyRes.body.code).toBe("SLIPPAGE_CHANGED");
  });

  it("returns 400 for missing quoteId", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/zap/verify")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
      });
    expect(res.status).toBe(400);
  });

  it("quote endpoint returns safety envelope fields", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/zap/quote")
      .send({
        inputTokenContract: "CA",
        vaultTokenContract: "CB",
        amountInStroops: "1000",
        inputDecimals: 7,
        vaultDecimals: 7,
        slippageTolerance: 0.01,
        protocol: "Blend",
      });
    expect(res.status).toBe(200);
    expect(res.body.quoteId).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
    expect(res.body.expiresInMs).toBeDefined();
    expect(res.body.inputTokenContract).toBe("CA");
    expect(res.body.vaultTokenContract).toBe("CB");
    expect(res.body.amountInStroops).toBe("1000");
    expect(res.body.protocol).toBe("Blend");
    expect(res.body.freezeStateAtQuote).toBeDefined();
    expect(res.body.signature).toBeDefined();
    expect(res.body.tvlAtQuote).toBeDefined();
  });
});
