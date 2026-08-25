import type { Achievement, Quest, QuestObjective, QuestStatus } from "./types";

export const QUEST_STORAGE_VERSION = 1;

/** Default duration (24 hours) after which cached indexer verification is considered stale. */
export const DEFAULT_STALE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const LEGACY_QUESTS_KEY = "sy_quests";
const LEGACY_ACHIEVEMENTS_KEY = "sy_achievements";

/** Display-safe snapshot for a wallet (never trust as proof of completion on-chain). */
export interface PersistedWalletQuestBundle {
  version: typeof QUEST_STORAGE_VERSION;
  quests: Quest[];
  achievements: Achievement[];
  /** When progress was last confirmed via indexer/backend (ms epoch). */
  lastSyncedAt: number | null;
}

export type StorageBackend = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export function walletQuestStorageKey(walletAddress: string): string {
  return `sy_quest_wallet_v${QUEST_STORAGE_VERSION}_${walletAddress}`;
}

export function legacyWalletQuestStorageKey(walletAddress: string): string {
  return `sy_quest_wallet_${walletAddress}`;
}

/** Deep clone quest definitions so we never mutate templates in memory. */
export function cloneQuests(quests: Quest[]): Quest[] {
  return structuredClone(quests);
}

/**
 * Checks whether a cached quest bundle is stale.
 * Returns true if:
 * - Bundle is null/undefined
 * - lastSyncedAt is null or not a valid finite number
 * - lastSyncedAt is older than maxAgeMs relative to `now`
 * - lastSyncedAt is in the future beyond 5 minutes (clock skew anomaly)
 */
export function isCacheStale(
  bundle: PersistedWalletQuestBundle | null | undefined,
  maxAgeMs = DEFAULT_STALE_CACHE_TTL_MS,
  now = Date.now(),
): boolean {
  if (!bundle || typeof bundle.lastSyncedAt !== "number" || !Number.isFinite(bundle.lastSyncedAt)) {
    return true;
  }
  const age = now - bundle.lastSyncedAt;
  if (age > maxAgeMs) {
    return true;
  }
  // Clock skew: more than 5 minutes into the future is treated as stale/unreliable
  if (bundle.lastSyncedAt > now + 5 * 60 * 1000) {
    return true;
  }
  return false;
}

/**
 * Returns the freshness category for a cached quest bundle.
 */
export function getCacheFreshness(
  bundle: PersistedWalletQuestBundle | null | undefined,
  maxAgeMs = DEFAULT_STALE_CACHE_TTL_MS,
  now = Date.now(),
): "fresh" | "stale" | "unverified" {
  if (!bundle || bundle.lastSyncedAt === null || typeof bundle.lastSyncedAt !== "number") {
    return "unverified";
  }
  return isCacheStale(bundle, maxAgeMs, now) ? "stale" : "fresh";
}

/**
 * Invalidates stale cache by resetting lastSyncedAt while preserving recovered progress and achievements.
 * Returns true if stale cache was found and invalidated.
 */
