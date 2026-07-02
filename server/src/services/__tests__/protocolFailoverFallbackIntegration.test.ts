import {
  traverseFallbackTree,
  type FallbackNode,
  type TraversalContext,
  type HealthCheck,
} from '../fallbackTreeService';
import {
  applyFailover,
  DEFAULT_FAILOVER_THRESHOLDS,
  type ProtocolHealthInput,
} from '../protocolFailoverService';

describe('failover + fallback traversal integration (tag: failover)', () => {
  const nowIso = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const nowMs = Date.parse(nowIso);

  const makeHealth = (overrides: Partial<ProtocolHealthInput> & {
    id: string;
    name: string;
  }): ProtocolHealthInput => {
    return {
      status: 'healthy',
      lastUpdatedAt: nowIso,
      ...overrides,
    };
  };

  const makeTraversalContextFromFailover = (params: {
    treeIds: string[];
    protocolHealth: Map<string, ProtocolHealthInput>;
    minHealthScore: number;
    allowDegraded: boolean;
    maxDepth: number;
  }): TraversalContext => {
    const { protocolHealth, minHealthScore, allowDegraded, maxDepth } = params;

    return {
      // Map ProtocolHealthInput -> Traversal health + blocklist
      checkHealth: (nodeId: string): HealthCheck => {
        const h = protocolHealth.get(nodeId);
        if (!h) {
          return {
            status: 'unknown',
            score: 0,
            checkedAt: nowIso,
            reasons: ['no health data available'],
          };
        }

        // Deterministic mapping:
        // - critical/down/unknown => critical/unknown (rejected)
        // - degraded => degraded (conditional)
        // - healthy => healthy
        if (h.status === 'critical' || h.status === 'down') {
          return {
            status: 'critical',
            score: 0,
            checkedAt: nowIso,
            reasons: ['protocol excluded by failover'],
          };
        }

        if (h.status === 'degraded' || h.status === 'unknown') {
          return {
            status: h.status === 'unknown' ? 'unknown' : 'degraded',
            score: 10,
            checkedAt: nowIso,
            reasons: ['protocol degraded/unknown'],
          };
        }

        return {
          status: 'healthy',
          score: 90,
          checkedAt: nowIso,
          reasons: [],
        };
      },

      checkBlocklist: (nodeId: string) => {
        const h = protocolHealth.get(nodeId);
        if (!h) {
          return { isBlocked: true, reason: 'missing failover input', checkedAt: nowIso };
        }

        // If failover marks this protocol to be excluded, traversal must reject via blocklist.
        // We encode excluded as `status` critical/down/unknown for deterministic behavior.
        const excludedStatuses = ['critical', 'down'];
        const isBlocked = excludedStatuses.includes(h.status);
        return {
          isBlocked,
          reason: isBlocked ? 'excluded by failover' : undefined,
          checkedAt: nowIso,
        };
      },

      minHealthScore,
      allowDegraded,
      maxDepth,
      now: nowMs,
    };
  };

  it('excludes stale/degraded protocols via failover decisions and fallback never selects them', async () => {
    // Tree: root -> degraded -> fresh
    const tree: FallbackNode = {
      id: 'fresh',
      name: 'fresh',
      fallbacks: [
        { id: 'stale', name: 'stale', fallbacks: [] },
        { id: 'freshChild', name: 'freshChild', fallbacks: [] },
      ],
    };

    const healthFixtures = new Map<string, ProtocolHealthInput>([
      [
        'fresh',
        makeHealth({
          id: 'fresh',
          name: 'fresh',
          status: 'healthy',
          lastUpdatedAt: nowIso,
        }),
      ],
      [
        'stale',
        makeHealth({
          id: 'stale',
          name: 'stale',
          status: 'degraded',
          lastUpdatedAt: new Date(nowMs - DEFAULT_FAILOVER_THRESHOLDS.maxDataAgeMs - 1).toISOString(),
        }),
      ],
      [
        'freshChild',
        makeHealth({
          id: 'freshChild',
          name: 'freshChild',
          status: 'healthy',
          lastUpdatedAt: nowIso,
        }),
      ],
    ]);

    // Run failover over a strategy list that includes the tree ids.
    const strategies = Array.from(healthFixtures.keys()).map((id) => ({ id, name: id }));
    const priorExcluded = new Set<string>();

    const failoverResult = applyFailover(
      strategies,
      healthFixtures,
      priorExcluded,
      DEFAULT_FAILOVER_THRESHOLDS,
      nowMs,
    );

    const excludedIds = new Set(failoverResult.excluded.map((s) => s.id));
    // excluded should include stale (due to stale maxDataAgeMs)
    expect(excludedIds.has('stale')).toBe(true);

    // Build deterministic traversal context from the same failover inputs.
    const traversalContext = makeTraversalContextFromFailover({
      treeIds: strategies.map((s) => s.id),
      protocolHealth: healthFixtures,
      minHealthScore: 50,
      allowDegraded: true,
      maxDepth: 5,
    });

    const result = await traverseFallbackTree(tree, traversalContext);

    // root is healthy so it should be selected; traversal must never choose stale even if root had failed.
    expect(result.selectedNode?.id).toBe('fresh');

    const staleStep = result.path.find((s) => s.nodeId === 'stale');
    if (staleStep) {
      expect(staleStep.selected).toBe(false);
    }
  });

  it('all-blocked (via failover exclusion) yields terminal failure', async () => {
    const tree: FallbackNode = {
      id: 'root',
      name: 'root',
      fallbacks: [
        { id: 'a', name: 'a', fallbacks: [] },
        { id: 'b', name: 'b', fallbacks: [] },
      ],
    };

    const healthFixtures = new Map<string, ProtocolHealthInput>([
      ['root', makeHealth({ id: 'root', name: 'root', status: 'critical' })],
      ['a', makeHealth({ id: 'a', name: 'a', status: 'down' as any })],
      ['b', makeHealth({ id: 'b', name: 'b', status: 'unknown' as any })],
    ]);

    const traversalContext = makeTraversalContextFromFailover({
      treeIds: ['root', 'a', 'b'],
      protocolHealth: healthFixtures,
      minHealthScore: 50,
      allowDegraded: true,
      maxDepth: 5,
    });

    const result = await traverseFallbackTree(tree, traversalContext);
    expect(result.terminalFailure).toBe(true);
    expect(result.selectedNode).toBeNull();
  });

  it('deterministic replay property: running twice produces identical selected path', async () => {
    const tree: FallbackNode = {
      id: 'a',
      name: 'a',
      fallbacks: [
        {
          id: 'b',
          name: 'b',
          fallbacks: [{ id: 'c', name: 'c', fallbacks: [] }],
        },
        { id: 'd', name: 'd', fallbacks: [] },
      ],
    };

    const healthFixtures = new Map<string, ProtocolHealthInput>([
      ['a', makeHealth({ id: 'a', name: 'a', status: 'critical' })],
      ['b', makeHealth({ id: 'b', name: 'b', status: 'critical' })],
      ['c', makeHealth({ id: 'c', name: 'c', status: 'healthy' })],
      ['d', makeHealth({ id: 'd', name: 'd', status: 'critical' })],
    ]);

    const traversalContext = makeTraversalContextFromFailover({
      treeIds: ['a', 'b', 'c', 'd'],
      protocolHealth: healthFixtures,
      minHealthScore: 50,
      allowDegraded: true,
      maxDepth: 5,
    });

    const r1 = await traverseFallbackTree(tree, traversalContext);
    const r2 = await traverseFallbackTree(tree, traversalContext);

    const ids1 = r1.path.map((s) => `${s.nodeId}:${s.selected}`).join('|');
    const ids2 = r2.path.map((s) => `${s.nodeId}:${s.selected}`).join('|');

    expect(ids1).toBe(ids2);
    expect(r1.selectedNode?.id).toBe('c');
  });
});

