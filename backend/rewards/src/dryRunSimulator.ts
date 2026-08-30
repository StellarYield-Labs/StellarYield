import {
  generateMerkleTree,
  type MerkleTreeResult,
  type RewardEntry,
} from "./merkleTree";

/**
 * A single recipient allocation before proof generation.
 */
export interface CampaignRecipient {
  /** Stellar wallet address. */
  address: string;
  /** Reward amount in stroops (1 YIELD = 10^7 stroops), as a decimal string. */
  amount: string;
}

/**
 * A named group of recipients (e.g. "early-adopters", "top-holders").
 * Segments let a campaign target distinct audiences with different
 * allocation rules while still reconciling against one shared budget.
 */
export interface CampaignSegment {
  name: string;
  recipients: CampaignRecipient[];
}

/** Unix timestamps (seconds) recipients may claim between. */
export interface CampaignClaimWindow {
  startTimestamp: number;
  endTimestamp: number;
}

export interface CampaignDryRunInput {
  segments: CampaignSegment[];
  /** Total $YIELD budget for the campaign, in stroops. */
  totalBudget: string;
  claimWindow: CampaignClaimWindow;
  /** Injectable "current time" (unix seconds) for deterministic tests; defaults to the real clock. */
  now?: number;
}

export type DryRunIssueCode =
  | "EMPTY_SEGMENT"
  | "DUPLICATE_RECIPIENT"
  | "INVALID_AMOUNT"
  | "INVALID_BUDGET"
  | "BUDGET_EXCEEDED"
  | "INVALID_CLAIM_WINDOW"
  | "LOW_BUDGET_UTILIZATION"
  | "SHORT_CLAIM_WINDOW";

export interface DryRunIssue {
  code: DryRunIssueCode;
  message: string;
  context?: Record<string, unknown>;
}

export interface DryRunReport {
  /** True iff there are no blocking errors. */
  ok: boolean;
  /** Blocking — the campaign must not be published while these exist. */
  errors: DryRunIssue[];
  /** Non-blocking — surfaced for admin review but don't prevent publishing. */
  warnings: DryRunIssue[];
  totalRecipients: number;
  /** Sum of all valid recipient amounts, in stroops. */
  totalAllocated: string;
  totalBudget: string;
  /** totalBudget - totalAllocated; negative when over budget. */
  budgetRemaining: string;
  /**
   * Merkle root + per-recipient claim proofs, ready to hand to the on-chain
   * distribution. Only present when `ok` is true — a tree built over data
   * with duplicate addresses or invalid amounts wouldn't be meaningful.
   */
  proofInput?: MerkleTreeResult;
}

function normalizeAddress(address: string): string {
  return address.trim().toUpperCase();
}

/**
 * Validate a proposed reward campaign — recipients, allocation rules, and
 * claim window — against a total budget, and produce the Merkle proof
 * generation input when the campaign is clean.
 *
 * Nothing here has side effects or touches the network/database: it's a
 * pure function of its input (plus the optional injected `now`), so the
 * same input always produces the same report.
 */
