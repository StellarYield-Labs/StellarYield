import { describe, it, expect } from "vitest";
import type { Quest } from "./types";
import {
  QUEST_STORAGE_VERSION,
  DEFAULT_STALE_CACHE_TTL_MS,
  applySimulatedIndexerProgress,
  cloneQuests,
  getCacheFreshness,
  invalidateStaleCache,
  isCacheStale,
  legacyWalletQuestStorageKey,
  loadWalletQuestBundle,
  mergeQuestsWithTemplate,
  migrateQuestBundle,
  sanitizeAchievement,
  sanitizeQuest,
  saveWalletQuestBundle,
  walletQuestStorageKey,
  type PersistedWalletQuestBundle,
} from "./questPersistence";
import {
  createStaleCacheFixture,
  futureVersionBundleFixture,
  partiallyCorruptedBundleFixture,
  v0FlatQuestShapeBundleFixture,
  v0LegacyGlobalAchievementsFixture,
  v0LegacyGlobalQuestsFixture,
  v0UnversionedWalletPayloadFixture,
} from "./questMigrationFixtures";

const TEMPLATE: Quest[] = [
  {
    id: "qNew",
    title: "New Quest From Template",
    description: "Added after user saved progress.",
    points: 10,
    status: "locked",
    badgeContractId: "CBADGE_NEW",
    category: "social",
    icon: "Landmark",
    objectives: [{ id: "on", description: "Do thing", target: 1, progress: 0, unit: "x" }],
  },
  {
    id: "q1",
    title: "First Deposit",
    description: "Deposit USDC.",
    points: 50,
    status: "active",
    badgeContractId: "CBADGE_FIRST_DEPOSIT",
    category: "deposit",
    icon: "Landmark",
    objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 0, unit: "USDC" }],
  },
  {
    id: "q2",
    title: "Diamond Hands",
    description: "Hold your vault position for 30 consecutive days.",
    points: 150,
    status: "active",
    badgeContractId: "CBADGE_DIAMOND_HANDS",
    category: "hold",
    icon: "Gem",
    objectives: [{ id: "o2", description: "Hold for 30 days", target: 30, progress: 0, unit: "days" }],
  },
  {
    id: "q4",
    title: "Governance Voter",
    description: "Vote on 3 governance proposals.",
    points: 100,
    status: "active",
    badgeContractId: "CBADGE_VOTER",
    category: "governance",
    icon: "ShieldCheck",
    objectives: [{ id: "o4", description: "Vote on proposals", target: 3, progress: 0, unit: "votes" }],
  },
];

function mockStorage(initial: Record<string, string> = {}) {
  let store = { ...initial };
  return {
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    snapshot() {
      return { ...store };
    },
  };
}

describe("mergeQuestsWithTemplate", () => {
  it("preserves saved progress for matching ids and picks up new template quests", () => {
    const persisted: Quest[] = [
      {
        ...TEMPLATE[1],
        objectives: [{ ...TEMPLATE[1].objectives[0], progress: 42 }],
        status: "active",
      },
    ];

    const merged = mergeQuestsWithTemplate(persisted, TEMPLATE);
    expect(merged.find((q) => q.id === "q1")?.objectives[0].progress).toBe(42);
    expect(merged.find((q) => q.id === "qNew")).toBeDefined();
    expect(merged.find((q) => q.id === "qNew")?.title).toBe("New Quest From Template");
  });

  it("returns a fresh template copy when nothing persisted", () => {
    const merged = mergeQuestsWithTemplate(null, TEMPLATE);
    expect(merged).toHaveLength(TEMPLATE.length);
    expect(merged[1].objectives[0].progress).toBe(0);
  });
});

describe("applySimulatedIndexerProgress", () => {
  it("updates known demo quests deterministically", () => {
    const base = cloneQuests(TEMPLATE);
    const updated = applySimulatedIndexerProgress(base);
    const q1 = updated.find((q) => q.id === "q1");
    expect(q1?.objectives[0].progress).toBe(100);
    expect(q1?.status).toBe("claimable");
  });
});

