import request from "supertest";
import express from "express";
import healthRouter from "../routes/health";

// ── Queue health mocks ──────────────────────────────────────────────────────

const mockGetJobCounts = jest.fn();
const mockQueueClose = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation((name: string) => ({
    name,
    getJobCounts: mockGetJobCounts,
    close: mockQueueClose,
  })),
}));

jest.mock("ioredis", () => ({
  Redis: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue("OK"),
    status: "ready",
  })),
}));

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $queryRaw: jest.fn().mockResolvedValue([{}]),
      indexerState: {
        findFirst: jest.fn().mockResolvedValue({ lastLedger: 100 }),
      },
    })),
  };
});

const mockCall = jest.fn();
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        ledgers: () => ({
          limit: () => ({
            order: () => ({
              call: mockCall
            })
          })
        })
      }))
    },
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getNetwork: jest.fn().mockResolvedValue({ passcode: "mock-network" })
      }))
    }
  };
});

describe("GET /api/health", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_HORIZON_TIMEOUT_MS = "100";
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 10, failed: 0, delayed: 0 });
  });

  afterEach(() => {
    delete process.env.STELLAR_HORIZON_TIMEOUT_MS;
  });

  it("returns 200 when healthy", async () => {
    mockCall.mockResolvedValue({ records: [{ sequence: 105 }] });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.horizon).toBe("up");
  });

  it("returns 503 and degraded horizon on timeout", async () => {
    mockCall.mockImplementation(() => {
      return new Promise((resolve) => setTimeout(resolve, 200));
    });
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(503);
    expect(response.body.horizon).toBe("down");
  });
});

describe("GET /api/health/queues", () => {
  const app = express();
  app.use("/api/health", healthRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with healthy overall status when all queues are within thresholds", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 2, active: 1, completed: 50, failed: 0, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("healthy");
    expect(Array.isArray(res.body.queues)).toBe(true);
    expect(res.body.queues.length).toBe(6);
  });

  it("returns 200 with warning status when failed jobs exceed threshold", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 99, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("warning");
    for (const entry of res.body.queues) {
      expect(entry.status).toBe("warning");
      expect(entry.warnings.some((w: string) => w.includes("failed jobs"))).toBe(true);
    }
  });

  it("returns 200 with warning status when delayed jobs exceed threshold", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 99 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    expect(res.body.overallStatus).toBe("warning");
    for (const entry of res.body.queues) {
      expect(entry.warnings.some((w: string) => w.includes("delayed jobs"))).toBe(true);
    }
  });

  it("returns 503 when a queue fails to return counts", async () => {
    mockGetJobCounts.mockRejectedValue(new Error("Redis unavailable"));

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(503);
    expect(res.body.overallStatus).toBe("error");
    for (const entry of res.body.queues) {
      expect(entry.status).toBe("error");
    }
  });

  it("response includes all five count fields per queue entry", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 3, active: 1, completed: 20, failed: 0, delayed: 2 });

    const res = await request(app).get("/api/health/queues");

    expect(res.status).toBe(200);
    for (const entry of res.body.queues) {
      expect(typeof entry.counts.waiting).toBe("number");
      expect(typeof entry.counts.active).toBe("number");
      expect(typeof entry.counts.completed).toBe("number");
      expect(typeof entry.counts.failed).toBe("number");
      expect(typeof entry.counts.delayed).toBe("number");
    }
  });

  it("response includes a timestamp", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    expect(typeof res.body.timestamp).toBe("string");
    expect(new Date(res.body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("each queue entry includes the queue name", async () => {
    mockGetJobCounts.mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });

    const res = await request(app).get("/api/health/queues");

    const names = res.body.queues.map((q: { name: string }) => q.name);
    expect(names).toContain("liquidation");
    expect(names).toContain("compound");
    expect(names).toContain("rebalance-execution");
  });
});