export function invalidateStaleCache(
  walletAddress: string,
  maxAgeMs = DEFAULT_STALE_CACHE_TTL_MS,
  storage: StorageBackend = typeof localStorage !== "undefined" ? localStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  now = Date.now(),
): boolean {
  const key = walletQuestStorageKey(walletAddress);
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    /* ignore */
  }
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const lastSyncedAt = typeof parsed.lastSyncedAt === "number" ? parsed.lastSyncedAt : null;
      if (lastSyncedAt !== null && isCacheStale({ ...parsed, lastSyncedAt } as PersistedWalletQuestBundle, maxAgeMs, now)) {
        parsed.lastSyncedAt = null;
        storage.setItem(key, JSON.stringify(parsed));
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function parseNumber(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === "string") {
    const parsed = Number.parseFloat(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

const VALID_STATUSES = new Set<QuestStatus>(["locked", "active", "completed", "claimable"]);

/**
 * Safely sanitizes an objective object or falls back to template definition.
 */
function sanitizeObjective(
  raw: unknown,
  templateObj?: QuestObjective,
): QuestObjective | null {
  if (!raw || typeof raw !== "object") {
    return templateObj ? structuredClone(templateObj) : null;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : templateObj?.id ?? "o_unknown";
  const description =
    typeof r.description === "string" ? r.description : templateObj?.description ?? "";
  const target = Math.max(0, parseNumber(r.target, templateObj?.target ?? 1));
  const progress = Math.max(0, parseNumber(r.progress, 0));
  const unit = typeof r.unit === "string" ? r.unit : templateObj?.unit ?? "";

  return { id, description, target, progress, unit };
}

/**
 * Safely sanitizes a quest object from any legacy or partially corrupted state.
 */
export function sanitizeQuest(raw: unknown, templateQuest?: Quest): Quest | null {
  if (!raw || typeof raw !== "object") {
    return templateQuest ? structuredClone(templateQuest) : null;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : templateQuest?.id;
  if (!id) return null;

  const title =
    typeof r.title === "string" && r.title ? r.title : templateQuest?.title ?? `Quest ${id}`;
  const description =
    typeof r.description === "string"
      ? r.description
      : templateQuest?.description ?? "";
  const points = Math.max(0, parseNumber(r.points ?? r.reward ?? r.xp, templateQuest?.points ?? 0));
  const badgeContractId =
    typeof r.badgeContractId === "string"
      ? r.badgeContractId
      : typeof r.badgeId === "string"
      ? r.badgeId
      : templateQuest?.badgeContractId ?? "";
  const category = (
    ["deposit", "hold", "trade", "governance", "social"].includes(r.category as string)
      ? r.category
      : templateQuest?.category ?? "deposit"
  ) as Quest["category"];
  const icon = typeof r.icon === "string" ? r.icon : templateQuest?.icon ?? "Landmark";

  // Recover objectives
  let objectives: QuestObjective[] = [];
  if (Array.isArray(r.objectives) && r.objectives.length > 0) {
    objectives = r.objectives
      .map((rawObj, i) =>
        sanitizeObjective(
          rawObj,
          templateQuest?.objectives[i] ?? templateQuest?.objectives.find((to) => (rawObj as Record<string, unknown>)?.id === to.id)
        )
      )
      .filter((o): o is QuestObjective => Boolean(o));
  }

  // Handle legacy flat progress/target shape: { progress: 50, target: 100 }
  if (objectives.length === 0) {
    if (templateQuest?.objectives?.length) {
      const flatProgress = parseNumber(r.progress, 0);
      objectives = templateQuest.objectives.map((to, i) => ({
        ...to,
        progress: i === 0 ? Math.max(0, flatProgress) : 0,
      }));
    } else {
      const flatProgress = Math.max(0, parseNumber(r.progress, 0));
      const flatTarget = Math.max(1, parseNumber(r.target, 1));
      objectives = [
        {
          id: `${id}_obj`,
          description: description || title,
          target: flatTarget,
          progress: flatProgress,
          unit: "",
        },
      ];
    }
  }

  // Determine or sanitize status
  let status: QuestStatus = "active";
  if (typeof r.status === "string" && VALID_STATUSES.has(r.status as QuestStatus)) {
    status = r.status as QuestStatus;
  } else if (typeof r.completed === "boolean") {
    status = r.completed ? "completed" : "active";
  } else if (templateQuest) {
    // Check if objectives met
    const allMet = objectives.every((o) => o.progress >= o.target);
    status = allMet ? "claimable" : templateQuest.status;
  }

  return {
    id,
    title,
    description,
    points,
    status,
    badgeContractId,
    category,
    icon,
    objectives,
  };
}

/**
 * Safely sanitizes an achievement object from legacy or partially corrupted state.
 */
export function sanitizeAchievement(raw: unknown): Achievement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const questId = typeof r.questId === "string" && r.questId ? r.questId : "";
  const txHash = typeof r.txHash === "string" && r.txHash ? r.txHash : "";
  if (!questId || !txHash) return null;

  const title = typeof r.title === "string" ? r.title : `Quest ${questId}`;
  const badgeContractId =
    typeof r.badgeContractId === "string"
      ? r.badgeContractId
      : typeof r.badgeId === "string"
      ? r.badgeId
      : "";
  const mintedAt = parseNumber(r.mintedAt, Date.now());

  return {
    questId,
    title,
    badgeContractId,
    mintedAt,
    txHash,
  };
}

/**
 * Upgrades and migrates any older, flat, unversioned, or future quest bundle safely.
 */
export function migrateQuestBundle(
  raw: unknown,
  template: Quest[],
): PersistedWalletQuestBundle {
  if (!raw || typeof raw !== "object") {
    return {
      version: QUEST_STORAGE_VERSION,
      quests: cloneQuests(template),
      achievements: [],
      lastSyncedAt: null,
    };
  }

  const r = raw as Record<string, unknown>;
  const templateById = new Map(template.map((q) => [q.id, q]));

  // Recover quests
  const rawQuests = Array.isArray(r.quests)
    ? r.quests
    : Array.isArray(raw)
    ? (raw as unknown[])
    : [];

  const sanitizedQuests = rawQuests
    .map((q) => {
      const qId = q && typeof q === "object" ? (q as Record<string, unknown>).id : undefined;
      const templateQ = typeof qId === "string" ? templateById.get(qId) : undefined;
      return sanitizeQuest(q, templateQ);
    })
    .filter((q): q is Quest => Boolean(q));

  // Recover achievements
  const rawAchievements = Array.isArray(r.achievements) ? r.achievements : [];
  const sanitizedAchievements = rawAchievements
    .map((a) => sanitizeAchievement(a))
    .filter((a): a is Achievement => Boolean(a));

  // Recover lastSyncedAt
  let lastSyncedAt: number | null = null;
  if (typeof r.lastSyncedAt === "number" && Number.isFinite(r.lastSyncedAt) && r.lastSyncedAt > 0) {
    lastSyncedAt = r.lastSyncedAt;
  }

  return {
    version: QUEST_STORAGE_VERSION,
    quests: mergeQuestsWithTemplate(sanitizedQuests, template),
    achievements: sanitizedAchievements,
    lastSyncedAt,
  };
}

/**
 * Ensures new quests from the template appear while preserving saved progress for known IDs.
 */
export function mergeQuestsWithTemplate(
  persisted: Quest[] | null | undefined,
  template: Quest[],
): Quest[] {
  if (!template || template.length === 0) {
    return (persisted ?? [])
      .map((q) => sanitizeQuest(q))
      .filter((q): q is Quest => Boolean(q));
  }
  const base = cloneQuests(template);
  if (!persisted?.length) return base;

  const validPersisted = persisted
    .map((q) => sanitizeQuest(q))
    .filter((q): q is Quest => Boolean(q));

  const byId = new Map(validPersisted.map((q) => [q.id, q]));

  return base.map((templateQ) => {
    const saved = byId.get(templateQ.id);
    if (!saved) return templateQ;

    // Merge objectives cleanly: match by objective id or fallback to index
    const mergedObjectives = templateQ.objectives.map((tObj, idx) => {
      const matchingSavedObj =
        saved.objectives.find((sObj) => sObj.id === tObj.id) ?? saved.objectives[idx];
      return {
        ...tObj,
        progress: typeof matchingSavedObj?.progress === "number" && Number.isFinite(matchingSavedObj.progress)
          ? Math.max(0, matchingSavedObj.progress)
          : 0,
      };
    });

    // Check if status is completed or claimable
    const status = saved.status && VALID_STATUSES.has(saved.status) ? saved.status : templateQ.status;

    return {
      ...templateQ,
      status,
      objectives: mergedObjectives,
    };
  });
}

/**
 * Simulates indexer-confirmed objective progress (replace with real API in production).
 */
export function applySimulatedIndexerProgress(quests: Quest[]): Quest[] {
  return quests.map((q) => {
    if (q.id === "q1") {
      const progress = 100;
      const completed = progress >= q.objectives[0].target;
      return {
        ...q,
        status: completed ? "claimable" : "active",
        objectives: [{ ...q.objectives[0], progress }],
      };
    }
    if (q.id === "q2") {
      const progress = 12;
      return {
        ...q,
        objectives: [{ ...q.objectives[0], progress }],
      };
    }
    if (q.id === "q4") {
      const progress = 3;
      const completed = progress >= q.objectives[0].target;
      return {
        ...q,
        status: completed ? "claimable" : "active",
        objectives: [{ ...q.objectives[0], progress }],
      };
    }
    return q;
  });
}

function parseBundle(raw: string | null, template: Quest[]): PersistedWalletQuestBundle | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return migrateQuestBundle(parsed, template);
    }
  } catch {
    /* ignore parse errors gracefully */
  }
  return null;
}

function readLegacyGlobalBundle(
  storage: StorageBackend,
  template: Quest[],
): PersistedWalletQuestBundle | null {
  try {
    const rawQ = storage.getItem(LEGACY_QUESTS_KEY);
    const rawA = storage.getItem(LEGACY_ACHIEVEMENTS_KEY);
    if (!rawQ) return null;

    let quests: unknown = null;
    let achievements: unknown = null;
    try {
      quests = JSON.parse(rawQ);
    } catch {
      /* ignore */
    }
    if (rawA) {
      try {
        achievements = JSON.parse(rawA);
      } catch {
        /* ignore */
      }
    }

    if (!quests) return null;

    storage.removeItem(LEGACY_QUESTS_KEY);
    storage.removeItem(LEGACY_ACHIEVEMENTS_KEY);

    return migrateQuestBundle(
      {
        quests,
        achievements: Array.isArray(achievements) ? achievements : [],
        lastSyncedAt: Date.now(),
      },
      template,
    );
  } catch {
    return null;
  }
}

function readLegacyWalletBundle(
  walletAddress: string,
  storage: StorageBackend,
  template: Quest[],
): PersistedWalletQuestBundle | null {
  try {
    const legacyKey = legacyWalletQuestStorageKey(walletAddress);
    const raw = storage.getItem(legacyKey);
    if (!raw) return null;

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* ignore */
    }

    if (!parsed) return null;
    storage.removeItem(legacyKey);

    return migrateQuestBundle(parsed, template);
  } catch {
    return null;
  }
}

