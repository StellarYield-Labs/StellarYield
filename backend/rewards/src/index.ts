export { generateMerkleTree, verifyProof, computeLeaf, hashPair } from "./merkleTree";
export type { RewardEntry, MerkleTreeResult } from "./merkleTree";

export {
  calculateRewards,
  generateWeeklyDistribution,
  getUserProof,
} from "./generateTree";
export type { UserRewardInput } from "./generateTree";

export { simulateCampaignDryRun } from "./dryRunSimulator";
export type {
  CampaignRecipient,
  CampaignSegment,
  CampaignClaimWindow,
  CampaignDryRunInput,
  DryRunIssue,
  DryRunIssueCode,
  DryRunReport,
} from "./dryRunSimulator";
