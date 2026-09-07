/**
 * Protocol Adapter Registry
 *
 * Central registry for protocol adapters with conformance enforcement.
 * Ensures all registered adapters meet the minimum contract before
 * being used by yield ranking, failover, compatibility, and health services.
 *
 * Key responsibilities:
 * - Register adapters with conformance validation
 * - Enforce that adapters pass the conformance test suite
 * - Provide normalized access to adapter outputs
 * - Track adapter compliance history
 * - Report on adapter capabilities and health
 */

import {
  validateConformancePayload,
  buildCapabilityMatrix,
  generateConformanceReport,
  type ProtocolConformancePayload,
  type ConformanceValidationResult,
  type CapabilityMatrix,
  type ConformanceReport,
} from "./protocolConformance";

// ────────────────────────────────────────────────────────────────────────────
// Adapter Registration Types
// ────────────────────────────────────────────────────────────────────────────

export interface AdapterFactory {
  protocolName: string;
  fetch: () => Promise<ProtocolConformancePayload>;
  description?: string;
}

export interface RegisteredAdapter {
  protocolName: string;
  factory: AdapterFactory;
  registeredAt: string;
  lastValidation?: {
    timestamp: string;
    result: ConformanceValidationResult;
  };
  failureCount: number;
  consecutiveFailures: number;
}

export interface AdapterRegistryStatus {
  totalRegistered: number;
  compliantCount: number;
  nonCompliantCount: number;
  lastSyncedAt: string;
  adapters: Array<{
    protocolName: string;
    compliant: boolean;
    lastValidation?: string;
    failureCount: number;
    errorDetails?: string[];
  }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Protocol Adapter Registry
// ────────────────────────────────────────────────────────────────────────────

export class ProtocolAdapterRegistry {
  private adapters = new Map<string, RegisteredAdapter>();
  private validationCache = new Map<string, ConformanceValidationResult>();
  private payloadCache = new Map<string, ProtocolConformancePayload>();
  private lastSyncedAt = new Date(0);

