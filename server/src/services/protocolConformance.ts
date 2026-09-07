/**
 * Protocol Adapter Conformance Layer
 *
 * Defines the minimum contract every yield source must satisfy for data consistency
 * across ranking, health, compatibility, failover, and analytics services.
 *
 * This module provides:
 * - A comprehensive contract definition for adapter output
 * - Validation functions to enforce the contract
 * - Fixture-driven testing without network calls
 * - Capability matrices and conformance reports
 */

// ────────────────────────────────────────────────────────────────────────────
// Core Conformance Contract
// ────────────────────────────────────────────────────────────────────────────

export interface AdapterMetadata {
  protocolName: string;
  protocolId: string;
  version: string;
  lastUpdated: string;
  source: string;
  network: "mainnet" | "testnet";
}

export interface AssetData {
  symbol: string;
  contractId?: string;
  decimals?: number;
  displayDecimals?: number;
}

export interface HealthSignals {
  status: "healthy" | "degraded" | "stale" | "unavailable";
  lastHealthCheck: string;
  uptime: number; // 0-1
  responseTime: number; // milliseconds
  errorRate: number; // 0-1
  consecutiveErrors: number;
  reliability: number; // 0-100
}

export interface ApyBreakdown {
  baseApy: number; // 0-1 (not basis points)
  rewardApy: number; // 0-1
  compoundingApy: number; // 0-1
  feeDrag: number; // 0-1 (negative impact)
  totalApy: number; // 0-1
}

export interface RiskProfile {
  score: number; // 0-100
  tier: "low" | "medium" | "high";
  factors: {
    contractAge: number; // 0-100
    auditStatus: "passed" | "partial" | "none";
    liquidityDepth: number; // 0-100
    historicalVolatility: number; // 0-1
  };
}

export interface ProtocolConformancePayload {
  // Metadata (required)
  metadata: AdapterMetadata;

  // APY information (required)
  apy: ApyBreakdown;

  // TVL in USD (required)
  tvlUsd: number;

  // Supported assets (required)
  supportedAssets: AssetData[];

  // Freshness signals (required)
  freshness: {
    dataAge: number; // seconds since last update
    maxAcceptableAge: number; // seconds before data is stale
    fetchedAt: string; // ISO 8601 timestamp
  };

  // Health indicators (required)
  health: HealthSignals;

  // Risk profile (optional but strongly recommended)
  risk?: RiskProfile;

  // Provider metadata (required)
  provider: {
    id: string;
    name: string;
    website?: string;
    documentation?: string;
  };

  // Liquidity metrics (optional)
  liquidity?: {
    totalLiquidity: number;
    depths: Array<{
      asset: string;
      depth: number;
    }>;
  };

  // Reward streams (optional)
  rewards?: Array<{
    token: string;
    apy: number; // 0-1
    source: string;
  }>;

  // Fee structure (optional)
  fees?: {
    deposit: number; // 0-1
    withdraw: number; // 0-1
    management: number; // 0-1
    performance: number; // 0-1
  };

  // Capabilities indicator (required)
  capabilities: {
    deposit: boolean;
    withdraw: boolean;
    swap: boolean;
    quote: boolean;
    emergency: boolean;
  };

  // Custom fields allowed but should be minimal
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// Conformance Validation
// ────────────────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
  expected?: string;
  received?: string;
}

export interface ConformanceValidationResult {
  valid: boolean;
  stale: boolean;
  complete: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  capabilities: Record<string, boolean>;
}

const STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const VALID_APY_MIN = 0;
const VALID_APY_MAX = 1;
const VALID_HEALTH_STATUS = ["healthy", "degraded", "stale", "unavailable"];
const VALID_RISK_TIERS = ["low", "medium", "high"];
const VALID_AUDIT_STATUS = ["passed", "partial", "none"];

function isNumber(value: unknown): boolean {
  return typeof value === "number" && isFinite(value as number);
}

function isValidDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const ts = new Date(value as string).getTime();
  return !isNaN(ts);
}

function isInRange(value: unknown, min: number, max: number): boolean {
  return (
    isNumber(value) && (value as number) >= min && (value as number) <= max
  );
}

