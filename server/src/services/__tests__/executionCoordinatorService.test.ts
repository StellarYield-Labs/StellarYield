import {
  DuplicateInboxMessageError,
  EXECUTION_STATES,
  ExecutionCoordinatorService,
  InMemoryExecutionCoordinatorRepository,
  InvalidExecutionTransitionError,
  StaleLeaseError,
} from '../executionCoordinatorService';

describe('ExecutionCoordinatorService', () => {
  let nowMs: number;
  let repo: InMemoryExecutionCoordinatorRepository;
  let service: ExecutionCoordinatorService;

  beforeEach(() => {
    nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    repo = new InMemoryExecutionCoordinatorRepository();
    service = new ExecutionCoordinatorService(repo, () => new Date(nowMs));
  });

  async function createAndLease(intentId = 'intent-1') {
    await service.createExecution({
      intentId,
      vaultId: 'vault-1',
      operation: 'rebalance',
      payload: { target: { USDC: 100 } },
    });
    return service.acquireLease(intentId, 'worker-a', 30_000);
  }

  it('increments fencing tokens and rejects stale worker updates', async () => {
    const firstLease = await createAndLease();
    nowMs += 31_000;
    const secondLease = await service.acquireLease('intent-1', 'worker-b', 30_000);

    await expect(
      service.transition('intent-1', firstLease.fencingToken, EXECUTION_STATES.BUILT),
    ).rejects.toBeInstanceOf(StaleLeaseError);

    const updated = await service.transition(
      'intent-1',
      secondLease.fencingToken,
      EXECUTION_STATES.BUILT,
      { unsignedXdr: 'AAAA' },
    );

    expect(updated.state).toBe(EXECUTION_STATES.BUILT);
    expect(updated.fencingToken).toBe(2n);
    expect(updated.unsignedXdr).toBe('AAAA');
  });

  it('deduplicates consumed queue messages with an inbox record', async () => {
    await service.recordInbox('message-1', 'rebalance-worker', 'intent-1');

    await expect(
      service.recordInbox('message-1', 'rebalance-worker', 'intent-1'),
    ).rejects.toBeInstanceOf(DuplicateInboxMessageError);

    await expect(
      service.recordInbox('message-1', 'different-worker', 'intent-1'),
    ).resolves.toBeUndefined();
  });

  it('prevents two live intents from reserving the same Stellar sequence', async () => {
    const firstLease = await createAndLease('intent-1');
    await service.reserveSequence('intent-1', firstLease.fencingToken, 'GKEEPER', 42n, 60_000);

    const secondLease = await createAndLease('intent-2');

    await expect(
      service.reserveSequence('intent-2', secondLease.fencingToken, 'GKEEPER', 42n, 60_000),
    ).rejects.toThrow(/reserved by intent-1/);
  });

  it('records submission, reconciliation, and confirmation under the current lease', async () => {
    const lease = await createAndLease();
    await service.transition('intent-1', lease.fencingToken, EXECUTION_STATES.BUILT, {
      unsignedXdr: 'unsigned-xdr',
    });
    await service.transition('intent-1', lease.fencingToken, EXECUTION_STATES.SIMULATED, {
      simulatedXdr: 'simulated-xdr',
      validUntilLedger: 123n,
    });
    await service.transition('intent-1', lease.fencingToken, EXECUTION_STATES.SIGNED, {
      signedEnvelopeHash: 'signed-hash',
    });
    await service.reserveSequence('intent-1', lease.fencingToken, 'GKEEPER', 43n, 60_000);

    const submitted = await service.recordSubmission(
      'intent-1',
      lease.fencingToken,
      'tx-hash',
      'PENDING',
    );
    expect(submitted.state).toBe(EXECUTION_STATES.SUBMITTED);
    expect(submitted.submissionHash).toBe('tx-hash');

    const reconciling = await service.markReconciling('intent-1', lease.fencingToken, 'NOT_FOUND');
    expect(reconciling.state).toBe(EXECUTION_STATES.RECONCILING);
    expect(reconciling.retryClass).toBe('transport');

    const confirmed = await service.confirm('intent-1', lease.fencingToken, 'result-xdr');
    expect(confirmed.state).toBe(EXECUTION_STATES.CONFIRMED);
    expect(confirmed.resultXdr).toBe('result-xdr');
    expect(await repo.getSequenceReservation('GKEEPER', 43n)).toBeNull();
  });

  it('rejects invalid state transitions', async () => {
    const lease = await createAndLease();

    await expect(
      service.transition('intent-1', lease.fencingToken, EXECUTION_STATES.CONFIRMED),
    ).rejects.toBeInstanceOf(InvalidExecutionTransitionError);
  });
});
