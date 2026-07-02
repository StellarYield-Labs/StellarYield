import { traverseFallbackTree, type FallbackNode, type TraversalContext, type HealthCheck, type BlocklistCheck, type TraversalStep } from '../fallbackTreeService';

describe('fallbackTree unsafe/boundary traversal (persistence/replay-aligned)', () => {
  const nowIso = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const makeContext = (args: {
    health: Record<string, HealthCheck>;
    blocklist?: Record<string, BlocklistCheck>;
    minHealthScore?: number;
    allowDegraded?: boolean;
    maxDepth?: number;
  }): TraversalContext => {
    const {
      health,
      blocklist = {},
      minHealthScore = 50,
      allowDegraded = true,
      maxDepth = 3,
    } = args;

    return {
      checkHealth: (id) => health[id],
      checkBlocklist: (id) =>
        blocklist[id] ?? { isBlocked: false, checkedAt: nowIso },
      minHealthScore,
      allowDegraded,
      maxDepth,
      now: Date.parse(nowIso),
    };
  };

  const node = (id: string, fallbacks: FallbackNode[] = [], name?: string): FallbackNode => ({
    id,
    name: name ?? id,
    fallbacks,
  });

  it('rejects cyclic trees (terminalFailure true) - runtime cycle prevention + invalid-tree guard', async () => {
    const a: FallbackNode = node('a');
    const b: FallbackNode = node('b', [a]);
    // Create cycle: a -> b
    a.fallbacks = [b];

    const tree: FallbackNode = a;

    const health: Record<string, HealthCheck> = {
      a: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      b: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
    };

    const context = makeContext({ health, maxDepth: 10 });
    const result = await traverseFallbackTree(tree, context);

    expect(result.terminalFailure).toBe(true);
    expect(result.terminalFailureReason).toContain('Invalid tree structure');
  });

  it('depth exceeded returns terminalFailure and does not select deeper valid node', async () => {
    const tree: FallbackNode = node('level0', [
      node('level1', [
        node('level2', [
          node('level3', []),
        ]),
      ]),
    ]);

    const health: Record<string, HealthCheck> = {
      level0: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      level1: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      level2: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      level3: { status: 'healthy', score: 90, checkedAt: nowIso, reasons: [] },
    };

    const context = makeContext({ health, maxDepth: 2 });
    const result = await traverseFallbackTree(tree, context);

    expect(result.terminalFailure).toBe(true);
    expect(result.selectedNode).toBeNull();
    // Ensure level3 was evaluated only as a max-depth violation step (not selected)
    const level3 = result.path.find((s) => s.nodeId === 'level3');
    expect(level3).toBeDefined();
    expect(level3!.selected).toBe(false);
    expect(level3!.reason).toContain('Max depth');
  });

  it('all-blocked returns terminalFailure and never selects blocked nodes', async () => {
    const tree: FallbackNode = node('root', [node('c1'), node('c2')]);

    const health: Record<string, HealthCheck> = {
      root: { status: 'healthy', score: 90, checkedAt: nowIso, reasons: [] },
      c1: { status: 'healthy', score: 90, checkedAt: nowIso, reasons: [] },
      c2: { status: 'healthy', score: 90, checkedAt: nowIso, reasons: [] },
    };

    const blocklist: Record<string, BlocklistCheck> = {
      root: { isBlocked: true, reason: 'blocked', checkedAt: nowIso },
      c1: { isBlocked: true, reason: 'blocked', checkedAt: nowIso },
      c2: { isBlocked: true, reason: 'blocked', checkedAt: nowIso },
    };

    const context = makeContext({ health, blocklist, maxDepth: 5 });
    const result = await traverseFallbackTree(tree, context);

    expect(result.terminalFailure).toBe(true);
    expect(result.selectedNode).toBeNull();
    expect(result.path.some((s) => s.nodeId === 'root' && s.selected)).toBe(false);
  });

  it('stale-health is modeled as status critical/unknown (viability must reject)', async () => {
    const tree: FallbackNode = node('primary', [node('stale'), node('fresh')]);

    const health: Record<string, HealthCheck> = {
      primary: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      stale: { status: 'critical', score: 10, checkedAt: nowIso, reasons: ['stale'] },
      fresh: { status: 'healthy', score: 90, checkedAt: nowIso, reasons: [] },
    };

    const context = makeContext({ health, maxDepth: 5, minHealthScore: 50 });
    const result = await traverseFallbackTree(tree, context);

    expect(result.selectedNode?.id).toBe('fresh');
    const staleStep = result.path.find((s) => s.nodeId === 'stale');
    expect(staleStep?.selected).toBe(false);
  });

  it('deterministic replay: same inputs -> same selected path order', async () => {
    const tree: FallbackNode = node('a', [node('b', [node('c')]), node('d')]);

    const health: Record<string, HealthCheck> = {
      a: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      b: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
      c: { status: 'healthy', score: 90, checkedAt: nowIso, reasons: [] },
      d: { status: 'critical', score: 0, checkedAt: nowIso, reasons: [] },
    };

    const context = makeContext({ health, maxDepth: 5 });
    const first = await traverseFallbackTree(tree, context);
    const second = await traverseFallbackTree(tree, context);

    const firstIds = first.path.map((s) => s.nodeId + ':' + String(s.selected));
    const secondIds = second.path.map((s) => s.nodeId + ':' + String(s.selected));

    expect(first.selectedNode?.id).toBe(second.selectedNode?.id);
    expect(firstIds.join('|')).toBe(secondIds.join('|'));
  });
});

