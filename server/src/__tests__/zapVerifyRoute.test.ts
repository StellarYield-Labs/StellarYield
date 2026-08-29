import request from "supertest";
import { createApp } from "../app";
import { getZapQuote } from "../services/zapQuote";
import { freezeService } from "../services/freezeService";

jest.mock("../services/yieldService", () => ({
  getYieldData: jest.fn().mockResolvedValue([{ protocolName: "default", tvl: 10_000_000 }]),
  getYieldDataWithCacheStatus: jest.fn().mockResolvedValue({
    data: [{ protocolName: "default", tvl: 10_000_000 }],
    cacheStatus: "MISS",
  }),
}));

describe("POST /api/zap/verify", () => {
  beforeEach(() => {
    (freezeService as unknown as { clearAll: () => void }).clearAll();
  });

  it("verifies a fresh quote as valid with allowFallback", async () => {
    const quote = await getZapQuote({
      inputTokenContract: "CINPUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: "CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountInStroops: "1000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    const res = await request(createApp())
      .post("/api/zap/verify")
      .send({
        quote,
        inputTokenContract: quote.inputTokenContract,
        vaultTokenContract: quote.vaultTokenContract,
        amountInStroops: quote.amountInStroops,
        allowFallback: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it("rejects expired quote with 422 QUOTE_EXPIRED", async () => {
    const quote = await getZapQuote({
      inputTokenContract: "CINPUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: "CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountInStroops: "1000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    // Tamper expiresAt to past and re-sign
    const expiredAt = new Date(Date.now() - 5000).toISOString();
    const tampered = { ...quote, expiresAt: expiredAt };
    const { computeQuoteSignature } = await import("../services/zapQuote");
    const { quoteSignature, ...rest } = tampered as unknown as { quoteSignature: string };
    (tampered as unknown as { quoteSignature: string }).quoteSignature = computeQuoteSignature(rest as Omit<import("../services/zapQuote").ZapQuoteResult, "quoteSignature">);

    const res = await request(createApp())
      .post("/api/zap/verify")
      .send({
        quote: tampered,
        inputTokenContract: tampered.inputTokenContract,
        vaultTokenContract: tampered.vaultTokenContract,
        amountInStroops: tampered.amountInStroops,
        allowFallback: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.valid).toBe(false);
    expect(res.body.code).toBe("QUOTE_EXPIRED");
    expect(res.body.requiresRequote).toBe(true);
  });

  it("rejects asset mismatch with 422 ASSET_MISMATCH", async () => {
    const quote = await getZapQuote({
      inputTokenContract: "CINPUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: "CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountInStroops: "1000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    const res = await request(createApp())
      .post("/api/zap/verify")
      .send({
        quote,
        inputTokenContract: "COTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vaultTokenContract: quote.vaultTokenContract,
        amountInStroops: quote.amountInStroops,
        allowFallback: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("ASSET_MISMATCH");
  });

  it("rejects fallback without ack with 422 FALLBACK_REQUIRES_ACK", async () => {
    const quote = await getZapQuote({
      inputTokenContract: "CINPUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: "CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountInStroops: "1000000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    // quote is fallback when no router
    expect(quote.isFallback).toBe(true);

    const res = await request(createApp())
      .post("/api/zap/verify")
      .send({
        quote,
        inputTokenContract: quote.inputTokenContract,
        vaultTokenContract: quote.vaultTokenContract,
        amountInStroops: quote.amountInStroops,
        allowFallback: false,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("FALLBACK_REQUIRES_ACK");
  });

  it("invalidates quote after protocol freeze", async () => {
    const quote = await getZapQuote({
      inputTokenContract: "CINPUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: "CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amountInStroops: "1000000",
      inputDecimals: 7,
      vaultDecimals: 7,
      protocol: "Blend",
    });

    await new Promise((r) => setTimeout(r, 10));
    await freezeService.freezeProtocol("Blend", "test", "tester");

    const res = await request(createApp())
      .post("/api/zap/verify")
      .send({
        quote,
        inputTokenContract: quote.inputTokenContract,
        vaultTokenContract: quote.vaultTokenContract,
        amountInStroops: quote.amountInStroops,
        protocol: "Blend",
        allowFallback: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("FROZEN_AFTER_QUOTE");
  });

  it("returns 400 for missing quote", async () => {
    const res = await request(createApp()).post("/api/zap/verify").send({});
    expect(res.status).toBe(400);
  });
});
