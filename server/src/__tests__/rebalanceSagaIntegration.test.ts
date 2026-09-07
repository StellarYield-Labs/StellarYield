import {
  InMemoryRebalanceSagaRepository,
  REBALANCE_SAGA_PHASES,
  RebalanceSagaService,
  SagaConcurrencyError,
  StaleFencingTokenError,
} from '../services/rebalanceSagaService';
import { MockExecutionAdapter } from '../services/rebalanceExecutionAdapter';

/**
 * Integration tests for the idempotent rebalance execution saga (Issue #184).
 *
 * These exercise the durable saga state machine together with a real
 * MockExecutionAdapter and mirror the orchestration performed by
 * processQueueEntryWithSaga in rebalanceQueueProcessorJob.ts. The focus is the
 * exactly-once / recovery / concurrency contract, not the Prisma layer.
 */
describe('Rebalance Execution Saga Integration', () => {
  let sagaService: RebalanceSagaService;
  let adapter: MockExecutionAdapter;
  let repo: InMemoryRebalanceSagaRepository;
  let nowMs: number;

  const QUEUE_ID = 'queue-1';
  const VAULT_ID = 'vault-1';
  const INTENT_HASH = 'intent-abc';
  const WORKER_A = 'worker-a';
  const WORKER_B = 'worker-b';

  function request() {
    return {
      queueEntryId: QUEUE_ID,
      vaultId: VAULT_ID,
      vaultContractId: VAULT_ID,
      targetAllocations: { BTC: 0.4, ETH: 0.3, USDC: 0.3 },
      currentAllocations: { BTC: 0.5, ETH: 0.2, USDC: 0.3 },
      executionStrategy: {},
      intentHash: INTENT_HASH,
      adminAddress: 'admin',
    };
  }

  beforeEach(() => {
    nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    repo = new InMemoryRebalanceSagaRepository();
    sagaService = new RebalanceSagaService(repo, () => new Date(nowMs));
    adapter = new MockExecutionAdapter();
  });

  /**
   * Mirrors the early part of processQueueEntryWithSaga: create the saga,
   * acquire a lease, run simulation.
   */
  async function prepareSaga(worker = WORKER_A) {
    await sagaService.startOrCreate({
      queueEntryId: QUEUE_ID,
      vaultId: VAULT_ID,
      intentHash: INTENT_HASH,
      jobId: worker,
    });
    const lease = await sagaService.acquireLease(QUEUE_ID, worker, 60_000);
    return lease.fencingToken;
  }

  it('completes a full rebalance end-to-end without duplicate on-chain actions', async () => {
    const token = await prepareSaga();
    const req = request();

    const sim = await adapter.simulate(req);
    expect(sim.success).toBe(true);

    await sagaService.recordSimulation(QUEUE_ID, WORKER_A, token, `sim:${QUEUE_ID}`, sim.metadata ?? {});

    const begun = await sagaService.beginSubmission(QUEUE_ID, WORKER_A, token, `submit:${INTENT_HASH}`);
    expect(begun.recorded).toBe(true);

    const submitted = await adapter.submit(req);
    expect(submitted.success).toBe(true);
    expect(submitted.status).toBe('confirmed');

    await sagaService.recordSubmission(
      QUEUE_ID,
      WORKER_A,
      token,
      `submit:${INTENT_HASH}`,
      submitted.transactionHash ?? '',
      submitted.metadata ?? {},
      submitted.ledger !== undefined ? BigInt(submitted.ledger) : undefined,
    );
    await sagaService.recordConfirmation(
      QUEUE_ID,
      WORKER_A,
      token,
      `confirm:${QUEUE_ID}`,
      { confirmed: true },
      submitted.transactionHash,
    );
    await sagaService.recordSnapshot(QUEUE_ID, WORKER_A, token, `snap:${QUEUE_ID}`, { taken: true });
    await sagaService.markCompleted(QUEUE_ID, WORKER_A, token);

    const saga = await sagaService.getSaga(QUEUE_ID);
    expect(saga?.phase).toBe(REBALANCE_SAGA_PHASES.COMPLETED);
    expect(await sagaService.hasOnChainAction(QUEUE_ID)).toBe(true);
  });

  it('resumes a simulated timeout from the correct checkpoint without resubmitting', async () => {
    const token = await prepareSaga();

    // Worker crashes AFTER the durable reservation, BEFORE recording the result.
    await sagaService.beginSubmission(QUEUE_ID, WORKER_A, token, `submit:${INTENT_HASH}`);

    expect(await sagaService.hasOnChainAction(QUEUE_ID)).toBe(true);
    const dangling = await sagaService.submissionStatus(QUEUE_ID);
    expect(dangling?.submissionInFlight).toBe(true);
    expect(dangling?.confirmation).toBeNull();

    // Because the reservation is present, the orchestration never resubmits;
    // instead it escalates to manual review.
    expect(await sagaService.hasOnChainAction(QUEUE_ID)).toBe(true);

    const reviewed = await sagaService.requireManualReview(
      QUEUE_ID,
      WORKER_A,
      token,
      'Relayer timed out; on-chain outcome must be reconciled before continuing',
    );
    expect(reviewed.phase).toBe(REBALANCE_SAGA_PHASES.REQUIRES_MANUAL_REVIEW);
    expect(reviewed.requiresRecovery).toBe(true);
  });

  it('does not let a second worker process the same job concurrently', async () => {
    await prepareSaga(WORKER_A);
    await expect(
      sagaService.acquireLease(QUEUE_ID, WORKER_B, 60_000),
    ).rejects.toBeInstanceOf(SagaConcurrencyError);
  });

  it('rejects a stale worker write after a lease takeover (fencing token)', async () => {
    await prepareSaga(WORKER_A);
    const tokenA = (await sagaService.getSaga(QUEUE_ID))?.fencingToken ?? '';
    nowMs += 61_000;
    await sagaService.acquireLease(QUEUE_ID, WORKER_B, 60_000);

    await expect(
      sagaService.recordSimulation(QUEUE_ID, WORKER_A, tokenA, 'sim-k', { simulated: true }),
    ).rejects.toBeInstanceOf(StaleFencingTokenError);
  });

  it('records a failed transaction reason so it never silently disappears', async () => {
    const token = await prepareSaga();
    const req = request();
    adapter.configureSubmitFailure(1, 'transient');

    const sim = await adapter.simulate(req);
    expect(sim.success).toBe(true);
    await sagaService.beginSubmission(QUEUE_ID, WORKER_A, token, `submit:${INTENT_HASH}`);
    const failed = await adapter.submit(req);
    expect(failed.success).toBe(false);

    const outcome = await sagaService.recordFailure(
      QUEUE_ID,
      WORKER_A,
      token,
      REBALANCE_SAGA_PHASES.SUBMITTED,
      failed.error ?? 'Submission failed',
      failed.errorClass ?? 'transient',
      failed.metadata,
    );
    expect(outcome.saga.lastError).toContain('relayer unavailable');
    expect(outcome.saga.lastErrorClass).toBe('transient');
    expect(outcome.saga.submissionInFlight).toBe(true);

    expect(await sagaService.hasOnChainAction(QUEUE_ID)).toBe(true);
    adapter.reset();
  });
});