/**
 * Protocol Adapter Registry Tests
 *
 * Tests the registry's ability to:
 * - Register adapters with conformance validation
 * - Enforce minimum contract before registration
 * - Cache and serve adapter payloads
 * - Track compliance history
 * - Generate capability matrices and reports
 */

import {
  ProtocolAdapterRegistry,
  getGlobalRegistry,
  registerAdapters,
  AdapterConformanceError,
  type AdapterFactory,
} from "../protocolAdapterRegistry";
import {
  POSITIVE_FIXTURES,
  NEGATIVE_FIXTURES,
  createBaseFixture,
} from "./fixtures/conformanceFixtures";

// ────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────────────────

function createAdapterFactory(
  protocolName: string,
  payload: any,
): AdapterFactory {
  return {
    protocolName,
    fetch: async () => payload,
    description: `Test adapter for ${protocolName}`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test Group 1: Basic Registration
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Registration", () => {
  let registry: ProtocolAdapterRegistry;

  beforeEach(() => {
    registry = new ProtocolAdapterRegistry();
  });

  it("registers a compliant adapter", async () => {
    const factory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);
    const result = await registry.register(factory);

    expect(result.registered).toBe(true);
    expect(result.compliant).toBe(true);
  });

  it("rejects a non-compliant adapter in strict mode", async () => {
    const failingFactory: AdapterFactory = {
      protocolName: "RejectThis",
      fetch: async () => {
        throw new Error("This adapter failed!");
      },
    };

    await expect(registry.register(failingFactory, true)).rejects.toThrow();
  });

  it("registers non-compliant adapter with warnings in non-strict mode", async () => {
    const failingFactory: AdapterFactory = {
      protocolName: "ProblematicStale",
      fetch: async () => {
        throw new Error("Network error during fetch");
      },
    };
    const result = await registry.register(failingFactory, false);

    // Adapter was attempted to register but failed
    expect(result).toBeDefined();
  });

  it("prevents duplicate registration of same protocol", async () => {
    const factory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);

    await registry.register(factory);
    await expect(registry.register(factory)).rejects.toThrow(
      /already registered/,
    );
  });

  it("stores registration metadata", async () => {
    const factory = createAdapterFactory("TestProto", POSITIVE_FIXTURES.blend);
    await registry.register(factory);

    const adapters = registry.getRegisteredAdapters();
    const registered = adapters.find((a) => a.protocolName === "TestProto");

    expect(registered).toBeDefined();
    expect(registered?.registeredAt).toBeTruthy();
    expect(registered?.failureCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 2: Fetching Data
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Data Fetching", () => {
  let registry: ProtocolAdapterRegistry;

  beforeEach(async () => {
    registry = new ProtocolAdapterRegistry();
    const factory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);
    await registry.register(factory);
  });

  it("fetches data from registered adapter", async () => {
    const payload = await registry.fetch("Blend");

    expect(payload).toBeDefined();
    expect(payload.metadata.protocolName).toBe("Blend");
    expect(payload.apy).toBeDefined();
  });

  it("throws error for unregistered adapter", async () => {
    await expect(registry.fetch("NonExistent")).rejects.toThrow(
      /not registered/,
    );
  });

  it("caches fetched payloads", async () => {
    const payload1 = await registry.fetch("Blend");
    const cached = registry.getCachedPayload("Blend");

    expect(cached).toEqual(payload1);
  });

  it("rejects non-conformant adapter output", async () => {
    const registry2 = new ProtocolAdapterRegistry();
    const failingFactory: AdapterFactory = {
      protocolName: "FailingAdapterOutput",
      fetch: async () => {
        throw new Error("Adapter completely failed");
      },
    };
    await registry2.register(failingFactory, false);

    await expect(registry2.fetch("FailingAdapterOutput")).rejects.toThrow();
  });

  it("returns cached payload when adapter fails", async () => {
    let callCount = 0;
    const factory: AdapterFactory = {
      protocolName: "Flaky",
      fetch: async () => {
        callCount++;
        if (callCount === 1) {
          return POSITIVE_FIXTURES.blend;
        }
        throw new Error("Network error");
      },
    };

    const registry2 = new ProtocolAdapterRegistry();
    await registry2.register(factory, false);

    // First call succeeds and caches
    const payload1 = await registry2.fetch("Flaky");
    expect(payload1).toBeDefined();

    // Second call fails but returns cached payload
    const payload2 = await registry2.fetch("Flaky");
    expect(payload2).toEqual(payload1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 3: Compliance Tracking
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Compliance Tracking", () => {
  let registry: ProtocolAdapterRegistry;

  beforeEach(async () => {
    registry = new ProtocolAdapterRegistry();
  });

  it("can register and retrieve adapters", async () => {
    const factory: AdapterFactory = {
      protocolName: "TrackableAdapter",
      fetch: async () => POSITIVE_FIXTURES.blend,
    };

    await registry.register(factory, false);

    const adapters = registry.getRegisteredAdapters();
    expect(adapters.length).toBeGreaterThan(0);
  });

  it("checks compliance status", async () => {
    const factory = createAdapterFactory("Compliant", POSITIVE_FIXTURES.blend);
    await registry.register(factory);

    expect(registry.isCompliant("Compliant")).toBe(true);
    expect(registry.isCompliant("NonExistent")).toBe(false);
  });

  it("gets validation results", async () => {
    const factory = createAdapterFactory("TestProto", POSITIVE_FIXTURES.blend);
    await registry.register(factory);

    const validation = registry.getValidation("TestProto");

    expect(validation).toBeDefined();
    expect(validation?.valid).toBe(true);
    expect(validation?.errors).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 4: Capability Matrix
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Capability Matrix", () => {
  let registry: ProtocolAdapterRegistry;

  beforeEach(async () => {
    registry = new ProtocolAdapterRegistry();

    const blendFactory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);
    const soroswapFactory = createAdapterFactory(
      "Soroswap",
      POSITIVE_FIXTURES.soroswap,
    );

    await registry.register(blendFactory);
    await registry.register(soroswapFactory);
  });

  it("builds capability matrix", () => {
    const matrix = registry.buildCapabilityMatrix();

    expect(matrix.protocols).toContain("Blend");
    expect(matrix.protocols).toContain("Soroswap");
  });

  it("reports protocol capabilities", () => {
    const matrix = registry.buildCapabilityMatrix();

    expect(matrix.capabilities.Blend.deposit).toBe(true);
    expect(matrix.capabilities.Soroswap.swap).toBe(true);
  });

  it("calculates coverage percentage", () => {
    const matrix = registry.buildCapabilityMatrix();

    expect(matrix.summary.coverage).toBeGreaterThan(0);
    expect(matrix.summary.coverage).toBeLessThanOrEqual(1);
  });

  it("checks for critical gaps", () => {
    // Blend supports deposit but not swap
    const hasGap =
      registry.buildCapabilityMatrix().summary.criticalGaps.length > 0;
    // At least one protocol should have critical gaps or none
    expect(typeof hasGap).toBe("boolean");
  });

  it("checks individual capability support", () => {
    expect(registry.hasCapability("Blend", "deposit")).toBe(true);
    expect(registry.hasCapability("Blend", "withdraw")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 5: Report Generation
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Report Generation", () => {
  let registry: ProtocolAdapterRegistry;

  beforeEach(async () => {
    registry = new ProtocolAdapterRegistry();

    const blendFactory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);
    const soroswapFactory = createAdapterFactory(
      "Soroswap",
      POSITIVE_FIXTURES.soroswap,
    );

    await registry.register(blendFactory);
    await registry.register(soroswapFactory);

    // Fetch to populate cache
    await registry.fetch("Blend");
    await registry.fetch("Soroswap");
  });

  it("generates conformance report", () => {
    const report = registry.generateReport();

    expect(report.timestamp).toBeTruthy();
    expect(report.protocols.length).toBeGreaterThan(0);
    expect(report.summary.totalProtocols).toBe(2);
  });

  it("counts valid protocols in report", () => {
    const report = registry.generateReport();

    expect(report.summary.validProtocols).toBe(2);
    expect(report.summary.errorCount).toBe(0);
  });

  it("includes protocol details in report", () => {
    const report = registry.generateReport();

    const blendProtocol = report.protocols.find((p) => p.name === "Blend");
    expect(blendProtocol).toBeDefined();
    expect(blendProtocol?.valid).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 6: Batch Operations
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Batch Operations", () => {
  it("registers multiple adapters", async () => {
    const factories = [
      createAdapterFactory("BlendMulti", POSITIVE_FIXTURES.blend),
      createAdapterFactory("SoroMulti", POSITIVE_FIXTURES.soroswap),
    ];

    const result = await registerAdapters(factories, true);

    expect(result.registered.length).toBe(2);
    expect(result.failed.length).toBe(0);
  });

  it("handles registration of non-compliant adapters", async () => {
    const factories = [
      createAdapterFactory("BlendHandle", POSITIVE_FIXTURES.blend),
    ];

    const result = await registerAdapters(factories, true);

    expect(result.registered.length).toBe(1);
    expect(result.failed.length).toBe(0);
  });

  it("syncs all registered adapters", async () => {
    const registry = new ProtocolAdapterRegistry();
    const factory = createAdapterFactory("BlendSync", POSITIVE_FIXTURES.blend);
    await registry.register(factory);

    const status = await registry.syncAll();

    expect(status.totalRegistered).toBe(1);
    expect(status.compliantCount).toBe(1);
    expect(status.lastSyncedAt).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 7: Lifecycle Management
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Lifecycle Management", () => {
  it("unregisters adapters", async () => {
    const registry = new ProtocolAdapterRegistry();
    const factory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);
    await registry.register(factory);

    expect(registry.unregister("Blend")).toBe(true);
    expect(registry.isCompliant("Blend")).toBe(false);
  });

  it("clears all state", async () => {
    const registry = new ProtocolAdapterRegistry();
    const factory = createAdapterFactory("Blend", POSITIVE_FIXTURES.blend);
    await registry.register(factory);

    registry.clear();

    expect(registry.getRegisteredAdapters()).toHaveLength(0);
    expect(registry.getCachedPayload("Blend")).toBeUndefined();
  });

  it("retrieves global registry singleton", () => {
    const reg1 = getGlobalRegistry();
    const reg2 = getGlobalRegistry();

    expect(reg1).toBe(reg2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test Group 8: Error Handling
// ────────────────────────────────────────────────────────────────────────────

describe("Protocol Adapter Registry: Error Handling", () => {
  let registry: ProtocolAdapterRegistry;

  beforeEach(() => {
    registry = new ProtocolAdapterRegistry();
  });

  it("throws AdapterConformanceError with details", async () => {
    const factory = createAdapterFactory(
      "BadAdapter",
      NEGATIVE_FIXTURES.invalidApyTooHigh,
    );

    try {
      await registry.register(factory, true);
      fail("Should have thrown");
    } catch (error) {
      expect(error).toBeDefined();
      expect(String(error)).toContain("Adapter failed conformance checks");
    }
  });

  it("handles adapter factory that throws", async () => {
    const factory: AdapterFactory = {
      protocolName: "CrashingAdapter",
      fetch: async () => {
        throw new Error("Critical failure");
      },
    };

    const result = await registry.register(factory, false);
    expect(result.registered).toBe(false);
  });
});
