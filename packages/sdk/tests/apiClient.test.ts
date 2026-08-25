import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "../src/api/ApiClient";
import { RequestCancelledError } from "../src/errors";

describe("ApiClient request cancellation", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.stubGlobal("fetch", origFetch);
  });

  it("throws RequestCancelledError when quote request is aborted before fetch", async () => {
    const client = new ApiClient({ baseUrl: "http://localhost:3000" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.getZapQuote("USDC", "XLM", "1000", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it("throws RequestCancelledError when simulation request is aborted before fetch", async () => {
    const client = new ApiClient({ baseUrl: "http://localhost:3000" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.getDepositSimulation(
        { strategyId: "alpha-1", amount: 1000, token: "USDC" },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it("maps fetch AbortError to RequestCancelledError for quote requests", async () => {
    const client = new ApiClient({ baseUrl: "http://localhost:3000" });
    const controller = new AbortController();

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      ),
    );

    const pending = client.getZapQuote("USDC", "XLM", "1000", {
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it("does not resolve stale quote responses after cancellation", async () => {
    const client = new ApiClient({ baseUrl: "http://localhost:3000" });
    let resolveFirst: (value: Response) => void = () => {};
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => firstResponse)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ expectedAmount: "200", priceImpact: 0.1 }),
        } as Response),
    );

    const firstController = new AbortController();
    const firstRequest = client.getZapQuote("USDC", "XLM", "1000", {
      signal: firstController.signal,
    });

    firstController.abort();
    resolveFirst({
      ok: true,
      json: async () => ({ expectedAmount: "999", priceImpact: 0.5 }),
    } as Response);

    await expect(firstRequest).rejects.toBeInstanceOf(RequestCancelledError);

    const secondResult = await client.getZapQuote("USDC", "XLM", "2000");
    expect(secondResult.expectedAmount).toBe("200");
  });
});
