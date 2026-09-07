export type ReallocationPolicyDecision =
  | "auto_approved"
  | "approval_required"
  | "rejected";

export type PolicyRuleEffect = "require_approval" | "reject";

export type RecentIncidentState = "none" | "resolved" | "active" | "critical";

export interface TreasuryReallocationProposal {
  id: string;
  amountUsd: number;
  treasuryValueUsd: number;
  currentRiskScore: number;
  proposedRiskScore: number;
  /** Target portfolio exposures after the reallocation. */
  assetExposurePct: Record<string, number>;
  /** Target portfolio exposures after the reallocation. */
  protocolExposurePct: Record<string, number>;
  recentIncidentState: RecentIncidentState;
}

export interface ExposurePolicy {
  maxAutoApprovedPct: number;
  maxPct: number;
  denied: string[];
}

export interface TreasuryReallocationPolicy {
  size: {
    maxAutoApprovedAmountUsd: number;
    maxAmountUsd: number;
    maxAutoApprovedTreasuryPct: number;
    maxTreasuryPct: number;
  };
  risk: {
    maxAutoApprovedScoreIncrease: number;
    maxScoreIncrease: number;
    maxProposedRiskScore: number;
  };
  assetExposure: ExposurePolicy;
  protocolExposure: ExposurePolicy;
  incidents: {
    approvalRequiredStates: RecentIncidentState[];
    rejectedStates: RecentIncidentState[];
  };
}

export interface PolicyRuleBlock {
  /** Stable identifier for the exact configured rule that blocked automation. */
  ruleId: string;
  category: "size" | "risk" | "asset_exposure" | "protocol_exposure" | "incident";
  effect: PolicyRuleEffect;
  actual: number | string;
  threshold: number | string[];
  message: string;
}

export interface ReallocationPolicyEvaluation {
  decision: ReallocationPolicyDecision;
  proposalId: string;
  blockedRules: PolicyRuleBlock[];
}

export interface ManualReallocationApproval {
  approvedBy: string;
  approvedAt: string;
}

export type ReallocationExecutionResponse<T> =
  | {
      status: "executed";
      approvalMode: "automatic" | "manual";
      evaluation: ReallocationPolicyEvaluation;
      executionResult: T;
    }
  | {
      status: "approval_required" | "rejected";
      evaluation: ReallocationPolicyEvaluation;
    };

export const DEFAULT_TREASURY_REALLOCATION_POLICY: TreasuryReallocationPolicy = {
  size: {
    maxAutoApprovedAmountUsd: 100_000,
    maxAmountUsd: 1_000_000,
    maxAutoApprovedTreasuryPct: 10,
    maxTreasuryPct: 40,
  },
  risk: {
    maxAutoApprovedScoreIncrease: 5,
    maxScoreIncrease: 20,
    maxProposedRiskScore: 80,
  },
  assetExposure: {
    maxAutoApprovedPct: 25,
    maxPct: 50,
    denied: [],
  },
  protocolExposure: {
    maxAutoApprovedPct: 30,
    maxPct: 60,
    denied: [],
  },
  incidents: {
    approvalRequiredStates: ["resolved"],
    rejectedStates: ["active", "critical"],
  },
};

function requireFiniteInRange(value: number, path: string, min: number, max?: number): void {
  if (!Number.isFinite(value) || value < min || (max !== undefined && value > max)) {
    const upper = max === undefined ? "" : ` and at most ${max}`;
    throw new Error(`${path} must be a finite number of at least ${min}${upper}`);
  }
}

function validateExposure(exposure: Record<string, number>, path: string): void {
  if (!exposure || typeof exposure !== "object" || Array.isArray(exposure)) {
    throw new Error(`${path} must be an object`);
  }
  for (const [name, percentage] of Object.entries(exposure)) {
    if (!name.trim()) throw new Error(`${path} keys must be non-empty`);
    requireFiniteInRange(percentage, `${path}.${name}`, 0, 100);
  }
}

