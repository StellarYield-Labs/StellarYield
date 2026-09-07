# Protocol Adapter Onboarding Guide

This guide explains how to add a new protocol adapter to StellarYield and ensure it meets the conformance contract before being registered for production use.

## Table of Contents

1. [Overview](#overview)
2. [Conformance Contract](#conformance-contract)
3. [Implementation Checklist](#implementation-checklist)
4. [Step-by-Step Implementation](#step-by-step-implementation)
5. [Testing Your Adapter](#testing-your-adapter)
6. [Production Readiness](#production-readiness)
7. [Troubleshooting](#troubleshooting)

---

## Overview

Every protocol adapter in StellarYield must satisfy a **conformance contract** that guarantees:

- **Data Consistency**: All fields are present, correctly typed, and within valid ranges
- **Health Signals**: Provider uptime, latency, and error rates are tracked
- **Freshness**: Data age is reported and stale data is detected
- **Capabilities**: Supported operations (deposit, withdraw, swap, quote, emergency) are declared
- **Error Handling**: Failures are classified as retryable or terminal

The conformance layer prevents incomplete or malformed adapter output from being consumed by:
- Yield ranking service
- Source health registry
- Failover engine
- Compatibility checks
- Portfolio analytics

---

## Conformance Contract

Every adapter must return a `ProtocolConformancePayload` with these fields:

### Required Fields

#### `metadata` (Object)
- `protocolName` (string): Canonical protocol name (e.g., "Blend", "Soroswap")
- `protocolId` (string): Unique identifier for the protocol
- `version` (string): Adapter/protocol version (e.g., "2.1.0")
- `lastUpdated` (ISO 8601 string): When metadata was last updated
- `source` (string): Data source ("api", "oracle", "chain")
- `network` (enum): "mainnet" or "testnet"

#### `apy` (Object) - Annual Percentage Yield Breakdown
- `baseApy` (number): Base yield [0.0, 1.0] (0% to 100%)
- `rewardApy` (number): Rewards APY [0.0, 1.0]
- `compoundingApy` (number): Compounding impact [0.0, 1.0]
- `feeDrag` (number): Fee impact, typically negative [-1.0, 0.0]
- `totalApy` (number): Sum of all components [0.0, 1.0]

**Validation Rules**:
- Each component must be a finite number
- Each component must be within [0.0, 1.0] (baseApy, rewardApy, compoundingApy, totalApy)
- Sum of components should approximately equal totalApy

#### `tvlUsd` (number)
- Total Value Locked in USD
- Must be >= 0 and finite
- Cannot be NaN or Infinity

#### `supportedAssets` (Array)
- Array of assets the protocol handles
- Each asset must have:
  - `symbol` (string): Asset symbol (e.g., "USDC", "XLM", "BLND")
  - `contractId` (optional string): Contract address
  - `decimals` (optional number): Asset decimals (e.g., 7, 18)
- Array must have at least one asset

**Validation Rules**:
- Cannot be empty
- Each asset must have a non-empty symbol
- Symbols should be uppercase

#### `freshness` (Object)
- `dataAge` (number): Seconds since last data update (>= 0)
- `maxAcceptableAge` (number): Max acceptable age in seconds (> 0)
- `fetchedAt` (ISO 8601 string): When data was fetched

**Validation Rules**:
- dataAge must be non-negative
- maxAcceptableAge must be positive
- fetchedAt must be a valid ISO 8601 date
- Data is considered "stale" if dataAge > maxAcceptableAge or fetchedAt is older than 5 minutes

#### `health` (Object)
- `status` (enum): "healthy" | "degraded" | "stale" | "unavailable"
- `lastHealthCheck` (ISO 8601 string): Last health status check
- `uptime` (number): Provider uptime [0.0, 1.0]
- `responseTime` (number): Average response time (milliseconds)
- `errorRate` (number): Error rate [0.0, 1.0]
- `consecutiveErrors` (number): Count of consecutive failures (>= 0)
- `reliability` (number): Overall reliability score [0, 100]

**Validation Rules**:
- status must be one of the valid enum values
- uptime, errorRate must be in [0.0, 1.0]
- reliability must be in [0, 100]
- responseTime must be a positive number

#### `provider` (Object)
- `id` (string): Provider identifier
- `name` (string): Human-readable provider name
- `website` (optional string): Provider website URL
- `documentation` (optional string): API docs URL

#### `capabilities` (Object)
- `deposit` (boolean): Can deposit funds
- `withdraw` (boolean): Can withdraw funds
- `swap` (boolean): Can swap between assets
- `quote` (boolean): Can provide swap quotes
- `emergency` (boolean): Can perform emergency recovery

**Validation Rules**:
- At least deposit, withdraw, and quote should be supported for most adapters
- These declarations must match actual implementation

### Optional Fields

#### `risk` (Object)
- `score` (number): Risk score [0, 100]
- `tier` (enum): "low" | "medium" | "high"
- `factors` (Object):
  - `contractAge` (number): Age of contract [0, 100]
  - `auditStatus` (enum): "passed" | "partial" | "none"
  - `liquidityDepth` (number): Liquidity availability [0, 100]
  - `historicalVolatility` (number): Volatility measure [0.0, 1.0]

#### `liquidity` (Object)
- `totalLiquidity` (number): Total liquidity in USD
- `depths` (Array): Depth per asset

#### `rewards` (Array)
- Reward streams provided by protocol
- Each item has:
  - `token` (string): Reward token symbol
  - `apy` (number): Reward APY [0.0, 1.0]
  - `source` (string): Reward source

#### `fees` (Object)
- `deposit` (number): Deposit fee [0.0, 1.0]
- `withdraw` (number): Withdrawal fee [0.0, 1.0]
- `management` (number): Management fee [0.0, 1.0]
- `performance` (number): Performance fee [0.0, 1.0]

---

## Implementation Checklist

Before submitting an adapter for production, verify:

- [ ] Adapter is registered in `protocolAdapterRegistry.ts`
- [ ] Adapter factory function is defined
- [ ] `fetch()` function returns `ProtocolConformancePayload`
- [ ] All required fields are present
- [ ] All numeric values are finite (not NaN/Infinity)
- [ ] APY values are in [0.0, 1.0]
- [ ] TVL is >= 0
- [ ] At least one asset is declared
- [ ] Data freshness is reported (dataAge, maxAcceptableAge, fetchedAt)
- [ ] Health status is accurate (status, uptime, errorRate, reliability)
- [ ] Capabilities match implementation
- [ ] Error handling classifies errors as retryable vs terminal
- [ ] Unit tests pass
- [ ] Conformance tests pass (positive and negative scenarios)
- [ ] Integration tests pass
- [ ] Data is accurate and matches protocol's actual state
- [ ] Documentation includes how to add/update the adapter

---

## Step-by-Step Implementation

### Step 1: Create Adapter Factory

Create a new file in `server/src/adapters/` (or add to existing adapter file):

```typescript
// server/src/adapters/myProtocolAdapter.ts

import type { ProtocolConformancePayload } from "../services/protocolConformance";

export const myProtocolAdapterFactory = {
  protocolName: "MyProtocol",
  
  async fetch(): Promise<ProtocolConformancePayload> {
    // Fetch data from protocol's API
    const data = await fetchFromProtocolAPI();
    
    return {
      metadata: {
        protocolName: "MyProtocol",
        protocolId: "myprotocol-mainnet",
        version: "1.0.0",
        lastUpdated: new Date().toISOString(),
        source: "api",
        network: "mainnet",
      },
      
      apy: {
        baseApy: data.baseYield / 100,
        rewardApy: data.rewardYield / 100,
        compoundingApy: 0.005,
        feeDrag: data.management_fee / 100 * -1,
        totalApy: (data.baseYield + data.rewardYield - data.management_fee) / 100,
      },
      
      tvlUsd: data.tvl,
      
      supportedAssets: data.assets.map(asset => ({
        symbol: asset.symbol.toUpperCase(),
        contractId: asset.contract_id,
        decimals: asset.decimals,
      })),
      
      freshness: {
        dataAge: Math.floor((Date.now() - data.updated_at) / 1000),
        maxAcceptableAge: 300, // 5 minutes
        fetchedAt: new Date(data.updated_at).toISOString(),
      },
      
      health: {
        status: data.status === "up" ? "healthy" : "unavailable",
        lastHealthCheck: new Date().toISOString(),
        uptime: data.uptime_pct / 100,
        responseTime: data.response_time_ms,
        errorRate: data.error_count / data.total_requests,
        consecutiveErrors: data.consecutive_errors,
        reliability: data.reliability_score,
      },
      
      provider: {
        id: "myprotocol",
        name: "MyProtocol",
        website: "https://myprotocol.com",
        documentation: "https://docs.myprotocol.com",
      },
      
      capabilities: {
        deposit: true,
        withdraw: true,
        swap: true,
        quote: true,
        emergency: true,
      },
      
      risk: {
        score: 30,
        tier: "low",
        factors: {
          contractAge: 85,
          auditStatus: "passed",
          liquidityDepth: 92,
          historicalVolatility: 0.08,
        },
      },
    };
  },
  
  description: "Adapter for MyProtocol mainnet",
};
```

### Step 2: Create Positive Test Fixture

Add to `server/src/services/__tests__/fixtures/conformanceFixtures.ts`:

```typescript
export const MYPROTOCOL_VALID_FIXTURE: ProtocolConformancePayload = createBaseFixture("MyProtocol", {
  metadata: {
    protocolName: "MyProtocol",
    protocolId: "myprotocol-mainnet",
    version: "1.0.0",
    lastUpdated: freshTimestamp(),
    source: "api",
    network: "mainnet",
  },
  apy: {
    baseApy: 0.085,
    rewardApy: 0.012,
    compoundingApy: 0.004,
    feeDrag: -0.005,
    totalApy: 0.096,
  },
  tvlUsd: 25_000_000,
  // ... other fields
});
```

### Step 3: Register Adapter

In `server/src/index.ts` or appropriate initialization file:

```typescript
import { registerAdapters } from "./services/protocolAdapterRegistry";
import { myProtocolAdapterFactory } from "./adapters/myProtocolAdapter";

async function initializeAdapters() {
  const result = await registerAdapters([
    myProtocolAdapterFactory,
    // ... other adapters
  ]);
  
  if (result.failed.length > 0) {
    console.error("Failed to register adapters:", result.failed);
  }
}

initializeAdapters().catch(console.error);
```

### Step 4: Add Unit Tests

Create `server/src/adapters/__tests__/myProtocolAdapter.test.ts`:

```typescript
import { myProtocolAdapterFactory } from "../myProtocolAdapter";
import { validateConformancePayload } from "../../services/protocolConformance";

describe("MyProtocol Adapter", () => {
  it("returns conformant payload", async () => {
    const payload = await myProtocolAdapterFactory.fetch();
    const result = validateConformancePayload(payload);
    
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
  
  it("declares all capabilities", async () => {
    const payload = await myProtocolAdapterFactory.fetch();
    
    expect(payload.capabilities.deposit).toBe(true);
    expect(payload.capabilities.withdraw).toBe(true);
    expect(payload.capabilities.quote).toBe(true);
  });
  
  it("reports fresh data", async () => {
    const payload = await myProtocolAdapterFactory.fetch();
    
    expect(payload.freshness.dataAge).toBeLessThan(payload.freshness.maxAcceptableAge);
    expect(payload.health.status).toBe("healthy");
  });
});
```

---

## Testing Your Adapter

### Run Unit Tests

```bash
cd server
npm run test -- myProtocolAdapter.test.ts
```

### Run Conformance Tests

```bash
npm run test -- protocolConformance.test.ts
```

### Validate Against Registry

```bash
npm run test -- protocolAdapterRegistry.test.ts
```

### Manual Conformance Check

```typescript
import { validateConformancePayload } from "./services/protocolConformance";
import { myProtocolAdapterFactory } from "./adapters/myProtocolAdapter";

const payload = await myProtocolAdapterFactory.fetch();
const result = validateConformancePayload(payload);

if (!result.valid) {
  console.error("Errors:", result.errors);
  console.error("Warnings:", result.warnings);
} else {
  console.log("✓ Adapter is conformant");
}
```

---

## Production Readiness

Before production deployment:

1. **Data Accuracy**: Verify APY, TVL, assets match protocol's actual state
2. **Error Handling**: Test behavior under network failures, timeouts
3. **Stale Data**: Verify data age is correctly reported
4. **Capabilities**: Ensure declared capabilities match actual implementation
5. **Risk Profile**: Audit contract age, audit status, liquidity depth
6. **Load Testing**: Verify adapter handles high request volume
7. **Monitoring**: Set up alerts for adapter failures
8. **Documentation**: Update team docs with adapter details

### Performance Requirements

- Adapter fetch should complete in < 5 seconds
- Data freshness should be < 5 minutes
- Error rate should be < 0.1%
- Uptime should be > 99%

---

## Troubleshooting

### Issue: "APY values out of range [0, 1]"

**Solution**: Ensure APY values are decimals (0.065 = 6.5%), not basis points (650).

```typescript
// ✗ Wrong (basis points)
baseApy: 650 / 10000 // Should be 0.065, but this is correct

// ✓ Correct
baseApy: 0.065
```

### Issue: "TVL is NaN or Infinity"

**Solution**: Check API response contains valid number, handle edge cases.

```typescript
tvlUsd: Math.max(0, data.tvl || 0)
```

### Issue: "Data is stale"

**Solution**: Ensure fetchedAt is current ISO 8601 date.

```typescript
freshness: {
  dataAge: Math.floor((Date.now() - data.updated_at) / 1000),
  maxAcceptableAge: 300,
  fetchedAt: new Date(data.updated_at).toISOString(), // Must be valid
}
```

### Issue: "Asset symbol missing or empty"

**Solution**: Provide uppercase, non-empty asset symbols.

```typescript
supportedAssets: data.assets.map(asset => ({
  symbol: asset.symbol.toUpperCase() || "UNKNOWN", // Never empty
  // ...
}))
```

### Issue: "Registration fails in strict mode"

**Solution**: Check all validation errors and address each one.

```typescript
const registry = new ProtocolAdapterRegistry();
const result = await registry.register(adapterFactory, false);

if (!result.registered) {
  console.log("Errors:", result.errors);
}
```

---

## Support

For questions or issues:
1. Review this guide
2. Check existing adapter implementations in `server/src/adapters/`
3. Review conformance test fixtures in `server/src/services/__tests__/fixtures/`
4. Open an issue with conformance test results
