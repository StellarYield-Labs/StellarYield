import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  apiUrl,
  getApiBaseUrl,
  getApiBaseUrlState,
} from "./api";

describe("api URL helpers", () => {
  const originalWindow = global.window;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  const env = (values: Record<string, string>): ImportMetaEnv =>
    ({
      BASE_URL: "/",
      MODE: "test",
      DEV: false,
      PROD: false,
      SSR: false,
      ...values,
    }) as ImportMetaEnv;

  it("uses the local backend by default when on localhost", () => {
    global.window = { location: { hostname: "localhost" } } as any;
    expect(getApiBaseUrl(env({}))).toBe("http://localhost:3001");
  });

  it("uses the local backend by default for IPv4 and IPv6 local hosts", () => {
    global.window = { location: { hostname: "127.0.0.1" } } as any;
    expect(getApiBaseUrl(env({}))).toBe("http://localhost:3001");

    global.window = { location: { hostname: "::1" } } as any;
    expect(getApiBaseUrl(env({}))).toBe("http://localhost:3001");
  });

  it("prefers VITE_API_BASE_URL and trims trailing slashes", () => {
    expect(
      getApiBaseUrl(env({
        VITE_API_BASE_URL: "https://api.example.com///",
        VITE_API_URL: "https://ignored.example.com",
      })),
    ).toBe("https://api.example.com");
  });

  it("falls back to VITE_API_URL", () => {
    expect(
      getApiBaseUrl(env({
        VITE_API_URL: "https://staging.example.com/",
      })),
    ).toBe("https://staging.example.com");
  });

  it("builds normalized API paths", () => {
    const configuredEnv = env({ VITE_API_BASE_URL: "https://api.example.com/" });
    expect(apiUrl("api/yields", configuredEnv)).toBe("https://api.example.com/api/yields");
    expect(apiUrl("/api/yields", configuredEnv)).toBe("https://api.example.com/api/yields");
  });

  it("reports unavailable API configuration for hosted previews without env vars", () => {
    global.window = { location: { hostname: "stellar-yield-preview.vercel.app" } } as any;

    expect(getApiBaseUrlState(env({}))).toEqual({
      available: false,
      reason: "Backend URL is not configured. Set VITE_API_BASE_URL to enable API-backed views.",
    });
    expect(() => getApiBaseUrl(env({}))).toThrow(/Backend URL is not configured/);
    expect(() => apiUrl("/api/yields", env({}))).toThrow(/Backend URL is not configured/);
  });
});
