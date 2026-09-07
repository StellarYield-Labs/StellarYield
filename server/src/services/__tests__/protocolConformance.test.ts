/**
 * Protocol Adapter Conformance Test Suite
 *
 * Validates that all protocol adapters meet the minimum contract for:
 * - Metadata completeness
 * - APY calculations and ranges
 * - TVL data quality
 * - Asset symbol and decimals
 * - Data freshness
 * - Health signals
 * - Risk profiles
 * - Capability declarations
 *
 * Tests run deterministically without network calls using fixtures.
 * Both positive (valid data) and negative (error) scenarios are covered.
 */

import {
  validateConformancePayload,
  buildCapabilityMatrix,
  generateConformanceReport,
  type ProtocolConformancePayload,
  type ConformanceValidationResult,
} from "../protocolConformance";
import {
  POSITIVE_FIXTURES,
  NEGATIVE_FIXTURES,
  freshTimestamp,
  staleTimestamp,
  createBaseFixture,
} from "./fixtures/conformanceFixtures";

// ────────────────────────────────────────────────────────────────────────────
// Test Group 1: Positive Fixtures (Valid, Complete, Fresh Data)
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Positive Fixtures", () => {
  Object.entries(POSITIVE_FIXTURES).forEach(([name, fixture]) => {
    describe(`${name} adapter`, () => {
      let result: ConformanceValidationResult;

      beforeEach(() => {
        result = validateConformancePayload(fixture);
      });

      it("passes conformance validation", () => {
        expect(result.valid).toBe(true);
      });

      it("data is not stale", () => {
        expect(result.stale).toBe(false);
      });

      it("payload is complete", () => {
        expect(result.complete).toBe(true);
      });

      it("has no validation errors", () => {
        expect(result.errors).toHaveLength(0);
      });

      it("declares required capabilities", () => {
        expect(result.capabilities.deposit).toBe(true);
        expect(result.capabilities.withdraw).toBe(true);
        expect(result.capabilities.quote).toBe(true);
      });

      it("has valid metadata", () => {
        expect(fixture.metadata.protocolName).toBeTruthy();
        expect(fixture.metadata.version).toBeTruthy();
        expect(new Date(fixture.metadata.lastUpdated).getTime()).not.toBeNaN();
      });

      it("has valid APY breakdown", () => {
        const { apy } = fixture;
        expect(apy.baseApy).toBeGreaterThanOrEqual(0);
        expect(apy.baseApy).toBeLessThanOrEqual(1);
        expect(apy.rewardApy).toBeGreaterThanOrEqual(0);
        expect(apy.rewardApy).toBeLessThanOrEqual(1);
        expect(apy.totalApy).toBeGreaterThanOrEqual(0);
        expect(apy.totalApy).toBeLessThanOrEqual(1);
      });

      it("has non-negative TVL", () => {
        expect(fixture.tvlUsd).toBeGreaterThanOrEqual(0);
        expect(isFinite(fixture.tvlUsd)).toBe(true);
      });

      it("declares supported assets with symbols", () => {
        expect(fixture.supportedAssets.length).toBeGreaterThan(0);
        fixture.supportedAssets.forEach((asset) => {
          expect(asset.symbol).toBeTruthy();
        });
      });

      it("has valid health signals", () => {
        const { health } = fixture;
        expect(["healthy", "degraded", "stale", "unavailable"]).toContain(
          health.status,
        );
        expect(health.uptime).toBeGreaterThanOrEqual(0);
        expect(health.uptime).toBeLessThanOrEqual(1);
        expect(health.errorRate).toBeGreaterThanOrEqual(0);
        expect(health.errorRate).toBeLessThanOrEqual(1);
        expect(health.reliability).toBeGreaterThanOrEqual(0);
        expect(health.reliability).toBeLessThanOrEqual(100);
      });

      it("has valid provider info", () => {
        const { provider } = fixture;
        expect(provider.id).toBeTruthy();
        expect(provider.name).toBeTruthy();
      });
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 2: Stale Data Scenarios
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Stale Data Detection", () => {
  it("detects stale data when fetchedAt exceeds threshold", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.staleData);
    expect(result.stale).toBe(true);
    // Stale data is marked but may still be valid if other fields are correct
  });

  it("rejects payload with stale timestamp", () => {
    const staleFixture = createBaseFixture("StaleTest", {
      freshness: {
        dataAge: 600,
        maxAcceptableAge: 300,
        fetchedAt: staleTimestamp(),
      },
    });
    const result = validateConformancePayload(staleFixture);
    expect(result.stale).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 3: APY Validation
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: APY Validation", () => {
  it("rejects APY values above 1.0 (>100%)", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.invalidApyTooHigh,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes("apy"))).toBe(true);
  });

  it("rejects negative APY values", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.invalidApyNegative,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes("apy"))).toBe(true);
  });

  it("rejects NaN APY values", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.invalidApyNan);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes("apy"))).toBe(true);
  });

  it("accepts APY in range [0, 1]", () => {
    const fixture = createBaseFixture("ValidApy", {
      apy: {
        baseApy: 0.05,
        rewardApy: 0.02,
        compoundingApy: 0.001,
        feeDrag: -0.001,
        totalApy: 0.069,
      },
    });
    const result = validateConformancePayload(fixture);
    expect(result.errors.filter((e) => e.field.includes("apy"))).toHaveLength(
      0,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 4: TVL Validation
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: TVL Validation", () => {
  it("rejects negative TVL", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.negativeTvl);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "tvlUsd")).toBe(true);
  });

  it("rejects infinite TVL", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.invalidTvlInfinity,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "tvlUsd")).toBe(true);
  });

  it("accepts zero TVL", () => {
    const fixture = createBaseFixture("ZeroTVL", { tvlUsd: 0 });
    const result = validateConformancePayload(fixture);
    expect(result.errors.filter((e) => e.field === "tvlUsd")).toHaveLength(0);
  });

  it("accepts positive TVL", () => {
    const fixture = createBaseFixture("PositiveTVL", { tvlUsd: 1_000_000 });
    const result = validateConformancePayload(fixture);
    expect(result.errors.filter((e) => e.field === "tvlUsd")).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 5: Asset Validation
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Asset Validation", () => {
  it("rejects empty supported assets array", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.emptyAssets);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "supportedAssets")).toBe(true);
  });

  it("rejects missing asset symbols", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.missingAssetSymbol,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes("symbol"))).toBe(true);
  });

  it("warns on missing decimals but allows partial asset data", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.missingDecimals,
    );
    expect(result.errors.some((e) => e.field.includes("decimals"))).toBe(false);
    // Decimals missing is not an error, just a warning
  });

  it("accepts assets with symbol only", () => {
    const fixture = createBaseFixture("MinimalAssets", {
      supportedAssets: [{ symbol: "USDC" }, { symbol: "XLM" }],
    });
    const result = validateConformancePayload(fixture);
    expect(
      result.errors.filter((e) => e.field.includes("supportedAssets")),
    ).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 6: Health Signals Validation
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Health Signals", () => {
  it("rejects invalid health status", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.invalidHealthStatus,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "health.status")).toBe(true);
  });

  it("rejects uptime above 1.0", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.uptimeAboveOne);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "health.uptime")).toBe(true);
  });

  it("rejects negative uptime", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.uptimeNegative);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "health.uptime")).toBe(true);
  });

  it("accepts provider unavailable status", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.providerUnavailable,
    );
    expect(
      result.errors.filter((e) => e.field === "health.status"),
    ).toHaveLength(0);
    // Status is valid enum, even if provider is unavailable
  });

  it("accepts provider degraded status with valid metrics", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.providerDegraded,
    );
    expect(
      result.errors.filter((e) => e.field === "health.status"),
    ).toHaveLength(0);
    expect(
      result.errors.filter((e) => e.field === "health.uptime"),
    ).toHaveLength(0);
  });

  it("accepts valid reliability scores 0-100", () => {
    const fixture = createBaseFixture("ValidReliability", {
      health: {
        status: "healthy",
        lastHealthCheck: freshTimestamp(),
        uptime: 0.95,
        responseTime: 200,
        errorRate: 0.02,
        consecutiveErrors: 0,
        reliability: 75,
      },
    });
    const result = validateConformancePayload(fixture);
    expect(
      result.errors.filter((e) => e.field === "health.reliability"),
    ).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 7: Missing Critical Fields
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Missing Critical Fields", () => {
  it("rejects missing metadata", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.missingMetadata,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "metadata")).toBe(true);
  });

  it("rejects missing apy", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.missingApy);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "apy")).toBe(true);
  });

  it("rejects missing health", () => {
    const result = validateConformancePayload(NEGATIVE_FIXTURES.missingHealth);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "health")).toBe(true);
  });

  it("rejects missing freshness", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.missingFreshness,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "freshness")).toBe(true);
  });

  it("rejects missing provider", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.missingProvider,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "provider")).toBe(true);
  });

  it("rejects missing capabilities", () => {
    const result = validateConformancePayload(
      NEGATIVE_FIXTURES.missingCapabilities,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "capabilities")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 8: Capability Matrix
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Capability Matrix", () => {
  it("builds capability matrix from multiple protocols", () => {
    const payloads = new Map(Object.entries(POSITIVE_FIXTURES));
    const matrix = buildCapabilityMatrix(payloads);

    expect(matrix.protocols.length).toBe(Object.keys(POSITIVE_FIXTURES).length);
    expect(matrix.capabilities).toHaveProperty("blend");
    expect(matrix.capabilities).toHaveProperty("soroswap");
  });

  it("reports protocol capabilities correctly", () => {
    const payloads = new Map(Object.entries(POSITIVE_FIXTURES));
    const matrix = buildCapabilityMatrix(payloads);

    expect(matrix.capabilities.blend.deposit).toBe(true);
    expect(matrix.capabilities.blend.withdraw).toBe(true);
    expect(matrix.capabilities.soroswap.swap).toBe(true);
  });

  it("calculates coverage percentage", () => {
    const payloads = new Map(Object.entries(POSITIVE_FIXTURES));
    const matrix = buildCapabilityMatrix(payloads);

    expect(matrix.summary.coverage).toBeGreaterThan(0);
    expect(matrix.summary.coverage).toBeLessThanOrEqual(1);
  });

  it("identifies critical gaps in required capabilities", () => {
    const incompleteFixture = createBaseFixture("Incomplete", {
      capabilities: {
        deposit: false,
        withdraw: false,
        swap: false,
        quote: false,
        emergency: false,
      },
    });

    const payloads = new Map([
      ["incomplete", incompleteFixture],
      ...Object.entries(POSITIVE_FIXTURES),
    ]);

    const matrix = buildCapabilityMatrix(payloads);
    expect(matrix.summary.criticalGaps.length).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 9: Conformance Report Generation
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Report Generation", () => {
  it("generates a conformance report for all protocols", () => {
    const payloads = new Map(Object.entries(POSITIVE_FIXTURES));
    const validations = new Map(
      Array.from(payloads.entries()).map(([name, payload]) => [
        name,
        validateConformancePayload(payload),
      ]),
    );

    const report = generateConformanceReport(validations, payloads);

    expect(report.timestamp).toBeTruthy();
    expect(report.protocols.length).toBe(Object.keys(POSITIVE_FIXTURES).length);
    expect(report.summary.totalProtocols).toBe(
      Object.keys(POSITIVE_FIXTURES).length,
    );
  });

  it("counts valid protocols correctly", () => {
    const payloads = new Map(Object.entries(POSITIVE_FIXTURES));
    const validations = new Map(
      Array.from(payloads.entries()).map(([name, payload]) => [
        name,
        validateConformancePayload(payload),
      ]),
    );

    const report = generateConformanceReport(validations, payloads);

    expect(report.summary.validProtocols).toBe(
      Object.keys(POSITIVE_FIXTURES).length,
    );
  });

  it("counts errors and warnings", () => {
    const blendValid = POSITIVE_FIXTURES.blend;
    const blendInvalidApy = NEGATIVE_FIXTURES.invalidApyTooHigh;

    const payloads = new Map([
      ["valid_blend", blendValid],
      ["invalid_apy", blendInvalidApy],
    ]);

    const validations = new Map([
      ["valid_blend", validateConformancePayload(blendValid)],
      ["invalid_apy", validateConformancePayload(blendInvalidApy)],
    ]);

    const report = generateConformanceReport(validations, payloads);

    expect(report.summary.errorCount).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 10: Batched Compliance for All Negative Fixtures
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Conformance: Negative Fixture Batch Validation", () => {
  // Test only fixtures that should actually fail validation
  const criticalNegativeFixtures = {
    missingAssetSymbol: NEGATIVE_FIXTURES.missingAssetSymbol,
    invalidApyTooHigh: NEGATIVE_FIXTURES.invalidApyTooHigh,
    invalidApyNegative: NEGATIVE_FIXTURES.invalidApyNegative,
    invalidApyNan: NEGATIVE_FIXTURES.invalidApyNan,
    negativeTvl: NEGATIVE_FIXTURES.negativeTvl,
    invalidTvlInfinity: NEGATIVE_FIXTURES.invalidTvlInfinity,
    emptyAssets: NEGATIVE_FIXTURES.emptyAssets,
    missingMetadata: NEGATIVE_FIXTURES.missingMetadata,
    missingApy: NEGATIVE_FIXTURES.missingApy,
    missingHealth: NEGATIVE_FIXTURES.missingHealth,
    missingFreshness: NEGATIVE_FIXTURES.missingFreshness,
    missingProvider: NEGATIVE_FIXTURES.missingProvider,
    missingCapabilities: NEGATIVE_FIXTURES.missingCapabilities,
    invalidHealthStatus: NEGATIVE_FIXTURES.invalidHealthStatus,
    uptimeAboveOne: NEGATIVE_FIXTURES.uptimeAboveOne,
    uptimeNegative: NEGATIVE_FIXTURES.uptimeNegative,
  };

  Object.entries(criticalNegativeFixtures).forEach(([name, fixture]) => {
    it(`flags errors in ${name} fixture`, () => {
      const result = validateConformancePayload(fixture);

      // Critical negative fixtures should have errors
      expect(result.errors.length).toBeGreaterThan(0);

      // Errors should have meaningful information
      result.errors.forEach((error) => {
        expect(error.field).toBeTruthy();
        expect(error.code).toBeTruthy();
        expect(error.message).toBeTruthy();
      });
    });
  });
});