export function loadWalletQuestBundle(
  walletAddress: string,
  template: Quest[],
  storage: StorageBackend = typeof localStorage !== "undefined" ? localStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
): PersistedWalletQuestBundle {
  const currentKey = walletQuestStorageKey(walletAddress);
  let raw: string | null = null;
  try {
    raw = storage.getItem(currentKey);
  } catch {
    /* ignore private mode / security errors */
  }

  // 1. Try parsing from current version key with full migration/recovery support
  const fromDisk = parseBundle(raw, template);
  if (fromDisk) {
    return fromDisk;
  }

  // 2. Try migrating legacy unversioned per-wallet key
  const legacyWallet = readLegacyWalletBundle(walletAddress, storage, template);
  if (legacyWallet) {
    saveWalletQuestBundle(walletAddress, legacyWallet, storage);
    return legacyWallet;
  }

  // 3. Try migrating legacy global keys
  const legacyGlobal = readLegacyGlobalBundle(storage, template);
  if (legacyGlobal) {
    saveWalletQuestBundle(walletAddress, legacyGlobal, storage);
    return legacyGlobal;
  }

  // 4. Default fresh template bundle
  return {
    version: QUEST_STORAGE_VERSION,
    quests: cloneQuests(template),
    achievements: [],
    lastSyncedAt: null,
  };
}

export function saveWalletQuestBundle(
  walletAddress: string,
  bundle: PersistedWalletQuestBundle,
  storage: StorageBackend = typeof localStorage !== "undefined" ? localStorage : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
): void {
  try {
    storage.setItem(
      walletQuestStorageKey(walletAddress),
      JSON.stringify(bundle),
    );
  } catch {
    /* quota or private mode — non-fatal */
  }
}
