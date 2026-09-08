jest.mock("@prisma/client", () => ({
  PrismaClient: class { constructor() {} },
}));

import request from "supertest";
import { createApp } from "../app";
import {
  classifySourceHealth,
  SOURCE_HEALTH_THRESHOLDS,
  type SourceHealthInput,
} from "../services/yieldSourceRegistryService";

describe("GET /api/analytics/sources/health", () => {
  it("returns 200 with the registry envelope", async () => {
    const res = await request(createApp()).get("/api/analytics/sources/health");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.generatedAt).toBe("string");
    expect(typeof res.body.data.totalSources).toBe("number");
    expect(Array.isArray(res.body.data.sources)).toBe(true);
  });

  it("returns one summary per source with the documented fields", async () => {
    const res = await request(createApp()).get("/api/analytics/sources/health");
    const { sources, totalSources, counts } = res.body.data;

    expect(sources).toHaveLength(totalSources);
    for (const source of sources) {
      expect(typeof source.providerId).toBe("string");
      expect(typeof source.providerName).toBe("string");
      expect(["healthy", "degraded", "stale", "unavailable"]).toContain(
        source.status,
      );
      expect(typeof source.uptimePct).toBe("number");
      expect(typeof source.latencyMs).toBe("number");
      expect(typeof source.latestFetch).toBe("string");
    }

    const summed =
      counts.healthy + counts.degraded + counts.stale + counts.unavailable;
    expect(summed).toBe(totalSources);
  });
});

describe("classifySourceHealth boundary", () => {
  const baseInput: SourceHealthInput = {
    reliabilityStatus: "high",
    reliabilityScore: 92,
    consecutiveFailures: 0,
    errorRate: 0.01,
    latencyMs: 200,
    freshness: 0.95,
    ageSeconds: 120,
  };

  it("keeps a source healthy with a clearly fresh timestamp", () => {
    const result = classifySourceHealth({
      ...baseInput,
      ageSeconds: 0,
    });
    expect(result.status).toBe("healthy");
    expect(result.failureReason).toBeNull();
  });

  it("remains healthy at exactly the stale threshold", () => {
    const result = classifySourceHealth({
      ...baseInput,
      ageSeconds: SOURCE_HEALTH_THRESHOLDS.staleAgeSeconds,
    });
    expect(result.status).toBe("healthy");
    expect(result.failureReason).toBeNull();
  });

  it("marks a source stale just beyond the stale threshold", () => {
    const result = classifySourceHealth({
      ...baseInput,
      ageSeconds: SOURCE_HEALTH_THRESHOLDS.staleAgeSeconds + 1,
    });
    expect(result.status).toBe("stale");
    expect(result.failureReason).toMatch(/No fresh data/);
  });
});