  /**
   * Register a new protocol adapter.
   * Validates that it can provide conformant data before accepting registration.
   *
   * @param factory - Adapter factory with fetch function
   * @param strictMode - If true, rejects adapter if conformance check fails
   * @throws Error if strictMode and conformance validation fails
   */
  async register(
    factory: AdapterFactory,
    strictMode = true,
  ): Promise<{
    registered: boolean;
    compliant: boolean;
    errors?: string[];
  }> {
    const existing = this.adapters.get(factory.protocolName);
    if (existing) {
      throw new Error(`Adapter for ${factory.protocolName} is already registered`);
    }

    try {
      // Test-fetch to validate conformance
      const payload = await factory.fetch();
      const validation = validateConformancePayload(payload);

      if (!validation.valid && strictMode) {
        const errorMessages = validation.errors.map((e) => `${e.field}: ${e.message}`);
        throw new Error(`Adapter failed conformance checks:\n${errorMessages.join("\n")}`);
      }

      // Register the adapter
      const registered: RegisteredAdapter = {
        protocolName: factory.protocolName,
        factory,
        registeredAt: new Date().toISOString(),
        lastValidation: {
          timestamp: new Date().toISOString(),
          result: validation,
        },
        failureCount: 0,
        consecutiveFailures: 0,
      };

      this.adapters.set(factory.protocolName, registered);
      this.payloadCache.set(factory.protocolName, payload);
      this.validationCache.set(factory.protocolName, validation);

      return {
        registered: true,
        compliant: validation.valid,
        errors: validation.valid ? undefined : validation.errors.map((e) => e.message),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (strictMode) {
        throw error;
      }
      return {
        registered: false,
        compliant: false,
        errors: [message],
      };
    }
  }

  /**
   * Fetch data from a registered adapter with validation.
   * Returns cached conformant payload if available and fresh.
   *
   * @param protocolName - Name of the registered protocol
   * @returns Conformant adapter payload
   * @throws Error if adapter not found
   */
  async fetch(protocolName: string): Promise<ProtocolConformancePayload> {
    const adapter = this.adapters.get(protocolName);
    if (!adapter) {
      throw new Error(`Adapter for ${protocolName} is not registered`);
    }

    try {
      const payload = await adapter.factory.fetch();
      const validation = validateConformancePayload(payload);

      if (!validation.valid) {
        adapter.consecutiveFailures++;
        adapter.failureCount++;

        const errorDetails = validation.errors.map((e) => `${e.field}: ${e.message}`);
        throw new Error(`Adapter returned non-conformant data: ${errorDetails.join("; ")}`);
      }

      // Reset failure counter on success
      adapter.consecutiveFailures = 0;

      // Cache the valid payload and validation
      this.payloadCache.set(protocolName, payload);
      this.validationCache.set(protocolName, validation);

      adapter.lastValidation = {
        timestamp: new Date().toISOString(),
        result: validation,
      };

      return payload;
    } catch (error) {
      adapter.consecutiveFailures++;
      adapter.failureCount++;

      // Return cached payload if available, but mark it as degraded
      const cached = this.payloadCache.get(protocolName);
      if (cached) {
        console.warn(
          `Adapter ${protocolName} failed to fetch fresh data, returning cached payload. ` +
            `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return cached;
      }

      throw new Error(
        `Adapter ${protocolName} failed and no cached data available: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get the latest cached payload for a protocol.
   */
  getCachedPayload(protocolName: string): ProtocolConformancePayload | undefined {
    return this.payloadCache.get(protocolName);
  }

  /**
   * Get the latest validation result for a protocol.
   */
  getValidation(protocolName: string): ConformanceValidationResult | undefined {
    return this.validationCache.get(protocolName);
  }

  /**
   * List all registered adapters.
   */
  getRegisteredAdapters(): RegisteredAdapter[] {
    return Array.from(this.adapters.values()).sort((a, b) =>
      a.protocolName.localeCompare(b.protocolName),
    );
  }

  /**
   * Sync all adapters: fetch fresh data and validate conformance.
   * This should be called periodically to ensure ongoing compliance.
   *
   * @returns Status of the sync operation
   */
  async syncAll(): Promise<AdapterRegistryStatus> {
    const results = await Promise.all(
      Array.from(this.adapters.values()).map((adapter) =>
        this.fetch(adapter.protocolName).catch((err) => {
          console.error(`Sync failed for ${adapter.protocolName}:`, err);
          return null;
        }),
      ),
    );

    this.lastSyncedAt = new Date();

    const adapters = this.getRegisteredAdapters();
    const compliantCount = adapters.filter((a) => a.lastValidation?.result.valid).length;

    return {
      totalRegistered: adapters.length,
      compliantCount,
      nonCompliantCount: adapters.length - compliantCount,
      lastSyncedAt: this.lastSyncedAt.toISOString(),
      adapters: adapters.map((a) => ({
        protocolName: a.protocolName,
        compliant: a.lastValidation?.result.valid || false,
        lastValidation: a.lastValidation?.timestamp,
        failureCount: a.failureCount,
        errorDetails: a.lastValidation?.result.errors.map((e) => e.message),
      })),
    };
  }

  /**
   * Generate a conformance report for all registered adapters.
   */
  generateReport(): ConformanceReport {
    const payloads = new Map<string, ProtocolConformancePayload>();
    const validations = new Map<string, ConformanceValidationResult>();

    for (const [name, payload] of this.payloadCache.entries()) {
      const validation = this.validationCache.get(name);
      if (validation && payload) {
        payloads.set(name, payload);
        validations.set(name, validation);
      }
    }

    return generateConformanceReport(validations, payloads);
  }

  /**
   * Build a capability matrix for all registered adapters.
   */
  buildCapabilityMatrix(): CapabilityMatrix {
    const payloads = this.payloadCache;
    return buildCapabilityMatrix(payloads);
  }

  /**
   * Check if a protocol is registered and compliant.
   */
  isCompliant(protocolName: string): boolean {
    const adapter = this.adapters.get(protocolName);
    return adapter?.lastValidation?.result.valid || false;
  }

  /**
   * Check if a protocol supports a specific capability.
   */
  hasCapability(protocolName: string, capability: keyof typeof CAPABILITY_NAMES): boolean {
    const validation = this.validationCache.get(protocolName);
    if (!validation) return false;
    return validation.capabilities[capability] || false;
  }

  /**
   * Unregister an adapter (for testing only).
   */
  unregister(protocolName: string): boolean {
    if (!this.adapters.has(protocolName)) return false;
    this.adapters.delete(protocolName);
    this.payloadCache.delete(protocolName);
    this.validationCache.delete(protocolName);
    return true;
  }

  /**
   * Clear all caches and registrations (for testing).
   */
  clear(): void {
    this.adapters.clear();
    this.payloadCache.clear();
    this.validationCache.clear();
    this.lastSyncedAt = new Date(0);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ────────────────────────────────────────────────────────────────────────────

let globalRegistry: ProtocolAdapterRegistry | null = null;

export function getGlobalRegistry(): ProtocolAdapterRegistry {
  if (!globalRegistry) {
    globalRegistry = new ProtocolAdapterRegistry();
  }
  return globalRegistry;
}

// ────────────────────────────────────────────────────────────────────────────
// Capability Names for Type Safety
// ────────────────────────────────────────────────────────────────────────────

export const CAPABILITY_NAMES = {
  deposit: "deposit",
  withdraw: "withdraw",
  swap: "swap",
  quote: "quote",
  emergency: "emergency",
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Adapter Conformance Error Type
// ────────────────────────────────────────────────────────────────────────────

export class AdapterConformanceError extends Error {
  constructor(
    public protocolName: string,
    public errors: Array<{ field: string; message: string }>,
  ) {
    super(
      `Adapter ${protocolName} failed conformance:\n` +
        errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n"),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: Register Multiple Adapters
// ────────────────────────────────────────────────────────────────────────────

export async function registerAdapters(
  factories: AdapterFactory[],
  strictMode = true,
): Promise<{
  registered: AdapterFactory[];
  failed: Array<{ factory: AdapterFactory; error: string }>;
}> {
  const registry = getGlobalRegistry();
  const registered: AdapterFactory[] = [];
  const failed: Array<{ factory: AdapterFactory; error: string }> = [];

  for (const factory of factories) {
    try {
      const result = await registry.register(factory, strictMode);
      if (result.registered) {
        registered.push(factory);
      } else {
        failed.push({
          factory,
          error: result.errors?.join("; ") || "Unknown error",
        });
      }
    } catch (error) {
      failed.push({
        factory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { registered, failed };
}