function validateProposal(proposal: TreasuryReallocationProposal): void {
  if (!proposal || typeof proposal !== "object") throw new Error("proposal is required");
  if (typeof proposal.id !== "string" || !proposal.id.trim()) {
    throw new Error("proposal.id must be a non-empty string");
  }
  requireFiniteInRange(proposal.amountUsd, "proposal.amountUsd", 0);
  requireFiniteInRange(proposal.treasuryValueUsd, "proposal.treasuryValueUsd", Number.EPSILON);
  if (proposal.amountUsd > proposal.treasuryValueUsd) {
    throw new Error("proposal.amountUsd cannot exceed proposal.treasuryValueUsd");
  }
  requireFiniteInRange(proposal.currentRiskScore, "proposal.currentRiskScore", 0, 100);
  requireFiniteInRange(proposal.proposedRiskScore, "proposal.proposedRiskScore", 0, 100);
  validateExposure(proposal.assetExposurePct, "proposal.assetExposurePct");
  validateExposure(proposal.protocolExposurePct, "proposal.protocolExposurePct");
  if (!["none", "resolved", "active", "critical"].includes(proposal.recentIncidentState)) {
    throw new Error("proposal.recentIncidentState is invalid");
  }
}

function validateExposurePolicy(policy: ExposurePolicy, path: string): void {
  requireFiniteInRange(policy.maxAutoApprovedPct, `${path}.maxAutoApprovedPct`, 0, 100);
  requireFiniteInRange(policy.maxPct, `${path}.maxPct`, 0, 100);
  if (policy.maxAutoApprovedPct > policy.maxPct) {
    throw new Error(`${path}.maxAutoApprovedPct cannot exceed ${path}.maxPct`);
  }
  if (!Array.isArray(policy.denied) || !policy.denied.every((value) => typeof value === "string")) {
    throw new Error(`${path}.denied must be an array of strings`);
  }
}

function validatePolicy(policy: TreasuryReallocationPolicy): void {
  if (!policy || typeof policy !== "object") throw new Error("policy is required");
  requireFiniteInRange(policy.size.maxAutoApprovedAmountUsd, "policy.size.maxAutoApprovedAmountUsd", 0);
  requireFiniteInRange(policy.size.maxAmountUsd, "policy.size.maxAmountUsd", 0);
  requireFiniteInRange(policy.size.maxAutoApprovedTreasuryPct, "policy.size.maxAutoApprovedTreasuryPct", 0, 100);
  requireFiniteInRange(policy.size.maxTreasuryPct, "policy.size.maxTreasuryPct", 0, 100);
  if (policy.size.maxAutoApprovedAmountUsd > policy.size.maxAmountUsd) {
    throw new Error("policy.size.maxAutoApprovedAmountUsd cannot exceed policy.size.maxAmountUsd");
  }
  if (policy.size.maxAutoApprovedTreasuryPct > policy.size.maxTreasuryPct) {
    throw new Error("policy.size.maxAutoApprovedTreasuryPct cannot exceed policy.size.maxTreasuryPct");
  }
  requireFiniteInRange(policy.risk.maxAutoApprovedScoreIncrease, "policy.risk.maxAutoApprovedScoreIncrease", 0, 100);
  requireFiniteInRange(policy.risk.maxScoreIncrease, "policy.risk.maxScoreIncrease", 0, 100);
  requireFiniteInRange(policy.risk.maxProposedRiskScore, "policy.risk.maxProposedRiskScore", 0, 100);
  if (policy.risk.maxAutoApprovedScoreIncrease > policy.risk.maxScoreIncrease) {
    throw new Error("policy.risk.maxAutoApprovedScoreIncrease cannot exceed policy.risk.maxScoreIncrease");
  }
  validateExposurePolicy(policy.assetExposure, "policy.assetExposure");
  validateExposurePolicy(policy.protocolExposure, "policy.protocolExposure");
  if (!Array.isArray(policy.incidents.approvalRequiredStates) || !Array.isArray(policy.incidents.rejectedStates)) {
    throw new Error("policy incident states must be arrays");
  }
  const overlap = policy.incidents.approvalRequiredStates.find((state) =>
    policy.incidents.rejectedStates.includes(state),
  );
  if (overlap) throw new Error(`incident state ${overlap} cannot require approval and rejection`);
}

