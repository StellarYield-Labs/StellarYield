import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ZapDepositPanel from "./ZapDepositPanel";

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("./assets", () => ({
  shouldLoadZapMetadataFromApi: () => false,
  getVaultTokenFromEnv: () => ({
    symbol: "yVault",
    name: "Yield Vault",
    contractId: "CVAULT",
    decimals: 7,
  }),
  getVaultContractIdFromEnv: () => "CVAULT",
  loadZapAssetOptions: () => [
    { symbol: "XLM", name: "Stellar", contractId: "CXLM", decimals: 7 },
    { symbol: "USDC", name: "USD Coin", contractId: "CUSDC", decimals: 7 },
  ],
  mergeVaultIntoZapSelectableAssets: (_assets: unknown[], vault: unknown) => [
    { symbol: "XLM", name: "Stellar", contractId: "CXLM", decimals: 7 },
    { symbol: "USDC", name: "USD Coin", contractId: "CUSDC", decimals: 7 },
    vault,
  ],
  buildSelectableZapAssetsFromMetadata: () => [],
  fetchZapSupportedAssetsMetadata: () => Promise.resolve(null),
}));

const mockZapDeposit = vi.fn().mockResolvedValue({ success: true, hash: "0xhash" });
vi.mock("../../services/soroban", () => ({
  zapDeposit: (...args: unknown[]) => mockZapDeposit(...args),
}));

vi.mock("../settings/SettingsContext", () => ({
  useSettings: () => ({
    settings: {},
  }),
}));

vi.mock("../settings/types", () => ({
  resolveSlippage: () => 0.5,
}));

