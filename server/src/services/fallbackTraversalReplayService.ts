import type {
  FallbackNode,
  TraversalContext,
  TraversalResult,
  TraversalStep,
} from "./fallbackTreeService";
import { traverseFallbackTree } from "./fallbackTreeService";

export interface ReplayMismatch {
  selectedPathChanged: boolean;
  selectedNodeIdBefore: string | null;
  selectedNodeIdAfter: string | null;
  beforeSteps?: TraversalStep[];
  afterSteps?: TraversalStep[];
}

export async function replayFallbackTraversal(params: {
  root: FallbackNode;
  context: TraversalContext;
  expected: {
    selectedNodeId: string | null;
    path: TraversalStep[];
    terminalFailure: boolean;
    terminalFailureReason?: string | null;
  };
}): Promise<{ result: TraversalResult; mismatch: ReplayMismatch | null }> {
  const result = await traverseFallbackTree(params.root, params.context);

  const selectedNodeIdAfter = result.selectedNode?.id ?? null;
  const selectedNodeIdBefore = params.expected.selectedNodeId;

  const beforePathIds = params.expected.path.map((s) => s.nodeId);
  const afterPathIds = result.path.map((s) => s.nodeId);

  const selectedPathChanged =
    selectedNodeIdBefore !== selectedNodeIdAfter ||
    beforePathIds.join("|") !== afterPathIds.join("|");

  if (!selectedPathChanged) return { result, mismatch: null };

  return {
    result,
    mismatch: {
      selectedPathChanged: true,
      selectedNodeIdBefore,
      selectedNodeIdAfter,
      beforeSteps: params.expected.path,
      afterSteps: result.path,
    },
  };
}
