import {
  InMemoryRebalanceSagaRepository,
  InvalidSagaTransitionError,
  REBALANCE_SAGA_PHASES,
  RebalanceSagaService,
  SagaAlreadyTerminatedError,
  SagaConcurrencyError,
  StaleFencingTokenError,
} from "../rebalanceSagaService";

describe("RebalanceSagaService", () => {
  let nowMs: number;
  let repo: InMemoryRebalanceSagaRepository;
  let service: RebalanceSagaService;

  const Q = "queue-1";
  const V = "vault-1";
  const INTENT = "intent-abc";

  beforeEach(() => {
    nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    repo = new InMemoryRebalanceSagaRepository();
    service = new RebalanceSagaService(repo, () => new Date(nowMs));
  });

  async function start(worker = "worker-a") {
    await service.startOrCreate({ queueEntryId: Q, vaultId: V, intentHash: INTENT, jobId: worker });
  }

  async function acquireToken(worker = "worker-a") {
    const handle = await service.acquireLease(Q, worker, 60_000);
    return handle.fencingToken;
  }

  async function driveSuccess(worker = "worker-a"): Promise<void> {
    await start(worker);
    const token = await acquireToken(worker);
    await service.recordQuote(Q, worker, token, "quote-k", { quoteId: "q1" });
    await service.recordApproval(Q, worker, token, "approve-k", { approved: true });
    await service.recordSimulation(Q, worker, token, "sim-k", { simulated: true });
    await service.beginSubmission(Q, worker, token, "submit-k");
    await service.recordSubmission(Q, worker, token, "submit-k", "0xabc", { ok: true }, 99n);
    await service.recordConfirmation(Q, worker, token, "confirm-k", { confirmed: true }, "0xabc");
    await service.recordSnapshot(Q, worker, token, "snap-k", { taken: true });
    await service.markCompleted(Q, worker, token);
  }

  describe("success flow", () => {
    it("runs through every phase to a terminal COMPLETED state", async () => {
      await driveSuccess();

      const saga = await service.getSaga(Q);
      expect(saga?.phase).toBe(REBALANCE_SAGA_PHASES.COMPLETED);
      expect(saga?.transactionHash).toBe("0xabc");
      expect(saga?.snapshotResult).toEqual({ taken: true });
      expect(saga?.completedAt).not.toBeNull();
      expect(await service.hasOnChainAction(Q)).toBe(true);
    });
  });

  describe("idempotency and duplicate prevention", () => {
    it("does not record the same phase twice", async () => {
      await start();
      const token = await acquireToken();
      const first = await service.recordSimulation(Q, "worker-a", token, "sim-k", { simulated: true });
      expect(first.recorded).toBe(true);
      const second = await service.recordSimulation(Q, "worker-a", token, "sim-k", { simulated: true });
      expect(second.recorded).toBe(false);
    });

    it("refuses a second submission reservation for the same intent", async () => {
      await start();
      const token = await acquireToken();
      const first = await service.beginSubmission(Q, "worker-a", token, "submit-k");
      expect(first.recorded).toBe(true);
      const second = await service.beginSubmission(Q, "worker-a", token, "submit-k");
      expect(second.recorded).toBe(false);
    });

    it("treats a durable submission reservation as an on-chain action", async () => {
      await start();
      const token = await acquireToken();
      // Crash AFTER the durable reservation was written, BEFORE the on-chain result.
      await service.beginSubmission(Q, "worker-a", token, "submit-k");

      expect(await service.hasOnChainAction(Q)).toBe(true);
      const status = await service.submissionStatus(Q);
      expect(status?.submissionInFlight).toBe(true);
      expect(status?.confirmation).toBeNull();
    });
  });

  describe("timeout recovery and manual review", () => {
    it("escalates an unconfirmed in-flight submission to requires_manual_review", async () => {
      await start();
      const token = await acquireToken();
      await service.beginSubmission(Q, "worker-a", token, "submit-k");

      const reviewed = await service.requireManualReview(
        Q,
        "worker-a",
        token,
        "Relayer timed out; cannot confirm on-chain outcome",
      );
      expect(reviewed.phase).toBe(REBALANCE_SAGA_PHASES.REQUIRES_MANUAL_REVIEW);
      expect(reviewed.requiresRecovery).toBe(true);
      await expect(
        service.acquireLease(Q, "worker-b", 10_000),
      ).rejects.toBeInstanceOf(SagaAlreadyTerminatedError);
    });
  });

  describe("failure accounting and retry", () => {
    it("keeps a transient failure non-terminal and schedules a retry", async () => {
      await start();
      const token = await acquireToken();
      const outcome = await service.recordFailure(
        Q,
        "worker-a",
        token,
        REBALANCE_SAGA_PHASES.PENDING,
        "relayer unavailable",
        "transient",
      );
      expect(outcome.terminal).toBe(false);
      expect(outcome.shouldRetry).toBe(true);
      expect(outcome.retryAt).not.toBeNull();
      expect((await service.getSaga(Q))?.attemptCount).toBe(1);
      expect((await service.getSaga(Q))?.lastErrorClass).toBe("transient");
    });

    it("records a terminal error and does not silently disappear", async () => {
      await start();
      const token = await acquireToken();
      const outcome = await service.recordFailure(
        Q,
        "worker-a",
        token,
        REBALANCE_SAGA_PHASES.PENDING,
        "insufficient liquidity",
        "terminal",
      );
      expect(outcome.terminal).toBe(true);
      const saga = await service.getSaga(Q);
      expect(saga?.phase).toBe(REBALANCE_SAGA_PHASES.FAILED);
      expect(saga?.lastError).toContain("insufficient liquidity");
      expect(saga?.completedAt).not.toBeNull();
    });
  });

  describe("concurrency", () => {
    it("rejects a second worker while a live lease is held", async () => {
      await start();
      await service.acquireLease(Q, "worker-a", 60_000);
      await expect(
        service.acquireLease(Q, "worker-b", 60_000),
      ).rejects.toBeInstanceOf(SagaConcurrencyError);
    });

    it("rejects a stale worker after a lease takeover via fencing token", async () => {
      await start();
      const first = await service.acquireLease(Q, "worker-a", 60_000);
      nowMs += 61_000;
      await service.acquireLease(Q, "worker-b", 60_000);

      await expect(
        service.recordSimulation(Q, "worker-a", first.fencingToken, "sim-k", { simulated: true }),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);

      const tokenB = (await service.getSaga(Q))?.fencingToken ?? "";
      const ok = await service.recordSimulation(Q, "worker-b", tokenB, "sim-k", { simulated: true });
      expect(ok.recorded).toBe(true);
    });
  });

  describe("cancel and invalid transitions", () => {
    it("cancels a saga into a terminal CANCELLED state", async () => {
      await start();
      const token = await acquireToken();
      const cancelled = await service.cancel(Q, "worker-a", token, "operator cancelled");
      expect(cancelled.phase).toBe(REBALANCE_SAGA_PHASES.CANCELLED);
      await expect(
        service.acquireLease(Q, "worker-b", 10_000),
      ).rejects.toBeInstanceOf(SagaAlreadyTerminatedError);
    });

    it("rejects an invalid phase transition", async () => {
      await start();
      const token = await acquireToken();
      await expect(
        service.recordConfirmation(Q, "worker-a", token, "confirm-k", { confirmed: true }),
      ).rejects.toBeInstanceOf(InvalidSagaTransitionError);
    });
  });
});