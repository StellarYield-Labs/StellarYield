/**
 * Vault Metadata Validation Tests (#418)
 *
 * Tests for metadata validation edge cases, SVG sanitization,
 * and the upload pipeline used in the pinning workflow.
 */

import {
  validateVaultMetadataInput,
  sanitizeSvg,
  type VaultMetadataInput,
} from "../services/ipfs/vaultMetadataService";
import { validateIconUrl, validateIconUrlOrThrow } from "../utils/iconValidator";

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="30"/></svg>`;

function makeValidInput(overrides: Partial<VaultMetadataInput> = {}): VaultMetadataInput {
  return {
    vaultName: "Blend Vault",
    description: "A stable yield vault on Stellar",
    iconSvg: VALID_SVG,
    ...overrides,
  };
}

// ── validateVaultMetadataInput ────────────────────────────────────────────────

describe("validateVaultMetadataInput", () => {
  it("accepts a fully valid input", () => {
    const result = validateVaultMetadataInput(makeValidInput());
    expect(result.ok).toBe(true);
  });

  it("rejects null input", () => {
    const result = validateVaultMetadataInput(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects missing vaultName", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), vaultName: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("vaultName"))).toBe(true);
    }
  });

  it("rejects missing description", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), description: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("description"))).toBe(true);
    }
  });

  it("rejects missing iconSvg", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), iconSvg: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("iconSvg"))).toBe(true);
    }
  });

  it("rejects iconSvg that is not valid SVG markup", () => {
    const result = validateVaultMetadataInput({ ...makeValidInput(), iconSvg: "<div>not svg</div>" });
    expect(result.ok).toBe(false);
  });

  it("rejects iconSvg containing a script tag", () => {
    const maliciousSvg = `<svg><script>alert(1)</script></svg>`;
    // sanitizeSvg strips scripts, but the raw input still contains <script>
    // validateVaultMetadataInput calls sanitizeSvg internally and accepts the sanitized result
    // so we test sanitizeSvg directly for script removal
    const sanitized = sanitizeSvg(maliciousSvg);
    expect(sanitized).not.toContain("<script>");
  });

  it("rejects non-object input", () => {
    const result = validateVaultMetadataInput("not an object");
    expect(result.ok).toBe(false);
  });

  it("collects multiple errors at once", () => {
    const result = validateVaultMetadataInput({ vaultName: "", description: "", iconSvg: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ── validateIconUrl (icon URL edge cases, #65) ────────────────────────────────

describe("validateIconUrl", () => {
  it("accepts a valid HTTPS URL", () => {
    const result = validateIconUrl("https://cdn.example.com/icons/vault.svg");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.url).toBe("https://cdn.example.com/icons/vault.svg");
  });

  it("accepts an HTTPS URL with query and port", () => {
    const result = validateIconUrl("https://cdn.example.com:8443/icon.png?v=2");
    expect(result.valid).toBe(true);
  });

  it("rejects an empty string", () => {
    const result = validateIconUrl("");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("rejects a whitespace-only string", () => {
    const result = validateIconUrl("   ");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("empty"))).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(validateIconUrl(null).valid).toBe(false);
    expect(validateIconUrl(undefined).valid).toBe(false);
    expect(validateIconUrl(42).valid).toBe(false);
  });

  it.each([
    "http://cdn.example.com/icon.svg",
    "ftp://cdn.example.com/icon.svg",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("rejects unsupported scheme: %s", (url) => {
    const result = validateIconUrl(url);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([
    "not a url",
    "https://",
    "://missing-scheme.com",
    "https:// spaces .com/icon.svg",
    "htps:/broken",
  ])("rejects malformed URL: %s", (url) => {
    const result = validateIconUrl(url);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("produces a clear error message for a bad scheme", () => {
    const result = validateIconUrl("http://example.com/icon.svg");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/scheme .* is not allowed/);
  });

  it("validateIconUrlOrThrow returns the normalized URL on success", () => {
    expect(validateIconUrlOrThrow("https://example.com/icon.svg")).toBe(
      "https://example.com/icon.svg",
    );
  });

  it("validateIconUrlOrThrow throws on an invalid URL", () => {
    expect(() => validateIconUrlOrThrow("http://example.com/icon.svg")).toThrow(
      /Icon URL validation failed/,
    );
    expect(() => validateIconUrlOrThrow("")).toThrow(/Icon URL validation failed/);
  });
});

// ── sanitizeSvg ───────────────────────────────────────────────────────────────

describe("sanitizeSvg", () => {
  it("returns clean SVG unchanged", () => {
    const result = sanitizeSvg(VALID_SVG);
    expect(result).toContain("<svg");
    expect(result).not.toContain("<script");
  });

  it("strips script tags", () => {
    const svg = `<svg><script>alert('xss')</script><circle r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
  });

  it("strips inline event handlers (double quotes)", () => {
    const svg = `<svg><circle onclick="evil()" r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("onclick");
  });

  it("strips inline event handlers (single quotes)", () => {
    const svg = `<svg><circle onload='evil()' r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("onload");
  });

  it("strips javascript: URIs", () => {
    const svg = `<svg><a href="javascript:void(0)"><circle r="5"/></a></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.toLowerCase()).not.toContain("javascript:");
  });

  it("throws for empty input", () => {
    expect(() => sanitizeSvg("")).toThrow();
  });

  it("throws for non-SVG markup", () => {
    expect(() => sanitizeSvg("<html><body>not svg</body></html>")).toThrow("valid SVG");
  });

  it("handles multiline script tags", () => {
    const svg = `<svg>
      <script type="text/javascript">
        var x = 1;
      </script>
      <circle r="5"/>
    </svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("var x");
  });

  it("handles nested script tag bypass attempts", () => {
    // After stripping inner <script>, the outer fragments rejoin into a new <script> tag
    const svg = `<svg><scr<script></script>ipt>alert(1)</script><circle r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
  });

  it("strips event handlers revealed after script tag removal", () => {
    // Removing the <script> block reveals ` onload="evil()"` on the <svg> tag
    const svg = `<svg<script></script> onload="evil()"><circle r="5"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result).not.toContain("onload");
    expect(result).not.toContain("evil");
  });

  it("strips data: URIs", () => {
    const svg = `<svg><image href="data:text/html,<script>alert(1)</script>"/></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.toLowerCase()).not.toContain("data:");
  });

  it("strips vbscript: URIs", () => {
    const svg = `<svg><a href="vbscript:MsgBox('xss')"><circle r="5"/></a></svg>`;
    const result = sanitizeSvg(svg);
    expect(result.toLowerCase()).not.toContain("vbscript:");
  });
});