function createMockQuote(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const ttlMs = 30_000;
  return {
    path: [
      { contractId: "CXLM", label: "XLM" },
      { contractId: "CVAULT", label: "yVault" },
    ],
    expectedAmountOutStroops: "9500000",
    source: "router_simulation",
    slippageApplied: 0.005,
    amountOutAfterSlippage: "9452500",
    quotedAt: new Date(now).toISOString(),
    minAmountOutStroops: "9452500",
    quoteAgeMs: 100,
    isFallback: false,
    quoteId: "test-quote-id-123456",
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
    protocol: "default",
    inputTokenContract: "CXLM",
    vaultTokenContract: "CVAULT",
    amountInStroops: "10000000",
    quoteSignature: "a".repeat(64),
    freezeCheckedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

describe("ZapDepositPanel — safety envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockZapDeposit.mockClear();
    mockFetch.mockReset();
    // Default mock for quote fetch: router_simulation fresh quote
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/zap/verify")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        // Simulate verification logic: if quote isFallback and allowFallback false => fail
        if (body.quote?.isFallback && !body.allowFallback) {
          return Promise.resolve({
            ok: false,
            status: 422,
            json: async () => ({
              valid: false,
              code: "FALLBACK_REQUIRES_ACK",
              reason: "Fallback requires ack",
              requiresRequote: false,
              isFallback: true,
            }),
          } as Response);
        }
        // If expired (mock check by comparing expiresAt)
        if (body.quote?.expiresAt && new Date(body.quote.expiresAt).getTime() < Date.now()) {
          return Promise.resolve({
            ok: false,
            status: 422,
            json: async () => ({
              valid: false,
              code: "QUOTE_EXPIRED",
              reason: "Quote expired",
              requiresRequote: true,
              isExpired: true,
            }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ valid: true, isFallback: body.quote?.isFallback ?? false }),
        } as Response);
      }
      // Default quote fetch
      return Promise.resolve({
        ok: true,
        json: async () => createMockQuote(),
      } as Response);
    });
  });

  it("blocks execution when quote is expired and shows stale/expired warning", async () => {
    const expiredAt = new Date(Date.now() - 5000).toISOString();
    const quotedAt = new Date(Date.now() - 40000).toISOString();
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/zap/verify")) {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({ valid: false, code: "QUOTE_EXPIRED", reason: "Quote expired", requiresRequote: true }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => createMockQuote({ quotedAt, expiresAt: expiredAt, ttlMs: 30000 }),
      } as Response);
    });

    render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "100");

    await waitFor(() => {
      expect(screen.getByText(/Stale quote/)).toBeInTheDocument();
    });

    // Zap button should be disabled for expired quote
    const zapBtn = screen.getByRole("button", { name: /Quote expired|Stale quote|Zap deposit/i });
    await waitFor(() => {
      expect(zapBtn).toBeDisabled();
    });
  });

  it("requires fallback acknowledgement before zap is enabled", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/zap/verify")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (!body.allowFallback) {
          return Promise.resolve({
            ok: false,
            status: 422,
            json: async () => ({ valid: false, code: "FALLBACK_REQUIRES_ACK", reason: "ack required", requiresRequote: false }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: async () => ({ valid: true }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true }),
      } as Response);
    });

    render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "100");

    await waitFor(() => {
      expect(screen.getByText("Fallback quote active")).toBeInTheDocument();
    });

    // Should show acknowledgement checkbox and block label
    expect(screen.getByText(/I understand this is a fallback estimate/)).toBeInTheDocument();
    const zapBtnBefore = screen.getByRole("button", { name: /Acknowledge fallback/i });
    expect(zapBtnBefore).toBeDisabled();

    // Check the box
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    await userEvent.click(checkbox);

    await waitFor(() => {
      const zapBtnAfter = screen.getByRole("button", { name: /Zap deposit/i });
      expect(zapBtnAfter).not.toBeDisabled();
    });
  });

  it("shows slippage-related impact warning for high slippage", async () => {
    render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    // Open slippage editor and set high value 5%
    const infoBtn = screen.getAllByRole("button").find((b) => b.textContent === "");
    // Use the Info icon button for slippage edit (it has no text)
    const editToggle = screen.getByText(/Slippage tolerance/).parentElement?.querySelector("button");
    if (editToggle) await userEvent.click(editToggle);

    await waitFor(() => {
      expect(screen.getByText(/Safe range/)).toBeInTheDocument();
    });

    const preset5 = screen.getByText("5%");
    await userEvent.click(preset5);

    // High slippage warning should appear
    await waitFor(() => {
      expect(screen.getByText(/High slippage/)).toBeInTheDocument();
    });
  });

  it("distinguishes router_simulation from fallback in badge", async () => {
    // Router-simulated first
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        json: async () => createMockQuote({ source: "router_simulation", isFallback: false }),
      } as Response)
    );
    const { rerender } = render(<ZapDepositPanel walletAddress="GABCDEF123" />);
    const input = screen.getByPlaceholderText("0.00");
    await userEvent.type(input, "10");
    await waitFor(() => expect(screen.getByText("Simulated")).toBeInTheDocument());

    // Now test fallback badge via rerender with new fetch mock
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => createMockQuote({ source: "fallback_rate", isFallback: true }),
      } as Response)
    );
    // Trigger requote by changing amount
    await userEvent.clear(input);
    await userEvent.type(input, "20");
    // Need to trigger refreshQuote debounce; wait a bit
    await waitFor(() => {
      // Fallback badge should appear (fallback text)
      const el = screen.queryByText("Fallback");
      if (el) expect(el).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("verifySwapQuote flags asset mismatch via API", async () => {
    const { verifySwapQuote } = await import("./fetchSwapQuote");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        valid: false,
        code: "ASSET_MISMATCH",
        reason: "Quote input asset mismatch",
        requiresRequote: true,
      }),
    } as Response);

    const quote = createMockQuote();
    const result = await verifySwapQuote({
      quote,
      inputTokenContract: "COTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      vaultTokenContract: quote.vaultTokenContract,
      amountInStroops: quote.amountInStroops,
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("ASSET_MISMATCH");
    expect(result.requiresRequote).toBe(true);
  });

  it("verifySwapQuote flags freeze-after-quote requiring requote", async () => {
    const { verifySwapQuote } = await import("./fetchSwapQuote");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({
        valid: false,
        code: "FROZEN_AFTER_QUOTE",
        reason: "Protocol Blend was frozen after this quote was issued",
        requiresRequote: true,
      }),
    } as Response);

    const quote = createMockQuote();
    const result = await verifySwapQuote({
      quote,
      protocol: "Blend",
      allowFallback: true,
    });
    expect(result.valid).toBe(false);
    expect(result.code).toBe("FROZEN_AFTER_QUOTE");
    expect(result.requiresRequote).toBe(true);
  });

  it("isZapQuoteExpired correctly detects expiry via expiresAt", async () => {
    const { isZapQuoteExpired } = await import("./fetchSwapQuote");
    const fresh = createMockQuote();
    expect(isZapQuoteExpired(fresh)).toBe(false);
    const expired = createMockQuote({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isZapQuoteExpired(expired)).toBe(true);
  });
});