describe("per-wallet persistence (reconnect)", () => {
  it("isolates snapshots by wallet address", () => {
    const storage = mockStorage();
    const w1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const w2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    const b1: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: mergeQuestsWithTemplate(
        [
          {
            ...TEMPLATE[1],
            objectives: [{ ...TEMPLATE[1].objectives[0], progress: 77 }],
          },
        ],
        TEMPLATE,
      ),
      achievements: [],
      lastSyncedAt: 111,
    };
    saveWalletQuestBundle(w1, b1, storage);

    const loadedW1 = loadWalletQuestBundle(w1, TEMPLATE, storage);
    expect(loadedW1.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(77);

    const loadedW2 = loadWalletQuestBundle(w2, TEMPLATE, storage);
    expect(loadedW2.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(0);

    expect(storage.snapshot()[walletQuestStorageKey(w1)]).toBeDefined();
    expect(storage.snapshot()[walletQuestStorageKey(w2)]).toBeUndefined();
  });
});

describe("Quest Progress Migrations (Scope: Migration fixtures for older quest state)", () => {
  it("migrates legacy global keys (sy_quests & sy_achievements) into active wallet bundle", () => {
    const storage = mockStorage({
      sy_quests: JSON.stringify(v0LegacyGlobalQuestsFixture),
      sy_achievements: JSON.stringify(v0LegacyGlobalAchievementsFixture),
    });
    const wallet = "GLEGACYGLOBALWALLET1234567890ABCDEFGHIJKLMNOPQRSTUV";
    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(100);
    expect(loaded.quests.find((q) => q.id === "q2")?.objectives[0].progress).toBe(15);
    expect(loaded.achievements).toHaveLength(1);
    expect(loaded.achievements[0].txHash).toBe("tx_legacy_global_001");

    // Cleaned up legacy keys
    expect(storage.getItem("sy_quests")).toBeNull();
    expect(storage.getItem("sy_achievements")).toBeNull();
    // Saved in versioned key
    expect(storage.getItem(walletQuestStorageKey(wallet))).toBeTruthy();
  });

  it("migrates unversioned per-wallet key (sy_quest_wallet_<address>) safely", () => {
    const wallet = "GUNVERSIONEDWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVW";
    const legacyKey = legacyWalletQuestStorageKey(wallet);
    const storage = mockStorage({
      [legacyKey]: JSON.stringify(v0UnversionedWalletPayloadFixture),
    });

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests.find((q) => q.id === "q1")?.status).toBe("completed");
    expect(loaded.quests.find((q) => q.id === "q4")?.objectives[0].progress).toBe(2);
    expect(loaded.achievements[0].txHash).toBe("tx_unversioned_wallet_001");
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(storage.getItem(walletQuestStorageKey(wallet))).toBeTruthy();
  });

  it("migrates flat legacy quest schema (progress, completed, reward, badgeId) to objective-based schema", () => {
    const wallet = "GDFLATQUEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";
    const storage = mockStorage({
      [walletQuestStorageKey(wallet)]: JSON.stringify(v0FlatQuestShapeBundleFixture),
    });

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    const q1 = loaded.quests.find((q) => q.id === "q1");
    expect(q1?.status).toBe("completed");
    expect(q1?.objectives[0].progress).toBe(100);
    expect(q1?.points).toBe(50);
    const q2 = loaded.quests.find((q) => q.id === "q2");
    expect(q2?.objectives[0].progress).toBe(20);
    expect(loaded.achievements).toHaveLength(1);
  });

  it("safely handles future version bundles with backward-compatible fields", () => {
    const wallet = "GDFUTUREVERSION1234567890ABCDEFGHIJKLMNOPQRSTUVWX";
    const storage = mockStorage({
      [walletQuestStorageKey(wallet)]: JSON.stringify(futureVersionBundleFixture),
    });

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    const q1 = loaded.quests.find((q) => q.id === "q1");
    expect(q1?.objectives[0].progress).toBe(100);
    expect(q1?.status).toBe("claimable");
    expect(loaded.achievements[0].txHash).toBe("tx_future_v99");
  });
});

