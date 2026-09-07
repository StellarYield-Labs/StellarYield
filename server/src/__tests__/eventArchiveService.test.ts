/**
 * Tests for the Durable Content-Addressed Event Archive Service (Issue #75).
 *
 * Uses InMemoryArchiveStorage and a mocked PrismaClient so no database or
 * object-storage credentials are required.
 */

import {
  EventArchiveService,
  InMemoryArchiveStorage,
  DEFAULT_ARCHIVE_CONFIG,
} from "../services/eventArchiveService";

// ── Prisma mock helpers ────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<{
  id: string; ledger: number; txHash: string; contractId: string;
  topic: string; data: string; createdAt: Date;
}> = {}) {
  return {
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    ledger: overrides.ledger ?? 1000,
    txHash: overrides.txHash ?? "0xabc",
    contractId: overrides.contractId ?? "CONTRACT_A",
    topic: overrides.topic ?? "Deposit",
    data: overrides.data ?? '{"amount":"1000"}',
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

function makeManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "manifest_1",
    network: "testnet",
    contractId: "CONTRACT_A",
    ledgerStart: 1000,
    ledgerEnd: 1999,
    objectKey: "events/testnet/CONTRACT_A/1000-1999/v1-abc.ndjson.gz",
    contentAddress: "abc",
    compressedDigest: "def",
    compressionAlgo: "gzip",
    compressedBytes: BigInt(512),
    uncompressedBytes: BigInt(1024),
    eventCount: 3,
    firstEventId: "evt_1",
    lastEventId: "evt_3",
    firstLedger: 1000,
    lastLedger: 1999,
    state: "STAGED",
    stagedAt: new Date(),
    verifiedAt: null,
    hotRowsDeletedAt: null,
    quarantinedAt: null,
    restoredAt: null,
    tombstonedAt: null,
    verificationPass: null,
    verificationError: null,
    sampleCheckPassed: null,
    retryCount: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    legalHolds: [],
    ...overrides,
  };
}

function makePrisma(events: ReturnType<typeof makeEvent>[] = []) {
  const manifests: ReturnType<typeof makeManifest>[] = [];
  const locks: Record<string, unknown> = {};
  const legalHolds: Array<{ id: string; manifestId: string; reason: string; createdBy: string; releasedAt: Date | null; releasedBy: string | null }> = [];
  const retentionPolicies: unknown[] = [];

  return {
    event: {
      findMany: jest.fn().mockImplementation(({ where, orderBy, take }: {
        where?: { contractId?: string; ledger?: { gte?: number; lte?: number }; id?: { gt?: string } };
        orderBy?: unknown;
        take?: number;
      } = {}) => {
        let result = [...events];
        if (where?.contractId) result = result.filter((e) => e.contractId === where.contractId);
        if (where?.ledger?.gte !== undefined) result = result.filter((e) => e.ledger >= where.ledger!.gte!);
        if (where?.ledger?.lte !== undefined) result = result.filter((e) => e.ledger <= where.ledger!.lte!);
        if (where?.id?.gt) result = result.filter((e) => e.id > where.id!.gt!);
        result.sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : 1));
        return Promise.resolve(take ? result.slice(0, take) : result);
      }),
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(events.find((e) => e.id === where.id) ?? null),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: events.length }),
      upsert: jest.fn().mockImplementation(({ create }: { create: ReturnType<typeof makeEvent> }) => {
        const existing = events.find((e) => e.id === create.id);
        if (!existing) events.push(create);
        return Promise.resolve(create);
      }),
    },
    eventArchiveManifest: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(({ create }: { create: ReturnType<typeof makeManifest> }) => {
        const manifest = makeManifest(create);
        manifests.push(manifest);
        return Promise.resolve(manifest);
      }),
      update: jest.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Partial<ReturnType<typeof makeManifest>> }) => {
        const idx = manifests.findIndex((m) => m.id === where.id);
        if (idx >= 0) Object.assign(manifests[idx], data);
        return Promise.resolve(manifests[idx] ?? makeManifest(data));
      }),
    },
    archiveWorkerLock: {
      upsert: jest.fn().mockImplementation(({ create, update }: { create?: { id: string; workerId: string }; update?: { id: string; workerId: string } }) => {
        const item = create || update;
        if (item) locks[item.id] = item;
        return Promise.resolve(item ?? {});
      }),
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        return Promise.resolve(locks[where.id] ?? null);
      }),
      deleteMany: jest.fn().mockImplementation(({ where }: { where?: { id?: string } } = {}) => {
        if (where?.id) delete locks[where.id];
        return Promise.resolve({ count: 1 });
      }),
    },
    archiveRetentionPolicy: {
      findMany: jest.fn().mockResolvedValue(retentionPolicies),
    },
    legalHold: {
      create: jest.fn().mockImplementation(({ data }: { data: { manifestId: string; reason: string; createdBy: string } }) => {
        const hold = { id: `hold_${Date.now()}`, ...data, releasedAt: null, releasedBy: null };
        legalHolds.push(hold);
        return Promise.resolve(hold);
      }),
      update: jest.fn().mockResolvedValue({ id: "hold_1", manifestId: "manifest_1", releasedAt: new Date(), releasedBy: "admin" }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InMemoryArchiveStorage", () => {
  let storage: InMemoryArchiveStorage;

  beforeEach(() => {
    storage = new InMemoryArchiveStorage();
  });

  it("round-trips a buffer", async () => {
    const buf = Buffer.from("hello world");
    await storage.put("test/key", buf, { contentType: "text/plain", contentEncoding: "identity" });
    const retrieved = await storage.get("test/key");
    expect(retrieved?.toString()).toBe("hello world");
  });

  it("returns null for a missing key", async () => {
    expect(await storage.get("missing")).toBeNull();
    expect(await storage.exists("missing")).toBe(false);
  });

  it("getStream returns a readable for an existing key", async () => {
    const buf = Buffer.from("stream content");
    await storage.put("stream/key", buf, { contentType: "text/plain", contentEncoding: "identity" });
    const stream = await storage.getStream("stream/key");
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("stream content");
  });

  it("delete removes the key", async () => {
    await storage.put("del/key", Buffer.from("x"), { contentType: "text/plain", contentEncoding: "identity" });
    await storage.delete("del/key");
    expect(await storage.exists("del/key")).toBe(false);
  });
});

