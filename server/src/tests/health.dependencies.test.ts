/**
 * Tests for GET /health/dependencies
 * Covers healthy and degraded dependency responses per issue #455.
 */

import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockPing = jest.fn();
jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    ping: mockPing,
    quit: jest.fn().mockResolvedValue("OK"),
    on: jest.fn(),
    status: "ready",
  })),
}));

const mockQueryRaw = jest.fn();
const mockIndexerFindFirst = jest.fn();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: mockQueryRaw,
    indexerState: { findFirst: mockIndexerFindFirst },
  })),
}));

const mockHorizonCall = jest.fn();
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({ order: () => ({ call: mockHorizonCall }) }),
        }),
      })),
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: jest.fn().mockResolvedValue({ passphrase: "Test SDF Network ; September 2015" }),
      })),
    },
  };
});

// ── Test setup ───────────────────────────────────────────────────────────────

const app = express();
app.use("/health", healthRouter);

beforeEach(() => {
  jest.clearAllMocks();
  // Default: all healthy
  mockQueryRaw.mockResolvedValue([{}]);
  mockHorizonCall.mockResolvedValue({ records: [{ sequence: 200 }] });
  mockIndexerFindFirst.mockResolvedValue({ lastLedger: 198 });
  mockPing.mockResolvedValue("PONG");
});

// ── Healthy path ─────────────────────────────────────────────────────────────

describe("GET /health/dependencies — healthy", () => {
  it("returns 200 with overallStatus up when all dependencies are healthy", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("up");
  });

  it("includes all four dependency keys", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body).toHaveProperty("database");
    expect(res.body).toHaveProperty("horizon");
    expect(res.body).toHaveProperty("indexer");
    expect(res.body).toHaveProperty("cache");
  });

  it("each healthy dependency has status up", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.database.status).toBe("up");
    expect(res.body.horizon.status).toBe("up");
    expect(res.body.indexer.status).toBe("up");
    expect(res.body.cache.status).toBe("up");
  });

  it("includes latencyMs for database and cache", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(typeof res.body.database.latencyMs).toBe("number");
    expect(typeof res.body.cache.latencyMs).toBe("number");
  });

  it("includes latestLedger from horizon", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.horizon.latestLedger).toBe(200);
  });

  it("includes syncedLedger and lagLedgers from indexer", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.indexer.syncedLedger).toBe(198);
    expect(typeof res.body.indexer.lagLedgers).toBe("number");
  });

  it("includes a valid ISO timestamp", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(typeof res.body.timestamp).toBe("string");
    expect(new Date(res.body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("does not expose credentials or private data", async () => {
    const res = await request(app).get("/health/dependencies");
    const body = JSON.stringify(res.body);
    // Ensure no env var values that could be secrets appear
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/private/i);
  });
});

// ── Degraded: database down ──────────────────────────────────────────────────

describe("GET /health/dependencies — database down", () => {
  beforeEach(() => {
    mockQueryRaw.mockRejectedValue(new Error("Connection refused"));
    mockIndexerFindFirst.mockRejectedValue(new Error("Connection refused"));
  });

  it("returns 503 when database is down", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.status).toBe(503);
  });

  it("sets database status to down", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.database.status).toBe("down");
  });

  it("sets overallStatus to down", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.overallStatus).toBe("down");
  });

  it("includes a remediation hint for database", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(typeof res.body.database.hint).toBe("string");
    expect(res.body.database.hint.length).toBeGreaterThan(0);
  });
});

// ── Degraded: horizon down ───────────────────────────────────────────────────

describe("GET /health/dependencies — horizon down", () => {
  beforeEach(() => {
    mockHorizonCall.mockRejectedValue(new Error("Network error"));
  });

  it("returns 503 when horizon is down", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.status).toBe(503);
  });

  it("sets horizon status to down with a hint", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.horizon.status).toBe("down");
    expect(typeof res.body.horizon.hint).toBe("string");
  });
});

// ── Degraded: cache down ─────────────────────────────────────────────────────

describe("GET /health/dependencies — cache down", () => {
  beforeEach(() => {
    mockPing.mockRejectedValue(new Error("ECONNREFUSED"));
  });

  it("returns 503 when cache is down", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.status).toBe(503);
  });

  it("sets cache status to down with a hint", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.cache.status).toBe("down");
    expect(typeof res.body.cache.hint).toBe("string");
  });
});

// ── Degraded: indexer lagging ────────────────────────────────────────────────

describe("GET /health/dependencies — indexer lagging", () => {
  beforeEach(() => {
    // Horizon at ledger 300, indexer only at 200 → lag of 100 (> 50 threshold)
    mockHorizonCall.mockResolvedValue({ records: [{ sequence: 300 }] });
    mockIndexerFindFirst.mockResolvedValue({ lastLedger: 200 });
  });

  it("returns 200 (not 503) when only indexer is warning", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.status).toBe(200);
  });

  it("sets indexer status to warning", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.indexer.status).toBe("warning");
  });

  it("sets overallStatus to warning", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.overallStatus).toBe("warning");
  });

  it("includes lagLedgers and a hint for the indexer", async () => {
    const res = await request(app).get("/health/dependencies");
    expect(res.body.indexer.lagLedgers).toBe(100);
    expect(typeof res.body.indexer.hint).toBe("string");
  });
});