function validateApyBreakdown(apy: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!apy || typeof apy !== "object") {
    errors.push({
      field: "apy",
      code: "MISSING_OBJECT",
      message: "APY breakdown must be an object",
      severity: "error",
    });
    return errors;
  }

  const apyObj = apy as Record<string, unknown>;

  if (!isInRange(apyObj.baseApy, VALID_APY_MIN, VALID_APY_MAX)) {
    errors.push({
      field: "apy.baseApy",
      code: "INVALID_RANGE",
      message: "baseApy must be between 0 and 1",
      severity: "error",
      expected: "0 <= value <= 1",
      received: String(apyObj.baseApy),
    });
  }

  if (!isInRange(apyObj.rewardApy, VALID_APY_MIN, VALID_APY_MAX)) {
    errors.push({
      field: "apy.rewardApy",
      code: "INVALID_RANGE",
      message: "rewardApy must be between 0 and 1",
      severity: "error",
      expected: "0 <= value <= 1",
      received: String(apyObj.rewardApy),
    });
  }

  if (!isInRange(apyObj.compoundingApy, VALID_APY_MIN, VALID_APY_MAX)) {
    errors.push({
      field: "apy.compoundingApy",
      code: "INVALID_RANGE",
      message: "compoundingApy must be between 0 and 1",
      severity: "error",
      expected: "0 <= value <= 1",
      received: String(apyObj.compoundingApy),
    });
  }

  if (!isInRange(apyObj.totalApy, VALID_APY_MIN, VALID_APY_MAX)) {
    errors.push({
      field: "apy.totalApy",
      code: "INVALID_RANGE",
      message: "totalApy must be between 0 and 1",
      severity: "error",
      expected: "0 <= value <= 1",
      received: String(apyObj.totalApy),
    });
  }

  return errors;
}

function validateAssets(assets: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(assets)) {
    errors.push({
      field: "supportedAssets",
      code: "INVALID_TYPE",
      message: "supportedAssets must be an array",
      severity: "error",
    });
    return errors;
  }

  if (assets.length === 0) {
    errors.push({
      field: "supportedAssets",
      code: "EMPTY_ARRAY",
      message: "At least one supported asset is required",
      severity: "error",
    });
    return errors;
  }

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i] as Record<string, unknown>;
    if (!asset.symbol || typeof asset.symbol !== "string") {
      errors.push({
        field: `supportedAssets[${i}].symbol`,
        code: "MISSING_SYMBOL",
        message: "Each asset must have a symbol string",
        severity: "error",
      });
    }
    if (asset.decimals !== undefined && !isNumber(asset.decimals)) {
      errors.push({
        field: `supportedAssets[${i}].decimals`,
        code: "INVALID_DECIMALS",
        message: "decimals must be a finite number",
        severity: "warning",
      });
    }
  }

  return errors;
}

function validateHealthSignals(health: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!health || typeof health !== "object") {
    errors.push({
      field: "health",
      code: "MISSING_OBJECT",
      message: "health must be an object",
      severity: "error",
    });
    return errors;
  }

  const healthObj = health as Record<string, unknown>;

  if (!VALID_HEALTH_STATUS.includes(healthObj.status as string)) {
    errors.push({
      field: "health.status",
      code: "INVALID_STATUS",
      message: `status must be one of: ${VALID_HEALTH_STATUS.join(", ")}`,
      severity: "error",
      received: String(healthObj.status),
    });
  }

  if (!isValidDate(healthObj.lastHealthCheck)) {
    errors.push({
      field: "health.lastHealthCheck",
      code: "INVALID_DATE",
      message: "lastHealthCheck must be a valid ISO 8601 date",
      severity: "error",
      received: String(healthObj.lastHealthCheck),
    });
  }

  if (!isInRange(healthObj.uptime, 0, 1)) {
    errors.push({
      field: "health.uptime",
      code: "INVALID_RANGE",
      message: "uptime must be between 0 and 1",
      severity: "error",
      expected: "0 <= value <= 1",
      received: String(healthObj.uptime),
    });
  }

  if (!isNumber(healthObj.responseTime)) {
    errors.push({
      field: "health.responseTime",
      code: "MISSING_NUMBER",
      message: "responseTime must be a finite number (milliseconds)",
      severity: "error",
    });
  }

  if (!isInRange(healthObj.errorRate, 0, 1)) {
    errors.push({
      field: "health.errorRate",
      code: "INVALID_RANGE",
      message: "errorRate must be between 0 and 1",
      severity: "error",
      expected: "0 <= value <= 1",
      received: String(healthObj.errorRate),
    });
  }

  if (
    !isNumber(healthObj.reliability) ||
    (healthObj.reliability as number) < 0 ||
    (healthObj.reliability as number) > 100
  ) {
    errors.push({
      field: "health.reliability",
      code: "INVALID_RANGE",
      message: "reliability must be between 0 and 100",
      severity: "error",
      expected: "0 <= value <= 100",
      received: String(healthObj.reliability),
    });
  }

  return errors;
}