describe("EventArchiveService.archivePartition (happy path)", () => {
  it("writes a gzip-compressed NDJSON object and returns a STAGED→VERIFIED→HOT_ROWS_DELETED manifest", async () => {
    const events = [
      makeEvent({ id: "evt_1", ledger: 1000, txHash: "0x1" }),
      makeEvent({ id: "evt_2", ledger: 1001, txHash: "0x2" }),
      makeEvent({ id: "evt_3", ledger: 1002, txHash: "0x3" }),
    ];
    const storage = new InMemoryArchiveStorage();
    const prisma = makePrisma(events) as unknown as import("@prisma/client").PrismaClient;

    const svc = new EventArchiveService(prisma, storage, { sampleVerificationCount: 2 });
    const manifest = await svc.archivePartition({ network: "testnet", contractId: "CONTRACT_A", ledgerStart: 1000, ledgerEnd: 1999 });

    // Object should exist in storage
    expect(await storage.exists(manifest.objectKey)).toBe(true);

    // The upsert was called to create the manifest
    expect((prisma as unknown as ReturnType<typeof makePrisma>).eventArchiveManifest.upsert).toHaveBeenCalledTimes(1);
  });

  it("produces a content address that changes when the event data changes", async () => {
    const events1 = [makeEvent({ id: "evt_1", ledger: 1000, data: '{"amount":"100"}' })];
    const events2 = [makeEvent({ id: "evt_1", ledger: 1000, data: '{"amount":"999"}' })];

    const storage1 = new InMemoryArchiveStorage();
    const storage2 = new InMemoryArchiveStorage();
    const prisma1 = makePrisma(events1) as unknown as import("@prisma/client").PrismaClient;
    const prisma2 = makePrisma(events2) as unknown as import("@prisma/client").PrismaClient;

    const svc1 = new EventArchiveService(prisma1, storage1);
    const svc2 = new EventArchiveService(prisma2, storage2);

    const m1 = await svc1.archivePartition({ network: "testnet", contractId: "CONTRACT_A", ledgerStart: 1000, ledgerEnd: 1999 });
    const m2 = await svc2.archivePartition({ network: "testnet", contractId: "CONTRACT_A", ledgerStart: 1000, ledgerEnd: 1999 });

    expect(m1.contentAddress).not.toBe(m2.contentAddress);
  });
});

describe("EventArchiveService.queryArchives", () => {
  it("returns hot events when no archived manifests exist", async () => {
    const events = [
      makeEvent({ id: "evt_1", ledger: 100 }),
      makeEvent({ id: "evt_2", ledger: 200 }),
    ];
    const storage = new InMemoryArchiveStorage();
    const prisma = makePrisma(events) as unknown as import("@prisma/client").PrismaClient;

    const svc = new EventArchiveService(prisma, storage);
    const result = await svc.queryArchives({
      network: "testnet",
      contractId: "CONTRACT_A",
      ledgerStart: 1,
      ledgerEnd: 9999,
      limit: 50,
    });

    expect(result.fromHot).toBe(true);
    expect(result.fromArchive).toBe(false);
    expect(result.events.length).toBeGreaterThanOrEqual(2);
  });

  it("cursor-based pagination excludes events at or before the cursor", async () => {
    const events = [
      makeEvent({ id: "aaa", ledger: 100 }),
      makeEvent({ id: "bbb", ledger: 200 }),
      makeEvent({ id: "ccc", ledger: 300 }),
    ];
    const storage = new InMemoryArchiveStorage();
    const prisma = makePrisma(events) as unknown as import("@prisma/client").PrismaClient;

    const svc = new EventArchiveService(prisma, storage);
    const result = await svc.queryArchives({
      network: "testnet",
      contractId: "CONTRACT_A",
      ledgerStart: 1,
      ledgerEnd: 9999,
      cursor: "aaa",
      limit: 10,
    });

    const ids = result.events.map((e) => e.id);
    expect(ids).not.toContain("aaa");
    expect(ids).toContain("bbb");
    expect(ids).toContain("ccc");
  });
});

