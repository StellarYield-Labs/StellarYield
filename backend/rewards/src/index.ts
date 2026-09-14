export {
  generateMerkleTree,
  verifyProof,
  computeLeaf,
  hashPair,
  normalizeMetadataHash,
  ZERO_METADATA_HASH,
} from "./merkleTree";
export type { RewardEntry, MerkleClaim, MerkleTreeResult } from "./merkleTree";

export {
  calculateRewards,
  generateWeeklyDistribution,
  getUserProof,
} from "./generateTree";
export type { UserRewardInput, RewardDistributionContext } from "./generateTree";