function validateFreshness(freshness: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!freshness || typeof freshness !== "object") {
    errors.push({
      field: "freshness",
      code: "MISSING_OBJECT",
      message: "freshness must be an object",
      severity: "error",
    });
    return errors;
  }

  const freshnessObj = freshness as Record<string, unknown>;

  if (!isNumber(freshnessObj.dataAge) || (freshnessObj.dataAge as number) < 0) {
    errors.push({
      field: "freshness.dataAge",
      code: "INVALID_AGE",
      message: "dataAge must be a non-negative number (seconds)",
      severity: "error",
    });
  }

  if (
    !isNumber(freshnessObj.maxAcceptableAge) ||
    (freshnessObj.maxAcceptableAge as number) <= 0
  ) {
    errors.push({
      field: "freshness.maxAcceptableAge",
      code: "INVALID_AGE",
      message: "maxAcceptableAge must be a positive number (seconds)",
      severity: "error",
    });
  }

  if (!isValidDate(freshnessObj.fetchedAt)) {
    errors.push({
      field: "freshness.fetchedAt",
      code: "INVALID_DATE",
      message: "fetchedAt must be a valid ISO 8601 date",
      severity: "error",
      received: String(freshnessObj.fetchedAt),
    });
  }

  return errors;
}

function validateRisk(risk: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!risk || typeof risk !== "object") {
    return errors; // risk is optional
  }

  const riskObj = risk as Record<string, unknown>;

  if (!isInRange(riskObj.score, 0, 100)) {
    errors.push({
      field: "risk.score",
      code: "INVALID_RANGE",
      message: "score must be between 0 and 100",
      severity: "warning",
      expected: "0 <= value <= 100",
      received: String(riskObj.score),
    });
  }

  if (!VALID_RISK_TIERS.includes(riskObj.tier as string)) {
    errors.push({
      field: "risk.tier",
      code: "INVALID_TIER",
      message: `tier must be one of: ${VALID_RISK_TIERS.join(", ")}`,
      severity: "warning",
      received: String(riskObj.tier),
    });
  }

  const factors = riskObj.factors as Record<string, unknown> | undefined;
  if (factors) {
    if (!isInRange(factors.contractAge, 0, 100)) {
      errors.push({
        field: "risk.factors.contractAge",
        code: "INVALID_RANGE",
        message: "contractAge must be between 0 and 100",
        severity: "warning",
      });
    }

    if (!VALID_AUDIT_STATUS.includes(factors.auditStatus as string)) {
      errors.push({
        field: "risk.factors.auditStatus",
        code: "INVALID_STATUS",
        message: `auditStatus must be one of: ${VALID_AUDIT_STATUS.join(", ")}`,
        severity: "warning",
      });
    }

    if (!isInRange(factors.liquidityDepth, 0, 100)) {
      errors.push({
        field: "risk.factors.liquidityDepth",
        code: "INVALID_RANGE",
        message: "liquidityDepth must be between 0 and 100",
        severity: "warning",
      });
    }

    if (!isInRange(factors.historicalVolatility, 0, 1)) {
      errors.push({
        field: "risk.factors.historicalVolatility",
        code: "INVALID_RANGE",
        message: "historicalVolatility must be between 0 and 1",
        severity: "warning",
      });
    }
  }

  return errors;
}