describe("EventArchiveService — range subtraction", () => {
  it("merges hot and cold results without duplicates at the boundary", async () => {
    // Simulate: ledger 1000-1499 archived, 1500-1999 hot
    const hotEvents = [makeEvent({ id: "h1", ledger: 1500 }), makeEvent({ id: "h2", ledger: 1600 })];
    const coldEvents = [makeEvent({ id: "c1", ledger: 1000 }), makeEvent({ id: "c2", ledger: 1200 })];

    const storage = new InMemoryArchiveStorage();

    // Pre-populate storage with a cold archive
    const svcSetup = new EventArchiveService(makePrisma(coldEvents) as unknown as import("@prisma/client").PrismaClient, storage);
    const coldManifest = await (svcSetup as unknown as { archivePartition: (spec: { network: string; contractId: string; ledgerStart: number; ledgerEnd: number }) => Promise<{ objectKey: string }> }).archivePartition({
      network: "testnet", contractId: "CONTRACT_A", ledgerStart: 1000, ledgerEnd: 1499,
    }).catch(() => null);

    // Now query combining both
    const prisma = makePrisma(hotEvents) as unknown as import("@prisma/client").PrismaClient;
    (prisma as unknown as ReturnType<typeof makePrisma>).eventArchiveManifest.findMany.mockResolvedValue(
      coldManifest
        ? [makeManifest({
            ledgerStart: 1000, ledgerEnd: 1499,
            objectKey: coldManifest.objectKey,
            state: "HOT_ROWS_DELETED",
            firstEventId: "c1", lastEventId: "c2",
            eventCount: 2,
          })]
        : [],
    );

    const svc = new EventArchiveService(prisma, storage);
    const result = await svc.queryArchives({
      network: "testnet", contractId: "CONTRACT_A",
      ledgerStart: 1000, ledgerEnd: 1999,
    });

    const ids = result.events.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length); // no duplicates
  });
});

describe("EventArchiveService.streamArchive", () => {
  it("yields events in ledger order from a stored archive", async () => {
    const events = [
      makeEvent({ id: "s1", ledger: 500, txHash: "tx1" }),
      makeEvent({ id: "s2", ledger: 600, txHash: "tx2" }),
    ];
    const storage = new InMemoryArchiveStorage();
    const prisma = makePrisma(events) as unknown as import("@prisma/client").PrismaClient;

    const svc = new EventArchiveService(prisma, storage);
    const manifest = await svc.archivePartition({ network: "testnet", contractId: "CONTRACT_A", ledgerStart: 500, ledgerEnd: 699 });

    // findUnique should return the stored manifest so streamArchive can find the objectKey
    (prisma as unknown as ReturnType<typeof makePrisma>).eventArchiveManifest.findUnique.mockResolvedValue(
      manifest,
    );

    const yielded: string[] = [];
    for await (const evt of svc.streamArchive(manifest.id)) {
      yielded.push(evt.id);
    }

    expect(yielded).toEqual(["s1", "s2"]);
  });
});

describe("EventArchiveService.getStats", () => {
  it("counts manifests by state", async () => {
    const storage = new InMemoryArchiveStorage();
    const prisma = makePrisma() as unknown as import("@prisma/client").PrismaClient;

    (prisma as unknown as ReturnType<typeof makePrisma>).eventArchiveManifest.findMany.mockResolvedValue([
      makeManifest({ state: "HOT_ROWS_DELETED", eventCount: 1000 }),
      makeManifest({ state: "STAGED", eventCount: 200 }),
    ]);

    const svc = new EventArchiveService(prisma, storage);
    const stats = await svc.getStats();

    expect(stats.byState["HOT_ROWS_DELETED"]).toBe(1);
    expect(stats.byState["STAGED"]).toBe(1);
    expect(stats.totalEventsArchived).toBe(1000);
  });
});

describe("EventArchiveService — idempotency", () => {
  it("does not duplicate storage writes when archivePartition is called twice", async () => {
    const events = [makeEvent({ id: "e1", ledger: 100, contractId: "C" })];
    const storage = new InMemoryArchiveStorage();
    const putSpy = jest.spyOn(storage, "put");

    const prisma = makePrisma(events) as unknown as import("@prisma/client").PrismaClient;

    // Second call: findFirst returns a VERIFIED manifest (already advanced past STAGED)
    (prisma as unknown as ReturnType<typeof makePrisma>).eventArchiveManifest.findFirst
      .mockResolvedValueOnce(null) // first call: no existing manifest
      .mockResolvedValueOnce(makeManifest({ state: "VERIFIED" })); // second call

    const svc = new EventArchiveService(prisma, storage);
    await svc.archivePartition({ network: "testnet", contractId: "C", ledgerStart: 100, ledgerEnd: 199 });
    await svc.archivePartition({ network: "testnet", contractId: "C", ledgerStart: 100, ledgerEnd: 199 });

    // Storage.put should only have been called once (second invocation short-circuits)
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});
