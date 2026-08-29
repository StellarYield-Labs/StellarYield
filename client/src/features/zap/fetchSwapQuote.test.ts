import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchSwapQuote, verifyZapQuote, isQuoteExpired, isQuoteStale } from "./fetchSwapQuote";

describe("fetchSwapQuote", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: true,
          json: async () => ({
            path: [{ contractId: "A" }],
            expectedAmountOutStroops: "100",
            source: "fallback_rate",
          }),
        } as Response),
      ),
    );
  });

  afterEach(() => {
    vi.stubGlobal("fetch", origFetch);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns parsed quote JSON", async () => {
    const q = await fetchSwapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "B",
      amountInStroops: "1000",
      inputDecimals: 7,
      vaultDecimals: 7,
    });
    expect(q.expectedAmountOutStroops).toBe("100");
    expect(q.source).toBe("fallback_rate");
  });

  it("throws when response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: async () => "server error",
        } as Response),
      ),
    );
    await expect(
      fetchSwapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1",
        inputDecimals: 7,
        vaultDecimals: 7,
      }),
    ).rejects.toThrow("server error");
  });

  it("uses VITE_API_BASE_URL when set", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "http://127.0.0.1:9999");
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        path: [],
        expectedAmountOutStroops: "1",
        source: "fallback_rate" as const,
      }),
    } as Response);

    await fetchSwapQuote({
      inputTokenContract: "A",
      vaultTokenContract: "A",
      amountInStroops: "1",
      inputDecimals: 7,
      vaultDecimals: 7,
    });

    expect(spy).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/api/zap/quote",
      expect.any(Object),
    );
    spy.mockRestore();
  });

  it("uses status in error when body is empty on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve({
          ok: false,
          status: 502,
          text: async () => "",
        } as Response),
      ),
    );
    await expect(
      fetchSwapQuote({
        inputTokenContract: "A",
        vaultTokenContract: "B",
        amountInStroops: "1",
        inputDecimals: 7,
        vaultDecimals: 7,
      }),
    ).rejects.toThrow("Quote failed (502)");
  });

  describe("verifyZapQuote", () => {
    it("calls /api/zap/verify and returns parsed body on success", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ valid: true, code: "OK", reason: "ok" }),
      } as Response);
      const res = await verifyZapQuote({
        quoteId: "id123",
        inputTokenContract: "A",
        vaultTokenContract: "B",
        allowFallback: true,
      });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("/api/zap/verify"), expect.any(Object));
      expect(res.valid).toBe(true);
      spy.mockRestore();
    });

    it("returns error body even when response is not ok", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ valid: false, code: "QUOTE_EXPIRED", reason: "expired" }),
          } as unknown as Response),
        ),
      );
      const res = await verifyZapQuote({
        quoteId: "id123",
        inputTokenContract: "A",
        vaultTokenContract: "B",
      });
      expect(res.valid).toBe(false);
      expect(res.code).toBe("QUOTE_EXPIRED");
    });
  });

  describe("isQuoteExpired / isQuoteStale", () => {
    it("detects expired quote via expiresAt", () => {
      const now = Date.now();
      const quote = {
        expiresAt: new Date(now - 1000).toISOString(),
        quotedAt: new Date(now - 5000).toISOString(),
        expiresInMs: 30000,
      } as unknown as import("./types").ZapQuoteResponse;
      expect(isQuoteExpired(quote, now)).toBe(true);
      expect(isQuoteExpired({ ...quote, expiresAt: new Date(now + 10000).toISOString() } as unknown as import("./types").ZapQuoteResponse, now)).toBe(false);
    });

    it("detects stale quote via TTL", () => {
      const now = Date.now();
      const fresh = {
        quotedAt: new Date(now - 5000).toISOString(),
        expiresAt: new Date(now + 25000).toISOString(),
        expiresInMs: 30000,
      } as unknown as import("./types").ZapQuoteResponse;
      expect(isQuoteStale(fresh, now)).toBe(false);
      const stale = {
        quotedAt: new Date(now - 40000).toISOString(),
        expiresAt: new Date(now - 5000).toISOString(),
        expiresInMs: 30000,
      } as unknown as import("./types").ZapQuoteResponse;
      expect(isQuoteStale(stale, now)).toBe(true);
    });
  });
});
