import type {
  FallbackNode,
  HealthCheck,
  BlocklistCheck,
  TraversalContext,
  TraversalResult,
  TraversalStep,
} from "./fallbackTreeService";
import { validateFallbackTree } from "./fallbackTreeService";
import { fallbackTreeAuditEventKey } from "../utils/fallbackTraversalDeterminism";

// NOTE: This service is responsible for shaping audit payloads.
// Persistence is handled by repositories.

export interface FallbackTraversalAuditPayload {
  treeKey: string;
  treeVersion: number;
  traversalKey: string;

  // Inputs to enable deterministic replay
  rootId: string;
  minHealthScore: number;
  allowDegraded: boolean;
  maxDepth: number;
  nowIso: string;

  // Per-node inputs/output snapshots
  healthInputs: Array<{
    nodeId: string;
    health: HealthCheck;
    timestamp: string;
  }>;
  blocklistInputs: Array<{
    nodeId: string;
    blocklist: BlocklistCheck;
    timestamp: string;
  }>;
  oracleInputs?: unknown;

  // Decision
  selectedNodeId: string | null;
  terminalFailure: boolean;
  terminalFailureReason?: string | null;
  nodesEvaluated: number;
  maxDepthReached: number;
  completedAtIso: string;

  selectedPath: TraversalStep[];
  rejectedCandidates: Array<{ nodeId: string; reason: string }>;
  finalDecision: {
    selectedNodeId: string | null;
  };

  // Optional protocol failover linkage
  failoverContext?: unknown;
}

export function buildFallbackTraversalAuditPayload(params: {
  treeKey: string;
  treeVersion: number;
  root: FallbackNode;
  context: TraversalContext;
  contextNowIso: string;
  traversalKeySeed: string;
  result: TraversalResult;
  // These are the deterministic snapshots collected during traversal.
  healthInputs: Array<{
    nodeId: string;
    health: HealthCheck;
    timestamp: string;
  }>;
  blocklistInputs: Array<{
    nodeId: string;
    blocklist: BlocklistCheck;
    timestamp: string;
  }>;
  oracleInputs?: unknown;
  rejectedCandidates: Array<{ nodeId: string; reason: string }>;
  failoverContext?: unknown;
}): FallbackTraversalAuditPayload {
  // Validate before producing audit payload
  const validation = validateFallbackTree(params.root);
  if (!validation.valid) {
    throw new Error(`Invalid fallback tree: ${validation.errors.join(", ")}`);
  }

  const traversalKey = fallbackTreeAuditEventKey({
    treeKey: params.treeKey,
    treeVersion: params.treeVersion,
    rootId: params.root.id,
    seed: params.traversalKeySeed,
  });

  return {
    treeKey: params.treeKey,
    treeVersion: params.treeVersion,
    traversalKey,

    rootId: params.root.id,
    minHealthScore: params.context.minHealthScore,
    allowDegraded: params.context.allowDegraded,
    maxDepth: params.context.maxDepth,
    nowIso: params.contextNowIso,

    healthInputs: params.healthInputs,
    blocklistInputs: params.blocklistInputs,
    oracleInputs: params.oracleInputs,

    selectedNodeId: params.result.selectedNode?.id ?? null,
    terminalFailure: params.result.terminalFailure,
    terminalFailureReason: params.result.terminalFailureReason ?? null,
    nodesEvaluated: params.result.nodesEvaluated,
    maxDepthReached: params.result.maxDepthReached,
    completedAtIso: params.result.completedAt,

    selectedPath: params.result.path,
    rejectedCandidates: params.rejectedCandidates,
    finalDecision: { selectedNodeId: params.result.selectedNode?.id ?? null },

    failoverContext: params.failoverContext,
  };
}
