import { describe, it, expect } from "vitest";
import { validateVaultSlug } from "./vaultData";

describe("validateVaultSlug", () => {
  it("validates a standard valid slug", () => {
    const result = validateVaultSlug("usdc");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("usdc");
  });

  it("normalizes casing", () => {
    const result = validateVaultSlug("USDC");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("usdc");
  });

  it("normalizes whitespace", () => {
    const result = validateVaultSlug("  xlm-usdc  ");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("xlm-usdc");
  });

  it("returns invalid for unknown slugs", () => {
    const result = validateVaultSlug("invalid-vault");
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe("invalid-vault");
  });

  it("handles undefined slug", () => {
    const result = validateVaultSlug(undefined);
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe("");
  });

  it("handles empty string", () => {
    const result = validateVaultSlug("");
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe("");
  });

  it("validates complex valid slugs", () => {
    const result = validateVaultSlug("XLM-ETH");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("xlm-eth");
  });
});