function addNumericRule(
  rules: PolicyRuleBlock[],
  input: Omit<PolicyRuleBlock, "actual" | "threshold" | "message"> & {
    actual: number;
    threshold: number;
    subject: string;
  },
): void {
  if (input.actual <= input.threshold) return;
  rules.push({
    ruleId: input.ruleId,
    category: input.category,
    effect: input.effect,
    actual: input.actual,
    threshold: input.threshold,
    message: `${input.subject} is ${input.actual}, above the configured limit of ${input.threshold}.`,
  });
}

function evaluateExposure(
  rules: PolicyRuleBlock[],
  exposure: Record<string, number>,
  policy: ExposurePolicy,
  category: "asset_exposure" | "protocol_exposure",
  label: "Asset" | "Protocol",
): void {
  const denied = new Set(policy.denied);
  for (const name of Object.keys(exposure).sort((a, b) => a.localeCompare(b))) {
    const actual = exposure[name];
    if (denied.has(name) && actual > 0) {
      rules.push({
        ruleId: `${category}.denied`,
        category,
        effect: "reject",
        actual: name,
        threshold: [...policy.denied].sort((a, b) => a.localeCompare(b)),
        message: `${label} ${name} is denied by treasury policy and has ${actual}% target exposure.`,
      });
    }
    addNumericRule(rules, {
      ruleId: `${category}.max_exposure_pct`,
      category,
      effect: "reject",
      actual,
      threshold: policy.maxPct,
      subject: `${label} ${name} target exposure (%)`,
    });
    addNumericRule(rules, {
      ruleId: `${category}.max_auto_approved_exposure_pct`,
      category,
      effect: "require_approval",
      actual,
      threshold: policy.maxAutoApprovedPct,
      subject: `${label} ${name} target exposure (%)`,
    });
  }
}

/**
 * Pure policy evaluation. It has no clock or storage dependency, and rules are
 * emitted in a stable order so identical inputs always produce identical output.
 */