export function simulateCampaignDryRun(
  input: CampaignDryRunInput,
): DryRunReport {
  const errors: DryRunIssue[] = [];
  const warnings: DryRunIssue[] = [];
  const now = input.now ?? Math.floor(Date.now() / 1000);

  for (const segment of input.segments) {
    if (segment.recipients.length === 0) {
      errors.push({
        code: "EMPTY_SEGMENT",
        message: `Segment "${segment.name}" has no recipients`,
        context: { segment: segment.name },
      });
    }
  }

  const flatRecipients: Array<{
    segment: string;
    recipient: CampaignRecipient;
  }> = [];
  for (const segment of input.segments) {
    for (const recipient of segment.recipients) {
      flatRecipients.push({ segment: segment.name, recipient });
    }
  }

  // Duplicate recipients — same address appearing more than once, whether
  // within one segment or split across several.
  const occurrencesByAddress = new Map<string, string[]>();
  for (const { segment, recipient } of flatRecipients) {
    const key = normalizeAddress(recipient.address);
    const segmentsSeen = occurrencesByAddress.get(key) ?? [];
    segmentsSeen.push(segment);
    occurrencesByAddress.set(key, segmentsSeen);
  }
  for (const [address, segmentsSeen] of occurrencesByAddress) {
    if (segmentsSeen.length > 1) {
      errors.push({
        code: "DUPLICATE_RECIPIENT",
        message: `Recipient ${address} appears ${segmentsSeen.length} times (segments: ${segmentsSeen.join(", ")})`,
        context: {
          address,
          segments: segmentsSeen,
          occurrences: segmentsSeen.length,
        },
      });
    }
  }

  // Recipient amounts + running total.
  let totalAllocated = BigInt(0);
  for (const { segment, recipient } of flatRecipients) {
    let amount: bigint;
    try {
      amount = BigInt(recipient.amount);
    } catch {
      errors.push({
        code: "INVALID_AMOUNT",
        message: `Recipient ${recipient.address} in segment "${segment}" has a non-numeric amount: "${recipient.amount}"`,
        context: { address: recipient.address, segment, amount: recipient.amount },
      });
      continue;
    }
    if (amount <= BigInt(0)) {
      errors.push({
        code: "INVALID_AMOUNT",
        message: `Recipient ${recipient.address} in segment "${segment}" has a non-positive amount: ${recipient.amount}`,
        context: { address: recipient.address, segment, amount: recipient.amount },
      });
      continue;
    }
    totalAllocated += amount;
  }

  // Budget.
  let totalBudget: bigint;
  try {
    totalBudget = BigInt(input.totalBudget);
    if (totalBudget < BigInt(0)) throw new Error("negative budget");
  } catch {
    errors.push({
      code: "INVALID_BUDGET",
      message: `totalBudget must be a non-negative integer, got: "${input.totalBudget}"`,
      context: { totalBudget: input.totalBudget },
    });
    totalBudget = BigInt(0);
  }

  if (totalAllocated > totalBudget) {
    errors.push({
      code: "BUDGET_EXCEEDED",
      message: `Allocated ${totalAllocated.toString()} stroops exceeds the campaign budget of ${totalBudget.toString()} stroops (over by ${(totalAllocated - totalBudget).toString()})`,
      context: {
        totalAllocated: totalAllocated.toString(),
        totalBudget: totalBudget.toString(),
        overage: (totalAllocated - totalBudget).toString(),
      },
    });
  } else if (totalBudget > BigInt(0)) {
    const utilizationBps = Number(
      (totalAllocated * BigInt(10000)) / totalBudget,
    );
    if (utilizationBps < 1000) {
      warnings.push({
        code: "LOW_BUDGET_UTILIZATION",
        message: `Only ${(utilizationBps / 100).toFixed(2)}% of the campaign budget is allocated`,
        context: { utilizationBps },
      });
    }
  }

  // Claim window.
  const { startTimestamp, endTimestamp } = input.claimWindow;
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
    errors.push({
      code: "INVALID_CLAIM_WINDOW",
      message: `Claim window timestamps must be finite numbers (got start=${startTimestamp}, end=${endTimestamp})`,
      context: { startTimestamp, endTimestamp },
    });
  } else if (endTimestamp <= startTimestamp) {
    errors.push({
      code: "INVALID_CLAIM_WINDOW",
      message: `Claim window end (${endTimestamp}) must be after start (${startTimestamp})`,
      context: { startTimestamp, endTimestamp },
    });
  } else if (endTimestamp <= now) {
    errors.push({
      code: "INVALID_CLAIM_WINDOW",
      message: `Claim window already ended (end=${endTimestamp}, now=${now}) — recipients would have no opportunity to claim`,
      context: { startTimestamp, endTimestamp, now },
    });
  } else {
    const durationSeconds = endTimestamp - startTimestamp;
    const ONE_HOUR_SECONDS = 3600;
    if (durationSeconds < ONE_HOUR_SECONDS) {
      warnings.push({
        code: "SHORT_CLAIM_WINDOW",
        message: `Claim window is only ${durationSeconds} second(s) long`,
        context: { durationSeconds },
      });
    }
  }

  const ok = errors.length === 0;

  const report: DryRunReport = {
    ok,
    errors,
    warnings,
    totalRecipients: flatRecipients.length,
    totalAllocated: totalAllocated.toString(),
    totalBudget: totalBudget.toString(),
    budgetRemaining: (totalBudget - totalAllocated).toString(),
  };

  if (ok) {
    const entries: RewardEntry[] = flatRecipients.map((fr, index) => ({
      index,
      address: fr.recipient.address,
      amount: fr.recipient.amount,
    }));
    report.proofInput = generateMerkleTree(entries);
  }

  return report;
}
