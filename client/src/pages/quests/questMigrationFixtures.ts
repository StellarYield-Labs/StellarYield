import type { Quest, Achievement } from "./types";
import { QUEST_STORAGE_VERSION, type PersistedWalletQuestBundle } from "./questPersistence";

/**
 * Migration & Stale Cache Test Fixtures for Quest Persistence
 */

/** V0 Legacy: Global localStorage keys (sy_quests & sy_achievements) before per-wallet isolation */
export const v0LegacyGlobalQuestsFixture: Array<Record<string, unknown>> = [
  {
    id: "q1",
    title: "First Deposit (Legacy)",
    description: "Legacy deposit quest description.",
    points: 50,
    status: "claimable",
    badgeContractId: "CBADGE_FIRST_DEPOSIT",
    category: "deposit",
    icon: "Landmark",
    objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 100, unit: "USDC" }],
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
    objectives: [{ id: "o2", description: "Hold for 30 days", target: 30, progress: 15, unit: "days" }],
  },
];

export const v0LegacyGlobalAchievementsFixture: Achievement[] = [
  {
    questId: "q1",
    title: "First Deposit",
    badgeContractId: "CBADGE_FIRST_DEPOSIT",
    mintedAt: 1690000000000,
    txHash: "tx_legacy_global_001",
  },
];

/** V0 Legacy: Per-wallet key without version tag or with unversioned payload */
export const v0UnversionedWalletPayloadFixture: Record<string, unknown> = {
  quests: [
    {
      id: "q1",
      title: "First Deposit",
      description: "Deposit 100 USDC",
      points: 50,
      status: "completed",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      category: "deposit",
      icon: "Landmark",
      objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 100, unit: "USDC" }],
    },
    {
      id: "q4",
      title: "Governance Voter",
      description: "Vote on proposals",
      points: 100,
      status: "active",
      badgeContractId: "CBADGE_VOTER",
      category: "governance",
      icon: "ShieldCheck",
      objectives: [{ id: "o4", description: "Vote on proposals", target: 3, progress: 2, unit: "votes" }],
    },
  ],
  achievements: [
    {
      questId: "q1",
      title: "First Deposit",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      mintedAt: 1695000000000,
      txHash: "tx_unversioned_wallet_001",
    },
  ],
  lastSyncedAt: 1695000000000,
};

/** V0 Legacy Flat Quest Shape: quests without objectives array, using flat progress/reward/completed fields */
export const v0FlatQuestShapeBundleFixture: Record<string, unknown> = {
  version: 0,
  quests: [
    {
      id: "q1",
      title: "First Deposit",
      reward: 50, // older key for points
      completed: true, // older boolean status
      progress: 100, // flat progress
      target: 100,
      badgeId: "CBADGE_FIRST_DEPOSIT", // older key for badgeContractId
    },
    {
      id: "q2",
      title: "Diamond Hands",
      reward: 150,
      completed: false,
      progress: 20,
      target: 30,
      badgeId: "CBADGE_DIAMOND_HANDS",
    },
  ],
  achievements: [
    {
      questId: "q1",
      title: "First Deposit",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      mintedAt: 1691000000000,
      txHash: "tx_flat_shape_001",
    },
  ],
  lastSyncedAt: 1691000000000,
};

/** Partially Corrupted Bundle: mixed valid data with nulls, broken items, string numbers, and corrupted achievements */
export const partiallyCorruptedBundleFixture: Record<string, unknown> = {
  version: QUEST_STORAGE_VERSION,
  quests: [
    null,
    { id: "q1", status: "claimable", objectives: [{ id: "o1", target: 100, progress: 100, unit: "USDC" }] },
    "corrupted string element",
    {
      id: "q2",
      title: "Diamond Hands",
      description: "Corrupted objectives structure",
      status: "active",
      objectives: "invalid_objectives_not_array",
      progress: 18,
    },
    {
      id: "q4",
      status: "unknown_status",
      objectives: [{ id: "o4", progress: "2", target: "3" }], // string numbers
    },
    { id: "broken_no_objectives" },
  ],
  achievements: [
    null,
    {
      questId: "q1",
      title: "First Deposit",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      mintedAt: 1700000000000,
      txHash: "tx_valid_achievement_001",
    },
    { questId: "missing_tx_hash", title: "Incomplete" }, // missing txHash
    "corrupted achievement item",
  ],
  lastSyncedAt: "invalid_timestamp_not_number",
};

/** Stale Cache Bundle: synced 3 days ago (> 24h stale TTL) */
export function createStaleCacheFixture(ageMs = 3 * 24 * 60 * 60 * 1000, now = Date.now()): PersistedWalletQuestBundle {
  return {
    version: QUEST_STORAGE_VERSION,
    quests: [
      {
        id: "q1",
        title: "First Deposit",
        description: "Deposit USDC",
        points: 50,
        status: "active",
        badgeContractId: "CBADGE_FIRST_DEPOSIT",
        category: "deposit",
        icon: "Landmark",
        objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 40, unit: "USDC" }],
      },
    ],
    achievements: [],
    lastSyncedAt: now - ageMs,
  };
}

/** Future Version Bundle: higher version number with extra schema fields */
export const futureVersionBundleFixture: Record<string, unknown> = {
  version: 99,
  quests: [
    {
      id: "q1",
      title: "First Deposit",
      description: "Deposit 100 USDC",
      points: 50,
      status: "claimable",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      category: "deposit",
      icon: "Landmark",
      objectives: [{ id: "o1", description: "Deposit 100 USDC", target: 100, progress: 100, unit: "USDC" }],
      futureFieldV99: "extra metadata",
    },
  ],
  achievements: [
    {
      questId: "q1",
      title: "First Deposit",
      badgeContractId: "CBADGE_FIRST_DEPOSIT",
      mintedAt: 1710000000000,
      txHash: "tx_future_v99",
      futureAchievementProof: "proof_abc",
    },
  ],
  lastSyncedAt: 1710000000000,
  seasonId: 5,
};