export function evaluateTreasuryReallocation(
  proposal: TreasuryReallocationProposal,
  policy: TreasuryReallocationPolicy = DEFAULT_TREASURY_REALLOCATION_POLICY,
): ReallocationPolicyEvaluation {
  validateProposal(proposal);
  validatePolicy(policy);

  const blockedRules: PolicyRuleBlock[] = [];
  const treasuryPct = (proposal.amountUsd / proposal.treasuryValueUsd) * 100;
  const riskIncrease = proposal.proposedRiskScore - proposal.currentRiskScore;

  addNumericRule(blockedRules, {
    ruleId: "size.max_amount_usd",
    category: "size",
    effect: "reject",
    actual: proposal.amountUsd,
    threshold: policy.size.maxAmountUsd,
    subject: "Reallocation amount (USD)",
  });
  addNumericRule(blockedRules, {
    ruleId: "size.max_treasury_pct",
    category: "size",
    effect: "reject",
    actual: treasuryPct,
    threshold: policy.size.maxTreasuryPct,
    subject: "Reallocation size (% of treasury)",
  });
  addNumericRule(blockedRules, {
    ruleId: "size.max_auto_approved_amount_usd",
    category: "size",
    effect: "require_approval",
    actual: proposal.amountUsd,
    threshold: policy.size.maxAutoApprovedAmountUsd,
    subject: "Reallocation amount (USD)",
  });
  addNumericRule(blockedRules, {
    ruleId: "size.max_auto_approved_treasury_pct",
    category: "size",
    effect: "require_approval",
    actual: treasuryPct,
    threshold: policy.size.maxAutoApprovedTreasuryPct,
    subject: "Reallocation size (% of treasury)",
  });
  addNumericRule(blockedRules, {
    ruleId: "risk.max_proposed_score",
    category: "risk",
    effect: "reject",
    actual: proposal.proposedRiskScore,
    threshold: policy.risk.maxProposedRiskScore,
    subject: "Proposed risk score",
  });
  addNumericRule(blockedRules, {
    ruleId: "risk.max_score_increase",
    category: "risk",
    effect: "reject",
    actual: riskIncrease,
    threshold: policy.risk.maxScoreIncrease,
    subject: "Risk score increase",
  });
  addNumericRule(blockedRules, {
    ruleId: "risk.max_auto_approved_score_increase",
    category: "risk",
    effect: "require_approval",
    actual: riskIncrease,
    threshold: policy.risk.maxAutoApprovedScoreIncrease,
    subject: "Risk score increase",
  });

  evaluateExposure(blockedRules, proposal.assetExposurePct, policy.assetExposure, "asset_exposure", "Asset");
  evaluateExposure(
    blockedRules,
    proposal.protocolExposurePct,
    policy.protocolExposure,
    "protocol_exposure",
    "Protocol",
  );

  if (policy.incidents.rejectedStates.includes(proposal.recentIncidentState)) {
    blockedRules.push({
      ruleId: "incident.rejected_states",
      category: "incident",
      effect: "reject",
      actual: proposal.recentIncidentState,
      threshold: [...policy.incidents.rejectedStates],
      message: `Recent incident state ${proposal.recentIncidentState} is configured to reject reallocations.`,
    });
  } else if (policy.incidents.approvalRequiredStates.includes(proposal.recentIncidentState)) {
    blockedRules.push({
      ruleId: "incident.approval_required_states",
      category: "incident",
      effect: "require_approval",
      actual: proposal.recentIncidentState,
      threshold: [...policy.incidents.approvalRequiredStates],
      message: `Recent incident state ${proposal.recentIncidentState} requires manual approval.`,
    });
  }

  const decision: ReallocationPolicyDecision = blockedRules.some((rule) => rule.effect === "reject")
    ? "rejected"
    : blockedRules.length
      ? "approval_required"
      : "auto_approved";

  return { decision, proposalId: proposal.id, blockedRules };
}

function isValidApproval(approval: ManualReallocationApproval | undefined): approval is ManualReallocationApproval {
  return Boolean(
    approval &&
      typeof approval.approvedBy === "string" &&
      approval.approvedBy.trim() &&
      typeof approval.approvedAt === "string" &&
      Number.isFinite(Date.parse(approval.approvedAt)),
  );
}

/**
 * Enforced execution boundary. Rejected proposals never reach the executor;
 * approval-required proposals reach it only with an attributable approval.
 */
export async function executeTreasuryReallocation<T>(
  proposal: TreasuryReallocationProposal,
  executor: (approvedProposal: TreasuryReallocationProposal) => Promise<T>,
  options: {
    policy?: TreasuryReallocationPolicy;
    manualApproval?: ManualReallocationApproval;
  } = {},
): Promise<ReallocationExecutionResponse<T>> {
  const evaluation = evaluateTreasuryReallocation(proposal, options.policy);

  if (evaluation.decision === "rejected") {
    return { status: "rejected", evaluation };
  }
  if (evaluation.decision === "approval_required" && !isValidApproval(options.manualApproval)) {
    return { status: "approval_required", evaluation };
  }

  const executionResult = await executor(proposal);
  return {
    status: "executed",
    approvalMode: evaluation.decision === "auto_approved" ? "automatic" : "manual",
    evaluation,
    executionResult,
  };
}