describe("Stale Cache Invalidation (Scope: Cover stale cache invalidation)", () => {
  it("detects stale cache correctly using TTL and clock skew checks", () => {
    const now = 1700000000000;
    const freshBundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: now - 3600 * 1000, // 1 hour old (< 24h)
    };
    expect(isCacheStale(freshBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe(false);
    expect(getCacheFreshness(freshBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe("fresh");

    const staleBundle = createStaleCacheFixture(25 * 3600 * 1000, now); // 25 hours old (> 24h)
    expect(isCacheStale(staleBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe(true);
    expect(getCacheFreshness(staleBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe("stale");

    const nullSyncedBundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: null,
    };
    expect(isCacheStale(nullSyncedBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe(true);
    expect(getCacheFreshness(nullSyncedBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe("unverified");

    // Clock skew anomaly (> 5 min future)
    const futureSkewBundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(TEMPLATE),
      achievements: [],
      lastSyncedAt: now + 10 * 60 * 1000,
    };
    expect(isCacheStale(futureSkewBundle, DEFAULT_STALE_CACHE_TTL_MS, now)).toBe(true);
  });

  it("invalidates stale cache while preserving progress and achievements", () => {
    const now = 1700000000000;
    const wallet = "GDSTALEWALLET1234567890ABCDEFGHIJKLMNOPQRSTUVWXY";
    const staleBundle: PersistedWalletQuestBundle = {
      version: QUEST_STORAGE_VERSION,
      quests: [
        {
          ...TEMPLATE[1],
          objectives: [{ ...TEMPLATE[1].objectives[0], progress: 80 }],
        },
      ],
      achievements: [
        {
          questId: "q1",
          title: "First Deposit",
          badgeContractId: "CBADGE_FIRST_DEPOSIT",
          mintedAt: now - 50 * 3600 * 1000,
          txHash: "tx_stale_ach_01",
        },
      ],
      lastSyncedAt: now - 48 * 3600 * 1000, // 48 hours ago
    };

    const storage = mockStorage({
      [walletQuestStorageKey(wallet)]: JSON.stringify(staleBundle),
    });

    const wasInvalidated = invalidateStaleCache(wallet, DEFAULT_STALE_CACHE_TTL_MS, storage, now);
    expect(wasInvalidated).toBe(true);

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);
    expect(loaded.lastSyncedAt).toBeNull();
    // Progress and achievements are preserved
    expect(loaded.quests.find((q) => q.id === "q1")?.objectives[0].progress).toBe(80);
    expect(loaded.achievements[0].txHash).toBe("tx_stale_ach_01");

    // Calling invalidate again on already invalidated cache returns false
    expect(invalidateStaleCache(wallet, DEFAULT_STALE_CACHE_TTL_MS, storage, now)).toBe(false);
  });
});

describe("Recovery after partially corrupted local state (Scope: Validate recovery)", () => {
  it("recovers valid quests and achievements from partially corrupted bundle fixture", () => {
    const wallet = "GDCORRUPTFIXTURE1234567890ABCDEFGHIJKLMNOPQRSTUV";
    const storage = mockStorage({
      [walletQuestStorageKey(wallet)]: JSON.stringify(partiallyCorruptedBundleFixture),
    });

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    // All template quests are present
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    // q1 progress recovered
    const q1 = loaded.quests.find((q) => q.id === "q1");
    expect(q1?.objectives[0].progress).toBe(100);
    expect(q1?.status).toBe("claimable");
    // q4 progress recovered from string number
    const q4 = loaded.quests.find((q) => q.id === "q4");
    expect(q4?.objectives[0].progress).toBe(2);
    // Achievements recovered (corrupted filtered out, valid kept)
    expect(loaded.achievements).toHaveLength(1);
    expect(loaded.achievements[0].txHash).toBe("tx_valid_achievement_001");
    // Invalid timestamp sanitized to null
    expect(loaded.lastSyncedAt).toBeNull();
  });

  it("handles completely invalid JSON without throwing and provides clean fallback", () => {
    const wallet = "GDTRUNCATEDJSON1234567890ABCDEFGHIJKLMNOPQRSTUVW";
    const storage = mockStorage({
      [walletQuestStorageKey(wallet)]: '{"version": 1, "quests": [{"id": "q1", ',
    });

    const loaded = loadWalletQuestBundle(wallet, TEMPLATE, storage);

    expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
    expect(loaded.quests).toHaveLength(TEMPLATE.length);
    expect(loaded.achievements).toHaveLength(0);
    expect(loaded.lastSyncedAt).toBeNull();
  });

  it("sanitizes individual corrupted quest and achievement inputs safely", () => {
    expect(sanitizeQuest(null)).toBeNull();
    expect(sanitizeQuest(undefined)).toBeNull();
    expect(sanitizeQuest("invalid")).toBeNull();
    expect(sanitizeQuest({ id: "" })).toBeNull();

    const sanitizedWithTemplate = sanitizeQuest({ id: "q1", progress: "50" }, TEMPLATE[1]);
    expect(sanitizedWithTemplate?.objectives[0].progress).toBe(50);
    expect(sanitizedWithTemplate?.title).toBe(TEMPLATE[1].title);

    expect(sanitizeAchievement(null)).toBeNull();
    expect(sanitizeAchievement({})).toBeNull();
    expect(sanitizeAchievement({ questId: "q1" })).toBeNull(); // missing txHash
    const validAch = sanitizeAchievement({ questId: "q1", txHash: "tx_123", title: "Test" });
    expect(validAch?.txHash).toBe("tx_123");
    expect(validAch?.questId).toBe("q1");
  });

  it("ensures corrupted cache never causes dashboard crashes or malformed quest shapes", () => {
    const strangeInputs = [
      "{}",
      "[]",
      "null",
      "12345",
      JSON.stringify({ version: "one", quests: null, achievements: {} }),
      JSON.stringify({ quests: [{ id: "q1", objectives: [null, undefined, 42] }] }),
      JSON.stringify({ quests: [{ id: "q1", objectives: [{ progress: -999, target: -10 }] }] }),
    ];

    for (const input of strangeInputs) {
      const storage = mockStorage({
        [walletQuestStorageKey("GDSIMULATEDDASHBOARD1234567890ABCDEF")]: input,
      });

      const loaded = loadWalletQuestBundle("GDSIMULATEDDASHBOARD1234567890ABCDEF", TEMPLATE, storage);

      // Verify invariant: must be valid PersistedWalletQuestBundle
      expect(loaded.version).toBe(QUEST_STORAGE_VERSION);
      expect(Array.isArray(loaded.quests)).toBe(true);
      expect(Array.isArray(loaded.achievements)).toBe(true);
      for (const q of loaded.quests) {
        expect(typeof q.id).toBe("string");
        expect(typeof q.title).toBe("string");
        expect(Array.isArray(q.objectives)).toBe(true);
        for (const obj of q.objectives) {
          expect(typeof obj.progress).toBe("number");
          expect(Number.isFinite(obj.progress)).toBe(true);
          expect(obj.progress).toBeGreaterThanOrEqual(0);
          expect(typeof obj.target).toBe("number");
          expect(Number.isFinite(obj.target)).toBe(true);
        }
      }
    }
  });
});
