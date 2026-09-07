/**
 * Protocol Conformance Test Fixtures
 *
 * Deterministic fixtures for testing protocol adapters without network calls.
 * Covers happy path, negative scenarios, stale data, missing decimals, etc.
 */

import type { ProtocolConformancePayload } from "../../protocolConformance";

// ────────────────────────────────────────────────────────────────────────────
// Helper: Timestamp utilities
// ────────────────────────────────────────────────────────────────────────────

export function freshTimestamp(offsetMs = 0): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

export function staleTimestamp(offsetMs = 5 * 60 * 1000): string {
  return freshTimestamp(offsetMs + 60 * 1000); // older than threshold
}

// ────────────────────────────────────────────────────────────────────────────
// Base fixture factory
// ────────────────────────────────────────────────────────────────────────────

export function createBaseFixture(
  protocolName: string,
  overrides: Partial<ProtocolConformancePayload> = {},
): ProtocolConformancePayload {
  return {
    metadata: {
      protocolName,
      protocolId: `${protocolName.toLowerCase()}-id`,
      version: "1.0.0",
      lastUpdated: freshTimestamp(),
      source: "api",
      network: "mainnet",
      ...overrides.metadata,
    },
    apy: {
      baseApy: 0.065,
      rewardApy: 0.02,
      compoundingApy: 0.005,
      feeDrag: -0.01,
      totalApy: 0.09,
      ...overrides.apy,
    },
    tvlUsd: 12_000_000,
    supportedAssets: [
      { symbol: "USDC", contractId: "CUSDC123", decimals: 7 },
      { symbol: "XLM", contractId: "CXLM123", decimals: 7 },
    ],
    freshness: {
      dataAge: 30,
      maxAcceptableAge: 300,
      fetchedAt: freshTimestamp(),
      ...overrides.freshness,
    },
    health: {
      status: "healthy",
      lastHealthCheck: freshTimestamp(),
      uptime: 0.999,
      responseTime: 150,
      errorRate: 0.001,
      consecutiveErrors: 0,
      reliability: 99,
      ...overrides.health,
    },
    provider: {
      id: `${protocolName.toLowerCase()}`,
      name: protocolName,
      website: `https://${protocolName.toLowerCase()}.com`,
      documentation: `https://docs.${protocolName.toLowerCase()}.com`,
      ...overrides.provider,
    },
    capabilities: {
      deposit: true,
      withdraw: true,
      swap: true,
      quote: true,
      emergency: true,
      ...overrides.capabilities,
    },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Positive Fixtures (Valid, Fresh Data)
// ────────────────────────────────────────────────────────────────────────────

export const BLEND_VALID_FIXTURE: ProtocolConformancePayload = createBaseFixture("Blend", {
  metadata: {
    protocolName: "Blend",
    protocolId: "blend-mainnet",
    version: "2.1.0",
    lastUpdated: freshTimestamp(),
    source: "blend-api",
    network: "mainnet",
  },
  apy: {
    baseApy: 0.065,
    rewardApy: 0.025,
    compoundingApy: 0.008,
    feeDrag: -0.01,
    totalApy: 0.088,
  },
  tvlUsd: 12_400_000,
  supportedAssets: [
    { symbol: "USDC", contractId: "CUSDC_BLEND", decimals: 7 },
    { symbol: "XLM", contractId: "CXLM_BLEND", decimals: 7 },
    { symbol: "BLND", contractId: "CBLND", decimals: 7 },
  ],
  health: {
    status: "healthy",
    lastHealthCheck: freshTimestamp(),
    uptime: 0.9995,
    responseTime: 120,
    errorRate: 0.0005,
    consecutiveErrors: 0,
    reliability: 99.5,
  },
  provider: {
    id: "blend",
    name: "Blend Protocol",
    website: "https://blend.com",
    documentation: "https://docs.blend.com",
  },
  capabilities: {
    deposit: true,
    withdraw: true,
    swap: false,
    quote: true,
    emergency: true,
  },
  risk: {
    score: 25,
    tier: "low",
    factors: {
      contractAge: 85,
      auditStatus: "passed",
      liquidityDepth: 90,
      historicalVolatility: 0.08,
    },
  },
});

export const SOROSWAP_VALID_FIXTURE: ProtocolConformancePayload = createBaseFixture("Soroswap", {
  metadata: {
    protocolName: "Soroswap",
    protocolId: "soroswap-mainnet",
    version: "1.4.2",
    lastUpdated: freshTimestamp(),
    source: "soroswap-api",
    network: "mainnet",
  },
  apy: {
    baseApy: 0.112,
    rewardApy: 0.015,
    compoundingApy: 0.006,
    feeDrag: -0.008,
    totalApy: 0.125,
  },
  tvlUsd: 4_850_000,
  supportedAssets: [
    { symbol: "USDC", contractId: "CUSDC_SWAP", decimals: 7 },
    { symbol: "XLM", contractId: "CXLM_SWAP", decimals: 7 },
    { symbol: "SORO", contractId: "CSORO", decimals: 7 },
  ],
  health: {
    status: "healthy",
    lastHealthCheck: freshTimestamp(),
    uptime: 0.998,
    responseTime: 200,
    errorRate: 0.001,
    consecutiveErrors: 0,
    reliability: 98.5,
  },
  capabilities: {
    deposit: true,
    withdraw: true,
    swap: true,
    quote: true,
    emergency: true,
  },
  risk: {
    score: 40,
    tier: "medium",
    factors: {
      contractAge: 65,
      auditStatus: "partial",
      liquidityDepth: 75,
      historicalVolatility: 0.15,
    },
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Stale Data
// ────────────────────────────────────────────────────────────────────────────

export const STALE_DATA_FIXTURE: ProtocolConformancePayload = createBaseFixture("StaleBad", {
  freshness: {
    dataAge: 600, // 10 minutes
    maxAcceptableAge: 300,
    fetchedAt: staleTimestamp(),
  },
  health: {
    status: "stale",
    lastHealthCheck: staleTimestamp(),
    uptime: 0.95,
    responseTime: 5000,
    errorRate: 0.05,
    consecutiveErrors: 2,
    reliability: 65,
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Missing Decimals
// ────────────────────────────────────────────────────────────────────────────

export const MISSING_DECIMALS_FIXTURE: ProtocolConformancePayload = createBaseFixture("MissingDecimals", {
  supportedAssets: [
    { symbol: "USDC", contractId: "CUSDC123" }, // decimals missing
    { symbol: "XLM", contractId: "CXLM123", decimals: 7 },
  ],
});

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Missing Asset Symbols
// ────────────────────────────────────────────────────────────────────────────

export const MISSING_ASSET_SYMBOL_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "MissingSymbol",
  {
    supportedAssets: [
      { contractId: "CUSDC123", decimals: 7 }, // symbol missing
    ] as any,
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Invalid APY Ranges
// ────────────────────────────────────────────────────────────────────────────

export const INVALID_APY_TOO_HIGH_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "InvalidApyHigh",
  {
    apy: {
      baseApy: 1.5, // > 1.0
      rewardApy: 0.02,
      compoundingApy: 0.005,
      feeDrag: -0.01,
      totalApy: 1.5,
    },
  },
);

export const INVALID_APY_NEGATIVE_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "InvalidApyNegative",
  {
    apy: {
      baseApy: -0.1, // negative
      rewardApy: 0.02,
      compoundingApy: 0.005,
      feeDrag: -0.01,
      totalApy: -0.08,
    },
  },
);

export const INVALID_APY_NAN_FIXTURE: ProtocolConformancePayload = createBaseFixture("InvalidApyNaN", {
  apy: {
    baseApy: NaN,
    rewardApy: 0.02,
    compoundingApy: 0.005,
    feeDrag: -0.01,
    totalApy: NaN,
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Invalid TVL
// ────────────────────────────────────────────────────────────────────────────

export const NEGATIVE_TVL_FIXTURE: ProtocolConformancePayload = createBaseFixture("NegativeTVL", {
  tvlUsd: -1_000_000,
});

export const INVALID_TVL_INFINITY_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "InvalidTVLInfinity",
  {
    tvlUsd: Infinity,
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Unsupported Assets / Empty Assets
// ────────────────────────────────────────────────────────────────────────────

export const EMPTY_ASSETS_FIXTURE: ProtocolConformancePayload = createBaseFixture("EmptyAssets", {
  supportedAssets: [],
});

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Provider Outage / Degraded Health
// ────────────────────────────────────────────────────────────────────────────

export const PROVIDER_UNAVAILABLE_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "ProviderDown",
  {
    health: {
      status: "unavailable",
      lastHealthCheck: staleTimestamp(),
      uptime: 0.0,
      responseTime: 30000,
      errorRate: 1.0,
      consecutiveErrors: 10,
      reliability: 0,
    },
  },
);

export const PROVIDER_DEGRADED_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "ProviderDegraded",
  {
    health: {
      status: "degraded",
      lastHealthCheck: freshTimestamp(),
      uptime: 0.8,
      responseTime: 2000,
      errorRate: 0.15,
      consecutiveErrors: 3,
      reliability: 50,
    },
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Missing Critical Fields
// ────────────────────────────────────────────────────────────────────────────

export const MISSING_METADATA_FIXTURE = (() => {
  const fixture = createBaseFixture("MissingMetadata");
  delete (fixture as any).metadata;
  return fixture;
})();

export const MISSING_APY_FIXTURE = (() => {
  const fixture = createBaseFixture("MissingAPY");
  delete (fixture as any).apy;
  return fixture;
})();

export const MISSING_HEALTH_FIXTURE = (() => {
  const fixture = createBaseFixture("MissingHealth");
  delete (fixture as any).health;
  return fixture;
})();

export const MISSING_FRESHNESS_FIXTURE = (() => {
  const fixture = createBaseFixture("MissingFreshness");
  delete (fixture as any).freshness;
  return fixture;
})();

export const MISSING_PROVIDER_FIXTURE = (() => {
  const fixture = createBaseFixture("MissingProvider");
  delete (fixture as any).provider;
  return fixture;
})();

export const MISSING_CAPABILITIES_FIXTURE = (() => {
  const fixture = createBaseFixture("MissingCapabilities");
  delete (fixture as any).capabilities;
  return fixture;
})();

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Invalid Health Status
// ────────────────────────────────────────────────────────────────────────────

export const INVALID_HEALTH_STATUS_FIXTURE: ProtocolConformancePayload = createBaseFixture(
  "InvalidHealthStatus",
  {
    health: {
      status: "zombie" as any,
      lastHealthCheck: freshTimestamp(),
      uptime: 0.99,
      responseTime: 150,
      errorRate: 0.01,
      consecutiveErrors: 0,
      reliability: 90,
    },
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Negative Fixtures: Invalid Uptime Ranges
// ────────────────────────────────────────────────────────────────────────────

export const UPTIME_ABOVE_ONE_FIXTURE: ProtocolConformancePayload = createBaseFixture("UptimeAboveOne", {
  health: {
    status: "healthy",
    lastHealthCheck: freshTimestamp(),
    uptime: 1.5,
    responseTime: 150,
    errorRate: 0.01,
    consecutiveErrors: 0,
    reliability: 90,
  },
});

export const UPTIME_NEGATIVE_FIXTURE: ProtocolConformancePayload = createBaseFixture("UptimeNegative", {
  health: {
    status: "healthy",
    lastHealthCheck: freshTimestamp(),
    uptime: -0.1,
    responseTime: 150,
    errorRate: 0.01,
    consecutiveErrors: 0,
    reliability: 90,
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Fixture Suite Collection
// ────────────────────────────────────────────────────────────────────────────

export const POSITIVE_FIXTURES = {
  blend: BLEND_VALID_FIXTURE,
  soroswap: SOROSWAP_VALID_FIXTURE,
};

export const NEGATIVE_FIXTURES = {
  staleData: STALE_DATA_FIXTURE,
  missingDecimals: MISSING_DECIMALS_FIXTURE,
  missingAssetSymbol: MISSING_ASSET_SYMBOL_FIXTURE,
  invalidApyTooHigh: INVALID_APY_TOO_HIGH_FIXTURE,
  invalidApyNegative: INVALID_APY_NEGATIVE_FIXTURE,
  invalidApyNan: INVALID_APY_NAN_FIXTURE,
  negativeTvl: NEGATIVE_TVL_FIXTURE,
  invalidTvlInfinity: INVALID_TVL_INFINITY_FIXTURE,
  emptyAssets: EMPTY_ASSETS_FIXTURE,
  providerUnavailable: PROVIDER_UNAVAILABLE_FIXTURE,
  providerDegraded: PROVIDER_DEGRADED_FIXTURE,
  missingMetadata: MISSING_METADATA_FIXTURE,
  missingApy: MISSING_APY_FIXTURE,
  missingHealth: MISSING_HEALTH_FIXTURE,
  missingFreshness: MISSING_FRESHNESS_FIXTURE,
  missingProvider: MISSING_PROVIDER_FIXTURE,
  missingCapabilities: MISSING_CAPABILITIES_FIXTURE,
  invalidHealthStatus: INVALID_HEALTH_STATUS_FIXTURE,
  uptimeAboveOne: UPTIME_ABOVE_ONE_FIXTURE,
  uptimeNegative: UPTIME_NEGATIVE_FIXTURE,
};

export const ALL_FIXTURES = {
  positive: POSITIVE_FIXTURES,
  negative: NEGATIVE_FIXTURES,
};