export function validateConformancePayload(
  payload: unknown,
): ConformanceValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  let stale = false;
  let complete = true;

  if (!payload || typeof payload !== "object") {
    errors.push({
      field: "root",
      code: "INVALID_PAYLOAD",
      message: "Payload must be a non-null object",
      severity: "error",
    });
    return {
      valid: false,
      stale: true,
      complete: false,
      errors,
      warnings,
      capabilities: {},
    };
  }

  const p = payload as Record<string, unknown>;

  // Required metadata
  if (!p.metadata || typeof p.metadata !== "object") {
    errors.push({
      field: "metadata",
      code: "MISSING_OBJECT",
      message: "metadata is required",
      severity: "error",
    });
  } else {
    const metadata = p.metadata as Record<string, unknown>;
    if (!metadata.protocolName || typeof metadata.protocolName !== "string") {
      errors.push({
        field: "metadata.protocolName",
        code: "MISSING_STRING",
        message: "metadata.protocolName is required",
        severity: "error",
      });
    }
    if (!metadata.version || typeof metadata.version !== "string") {
      errors.push({
        field: "metadata.version",
        code: "MISSING_STRING",
        message: "metadata.version is required",
        severity: "error",
      });
    }
    if (!isValidDate(metadata.lastUpdated)) {
      errors.push({
        field: "metadata.lastUpdated",
        code: "INVALID_DATE",
        message: "metadata.lastUpdated must be a valid ISO 8601 date",
        severity: "error",
      });
    }
  }

  // APY
  if (!p.apy) {
    errors.push({
      field: "apy",
      code: "MISSING_FIELD",
      message: "apy is required",
      severity: "error",
    });
  } else {
    errors.push(...validateApyBreakdown(p.apy));
  }

  // TVL
  if (!isNumber(p.tvlUsd)) {
    errors.push({
      field: "tvlUsd",
      code: "INVALID_TYPE",
      message: "tvlUsd must be a finite number",
      severity: "error",
    });
  } else if ((p.tvlUsd as number) < 0) {
    errors.push({
      field: "tvlUsd",
      code: "NEGATIVE_VALUE",
      message: "tvlUsd cannot be negative",
      severity: "error",
    });
  }

  // Assets
  if (!p.supportedAssets) {
    errors.push({
      field: "supportedAssets",
      code: "MISSING_FIELD",
      message: "supportedAssets is required",
      severity: "error",
    });
  } else {
    errors.push(...validateAssets(p.supportedAssets));
  }

  // Freshness
  if (!p.freshness) {
    errors.push({
      field: "freshness",
      code: "MISSING_FIELD",
      message: "freshness is required",
      severity: "error",
    });
  } else {
    errors.push(...validateFreshness(p.freshness));
    const freshnessObj = p.freshness as Record<string, unknown>;
    if (isValidDate(freshnessObj.fetchedAt)) {
      const fetchTime = new Date(freshnessObj.fetchedAt as string).getTime();
      if (Date.now() - fetchTime > STALENESS_THRESHOLD_MS) {
        stale = true;
      }
    }
  }

  // Health
  if (!p.health) {
    errors.push({
      field: "health",
      code: "MISSING_FIELD",
      message: "health is required",
      severity: "error",
    });
  } else {
    errors.push(...validateHealthSignals(p.health));
  }

  // Provider
  if (!p.provider || typeof p.provider !== "object") {
    errors.push({
      field: "provider",
      code: "MISSING_OBJECT",
      message: "provider is required",
      severity: "error",
    });
  } else {
    const provider = p.provider as Record<string, unknown>;
    if (!provider.id || typeof provider.id !== "string") {
      errors.push({
        field: "provider.id",
        code: "MISSING_STRING",
        message: "provider.id is required",
        severity: "error",
      });
    }
    if (!provider.name || typeof provider.name !== "string") {
      errors.push({
        field: "provider.name",
        code: "MISSING_STRING",
        message: "provider.name is required",
        severity: "error",
      });
    }
  }

  // Capabilities
  if (!p.capabilities || typeof p.capabilities !== "object") {
    errors.push({
      field: "capabilities",
      code: "MISSING_OBJECT",
      message: "capabilities is required",
      severity: "error",
    });
  }

  // Risk (optional but validate if present)
  if (p.risk) {
    const riskErrors = validateRisk(p.risk);
    warnings.push(...riskErrors.filter((e) => e.severity === "warning"));
    errors.push(...riskErrors.filter((e) => e.severity === "error"));
  }

  // Check completeness
  const requiredFields = [
    "metadata",
    "apy",
    "tvlUsd",
    "supportedAssets",
    "freshness",
    "health",
    "provider",
    "capabilities",
  ];
  const missingRequired = requiredFields.filter((f) => !p[f]);
  if (missingRequired.length > 0) {
    complete = false;
  }

  const capabilities = (p.capabilities as Record<string, unknown>) || {};

  return {
    valid: errors.length === 0,
    stale,
    complete,
    errors,
    warnings,
    capabilities: {
      deposit: Boolean(capabilities.deposit),
      withdraw: Boolean(capabilities.withdraw),
      swap: Boolean(capabilities.swap),
      quote: Boolean(capabilities.quote),
      emergency: Boolean(capabilities.emergency),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Capability Matrix
// ────────────────────────────────────────────────────────────────────────────

export interface CapabilityMatrix {
  protocols: string[];
  capabilities: Record<string, Record<string, boolean>>;
  summary: {
    totalProtocols: number;
    totalCapabilities: number;
    coverage: number; // 0-1
    criticalGaps: string[];
  };
}

export function buildCapabilityMatrix(
  payloads: Map<string, ProtocolConformancePayload>,
): CapabilityMatrix {
  const protocols = Array.from(payloads.keys());
  const capabilities: Record<string, Record<string, boolean>> = {};
  const requiredCaps = ["deposit", "withdraw", "quote"];

  protocols.forEach((protocol) => {
    const payload = payloads.get(protocol)!;
    capabilities[protocol] = {
      deposit: payload.capabilities.deposit,
      withdraw: payload.capabilities.withdraw,
      swap: payload.capabilities.swap,
      quote: payload.capabilities.quote,
      emergency: payload.capabilities.emergency,
    };
  });

  const totalCapabilitySlots = protocols.length * 5;
  const filledSlots = protocols.reduce((sum, protocol) => {
    return sum + Object.values(capabilities[protocol]).filter((v) => v).length;
  }, 0);

  const coverage =
    totalCapabilitySlots > 0 ? filledSlots / totalCapabilitySlots : 0;

  const criticalGaps: string[] = [];
  protocols.forEach((protocol) => {
    const caps = capabilities[protocol];
    const missing = requiredCaps.filter(
      (cap) => !caps[cap as keyof typeof caps],
    );
    if (missing.length > 0) {
      criticalGaps.push(`${protocol}: missing ${missing.join(", ")}`);
    }
  });

  return {
    protocols,
    capabilities,
    summary: {
      totalProtocols: protocols.length,
      totalCapabilities: 5,
      coverage,
      criticalGaps,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Conformance Report
// ────────────────────────────────────────────────────────────────────────────

export interface ConformanceReport {
  timestamp: string;
  protocols: Array<{
    name: string;
    valid: boolean;
    stale: boolean;
    complete: boolean;
    errors: number;
    warnings: number;
    capabilities: Record<string, boolean>;
  }>;
  summary: {
    totalProtocols: number;
    validProtocols: number;
    staleProtocols: number;
    partialProtocols: number;
    errorCount: number;
    warningCount: number;
    coverage: number;
  };
}

export function generateConformanceReport(
  validations: Map<string, ConformanceValidationResult>,
  payloads: Map<string, ProtocolConformancePayload>,
): ConformanceReport {
  const protocols = Array.from(validations.entries())
    .map(([name, result]) => ({
      name,
      valid: result.valid,
      stale: result.stale,
      complete: result.complete,
      errors: result.errors.length,
      warnings: result.warnings.length,
      capabilities: result.capabilities,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const validCount = protocols.filter((p) => p.valid).length;
  const staleCount = protocols.filter((p) => p.stale).length;
  const partialCount = protocols.filter((p) => !p.complete).length;
  const errorCount = protocols.reduce((sum, p) => sum + p.errors, 0);
  const warningCount = protocols.reduce((sum, p) => sum + p.warnings, 0);

  const capMatrix = buildCapabilityMatrix(payloads);

  return {
    timestamp: new Date().toISOString(),
    protocols,
    summary: {
      totalProtocols: protocols.length,
      validProtocols: validCount,
      staleProtocols: staleCount,
      partialProtocols: partialCount,
      errorCount,
      warningCount,
      coverage: capMatrix.summary.coverage,
    },
  };
}
