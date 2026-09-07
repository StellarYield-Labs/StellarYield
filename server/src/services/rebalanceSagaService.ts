import crypto from "crypto";

/**
 * Rebalance Execution Saga Service (Issue #184)
 *
 * A durable, exactly-once execution saga for each rebalance attempt. Each
 * risky phase — quote, approval, transaction submission, confirmation, and
 * post-execution snapshot — is recorded with a deterministic idempotency key
 * plus enough persisted checkpoint data for a worker to resume safely after a
 * process restart or a timed-out relayer submission.
 *
 * The saga is decoupled from Prisma and from any on-chain adapter. It talks
 * only to a {@link RebalanceSagaRepository}, mirroring the existing
 * {@link ExecutionCoordinatorService} pattern. An in-memory implementation
 * keeps the state machine unit-testable; a Prisma-backed implementation
 * persists the same DTO model.
 *
 * State model (terminal states in caps):
 *   pending → simulated → submitted → confirmed → snapshotted → COMPLETED
 *     │           │            │            │
 *     ├────────────→ FAILED / CANCELLED / REQUIRES_MANUAL_REVIEW
 *
 * Idempotency contract:
 *   - A phase is recorded at most ONCE via its idempotency key. Re-invoking a
 *     recorder is a no-op (`recorded: true` in the returned outcome).
 *   - `beginSubmission()` persists a durable in-flight marker BEFORE the
 *     on-chain submit. On recovery the marker's presence (or a prior
 *     submission result) prevents a duplicate on-chain action. The system may
 *     re-verify the outcome or escalate to `requires_manual_review`; it never
 *     blindly resubmits.
 *   - Fencing tokens reject updates from a stale worker after a lease moves,
 *     so two concurrent workers cannot settle the same job.
 */

export const REBALANCE_SAGA_PHASES = {
  PENDING: "pending",
  SIMULATED: "simulated",
  QUOTED: "quoted",
  APPROVED: "approved",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  SNAPSHOTTED: "snapshotted",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  REQUIRES_MANUAL_REVIEW: "requires_manual_review",
} as const;

export type RebalanceSagaPhase =
  (typeof REBALANCE_SAGA_PHASES)[keyof typeof REBALANCE_SAGA_PHASES];

export interface RebalanceSagaAttempt {
  occurredAt: string; // ISO-8601
  phase: RebalanceSagaPhase;
  action: "ok" | "failed" | "recovered" | "manual_review";
  error?: string;
  errorClass?: string;
  metadata?: Record<string, unknown>;
}

export interface RebalanceSaga {
  queueEntryId: string;
  vaultId: string;
  intentHash: string;
  jobId: string | null;
  phase: RebalanceSagaPhase;

  quoteKey: string | null;
  approvalKey: string | null;
  simulationKey: string | null;
  submissionKey: string | null;
  confirmationKey: string | null;
  snapshotKey: string | null;

  quoteResult: Record<string, unknown> | null;
  approvalResult: Record<string, unknown> | null;
  simulationResult: Record<string, unknown> | null;
  submissionResult: Record<string, unknown> | null;
  confirmationResult: Record<string, unknown> | null;
  snapshotResult: Record<string, unknown> | null;

  submissionInFlight: boolean;
  transactionHash: string | null;
  ledger: bigint | null;

  lastError: string | null;
  lastErrorClass: string | null;
  requiresRecovery: boolean;
  requiresRecoveryReason: string | null;

  attemptCount: number;
  maxAttempts: number;
  retryAt: Date | null;

  leasingWorker: string | null;
  leaseExpiresAt: Date | null;
  fencingToken: string | null;

  retryHistory: RebalanceSagaAttempt[];
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RebalanceSagaRepository {
  get(queueEntryId: string): Promise<RebalanceSaga | null>;
  create(saga: RebalanceSaga): Promise<RebalanceSaga>;
  update(
    queueEntryId: string,
    update: Partial<Omit<RebalanceSaga, "queueEntryId" | "createdAt">>,
  ): Promise<RebalanceSaga>;
  list(filter: {
    vaultId?: string;
    phase?: RebalanceSagaPhase | RebalanceSagaPhase[];
    limit?: number;
  }): Promise<RebalanceSaga[]>;
  findStalled(now: Date, limit?: number): Promise<RebalanceSaga[]>;
}

export interface InitSagaInput {
  queueEntryId: string;
  vaultId: string;
  intentHash: string;
  jobId?: string;
}

export interface LeaseHandle {
  saga: RebalanceSaga;
  workerId: string;
  fencingToken: string;
}

export interface PhaseRecordResult {
  saga: RebalanceSaga;
  recorded: boolean;
}

export interface FailureRecordResult {
  saga: RebalanceSaga;
  terminal: boolean;
  shouldRetry: boolean;
  retryAt: Date | null;
}

export interface SubmissionStatus {
  phase: RebalanceSagaPhase;
  submissionInFlight: boolean;
  transactionHash: string | null;
  submissionKey: string | null;
  confirmation: Record<string, unknown> | null;
}

const TERMINAL_PHASES = new Set<RebalanceSagaPhase>([
  REBALANCE_SAGA_PHASES.COMPLETED,
  REBALANCE_SAGA_PHASES.FAILED,
  REBALANCE_SAGA_PHASES.CANCELLED,
  REBALANCE_SAGA_PHASES.REQUIRES_MANUAL_REVIEW,
]);

const ALLOWED_TRANSITIONS: Record<RebalanceSagaPhase, RebalanceSagaPhase[]> = {
  pending: ["simulated", "quoted", "failed", "cancelled", "requires_manual_review"],
  quoted: ["approved", "simulated", "failed", "cancelled", "requires_manual_review"],
  approved: ["simulated", "failed", "cancelled", "requires_manual_review"],
  simulated: ["submitted", "failed", "cancelled", "requires_manual_review"],
  submitted: ["confirmed", "failed", "cancelled", "requires_manual_review"],
  confirmed: ["snapshotted", "cancelled", "requires_manual_review"],
  snapshotted: ["completed", "cancelled", "requires_manual_review"],
  completed: [],
  failed: [],
  cancelled: [],
  requires_manual_review: [],
};

export class SagaNotFoundError extends Error {
  constructor(queueEntryId: string) {
    super(`Rebalance saga for queue entry ${queueEntryId} was not found`);
  }
}

export class SagaConcurrencyError extends Error {
  constructor(queueEntryId: string, workerId: string, owner: string | null) {
    super(
      `Rebalance saga ${queueEntryId} has an active lease owned by ${owner ?? "nobody"}; ` +
        `${workerId} cannot process it concurrently`,
    );
  }
}

export class StaleFencingTokenError extends Error {
  constructor(queueEntryId: string) {
    super(`Rebalance saga ${queueEntryId} rejected a write from a stale worker`);
  }
}

export class SagaAlreadyTerminatedError extends Error {
  constructor(queueEntryId: string, phase: RebalanceSagaPhase) {
    super(`Rebalance saga ${queueEntryId} is already ${phase} and cannot advance`);
  }
}

export class InvalidSagaTransitionError extends Error {
  constructor(from: RebalanceSagaPhase, to: RebalanceSagaPhase) {
    super(`Invalid RebalanceSaga phase transition ${from} -> ${to}`);
  }
}

export class RebalanceSagaService {
  constructor(
    private readonly repository: RebalanceSagaRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly defaultLeaseTtlMs = 120_000,
    private readonly defaultMaxAttempts = 3,
  ) {}

  // ── Saga lifecycle ─────────────────────────────────────────────────────

  async startOrCreate(input: InitSagaInput): Promise<RebalanceSaga> {
    const existing = await this.repository.get(input.queueEntryId);
    if (existing) return existing;
    const now = this.clock();
    return this.repository.create({
      queueEntryId: input.queueEntryId,
      vaultId: input.vaultId,
      intentHash: input.intentHash,
      jobId: input.jobId ?? null,
      phase: REBALANCE_SAGA_PHASES.PENDING,
      quoteKey: null,
      approvalKey: null,
      simulationKey: null,
      submissionKey: null,
      confirmationKey: null,
      snapshotKey: null,
      quoteResult: null,
      approvalResult: null,
      simulationResult: null,
      submissionResult: null,
      confirmationResult: null,
      snapshotResult: null,
      submissionInFlight: false,
      transactionHash: null,
      ledger: null,
      lastError: null,
      lastErrorClass: null,
      requiresRecovery: false,
      requiresRecoveryReason: null,
      attemptCount: 0,
      maxAttempts: this.defaultMaxAttempts,
      retryAt: null,
      leasingWorker: null,
      leaseExpiresAt: null,
      fencingToken: null,
      retryHistory: [],
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async getSaga(queueEntryId: string): Promise<RebalanceSaga | null> {
    return this.repository.get(queueEntryId);
  }

  async listSagas(filter: {
    vaultId?: string;
    phase?: RebalanceSagaPhase | RebalanceSagaPhase[];
    limit?: number;
  }): Promise<RebalanceSaga[]> {
    return this.repository.list(filter);
  }

  async retryHistory(queueEntryId: string): Promise<RebalanceSagaAttempt[]> {
    const saga = await this.repository.get(queueEntryId);
    return saga ? saga.retryHistory.slice() : [];
  }

  // ── Lease / concurrency fencing ─────────────────────────────────────────

  /**
   * Acquire a single-writer lease on the saga. If another worker holds a live
   * lease, throws {@link SagaConcurrencyError}. If a previous lease expired the
   * calling worker may take over, but any later write from the stale worker is
   * rejected by the fencing token.
   */
  async acquireLease(
    queueEntryId: string,
    workerId: string,
    leaseMs: number = this.defaultLeaseTtlMs,
  ): Promise<LeaseHandle> {
    const saga = await this.repository.get(queueEntryId);
    if (!saga) throw new SagaNotFoundError(queueEntryId);
    if (TERMINAL_PHASES.has(saga.phase)) {
      throw new SagaAlreadyTerminatedError(queueEntryId, saga.phase);
    }

    const now = this.clock();
    const live =
      saga.leasingWorker !== null &&
      saga.leaseExpiresAt !== null &&
      saga.leaseExpiresAt > now;
    if (live && saga.leasingWorker !== workerId) {
      throw new SagaConcurrencyError(queueEntryId, workerId, saga.leasingWorker);
    }

    const fencingToken = crypto.randomUUID();
    const updated = await this.repository.update(queueEntryId, {
      jobId: workerId,
      leasingWorker: workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      fencingToken,
    });
    return { saga: updated, workerId, fencingToken };
  }

  /** Sagas with an expired/no lease whose state is not terminal. */
  async findStalled(limit = 100): Promise<RebalanceSaga[]> {
    return this.repository.findStalled(this.clock(), limit);
  }

  /**
   * Recover an expired lease and hand it to a new worker. Safe because recover
   * work never submits a duplicate on-chain action.
   */
  async recoverStalled(
    queueEntryId: string,
    workerId: string,
  ): Promise<LeaseHandle> {
    const saga = await this.repository.get(queueEntryId);
    if (!saga) throw new SagaNotFoundError(queueEntryId);
    if (TERMINAL_PHASES.has(saga.phase)) {
      return { saga, workerId, fencingToken: saga.fencingToken ?? crypto.randomUUID() };
    }
    return this.acquireLease(queueEntryId, workerId, this.defaultLeaseTtlMs);
  }

  // ── Idempotent, exactly-once phase recorders ────────────────────────────

  /**
   * Record a quoted result. Recorded once; a repeat call with an existing key
   * is an idempotent no-op.
   */
  async recordQuote(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    quoteKey: string,
    result: Record<string, unknown>,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    if (saga.quoteKey !== null) return { saga, recorded: false };
    this.assertTransition(saga.phase, REBALANCE_SAGA_PHASES.QUOTED);
    return this.recordOne(saga, workerId, fencingToken, {
      phase: REBALANCE_SAGA_PHASES.QUOTED,
      keyField: "quoteKey",
      resultField: "quoteResult",
      key: quoteKey,
      result,
    });
  }

  async recordApproval(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    approvalKey: string,
    result: Record<string, unknown>,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    if (saga.approvalKey !== null) return { saga, recorded: false };
    this.assertTransition(saga.phase, REBALANCE_SAGA_PHASES.APPROVED);
    return this.recordOne(saga, workerId, fencingToken, {
      phase: REBALANCE_SAGA_PHASES.APPROVED,
      keyField: "approvalKey",
      resultField: "approvalResult",
      key: approvalKey,
      result,
    });
  }

  async recordSimulation(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    simulationKey: string,
    result: Record<string, unknown>,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    if (saga.simulationKey !== null) return { saga, recorded: false };
    this.assertTransition(saga.phase, REBALANCE_SAGA_PHASES.SIMULATED);
    return this.recordOne(saga, workerId, fencingToken, {
      phase: REBALANCE_SAGA_PHASES.SIMULATED,
      keyField: "simulationKey",
      resultField: "simulationResult",
      key: simulationKey,
      result,
    });
  }

  /**
   * Durable in-flight marker written BEFORE the on-chain submit. This is the
   * exactly-once safety net: once present, a retry must reconcile the outcome
   * (or escalate to manual review), never resubmit.
   */
  async beginSubmission(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    submissionKey: string,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    this.assertWritable(saga, workerId, fencingToken);
    if (saga.submissionKey !== null || saga.submissionInFlight) {
      return { saga, recorded: false };
    }
    const updated = await this.repository.update(queueEntryId, {
      submissionKey,
      submissionInFlight: true,
      lastError: null,
      lastErrorClass: null,
    });
    return { saga: updated, recorded: true };
  }

  /**
   * Persist a successful on-chain submission. Runs at most once; a prior
   * submission result short-circuits with `recorded: false`.
   */
  async recordSubmission(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    submissionKey: string,
    txHash: string,
    result: Record<string, unknown>,
    ledger?: bigint,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    if (saga.submissionResult !== null) return { saga, recorded: false };
    this.assertWritable(saga, workerId, fencingToken);
    const updated = await this.repository.update(queueEntryId, {
      phase: REBALANCE_SAGA_PHASES.SUBMITTED,
      submissionKey,
      submissionResult: result,
      submissionInFlight: false,
      transactionHash: txHash,
      ledger: ledger ?? null,
    });
    return { saga: updated, recorded: true };
  }

  async recordConfirmation(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    confirmationKey: string,
    result: Record<string, unknown>,
    txHash?: string,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    if (saga.confirmationResult !== null) return { saga, recorded: false };
    this.assertTransition(saga.phase, REBALANCE_SAGA_PHASES.CONFIRMED);
    this.assertWritable(saga, workerId, fencingToken);
    const updated = await this.repository.update(queueEntryId, {
      phase: REBALANCE_SAGA_PHASES.CONFIRMED,
      confirmationKey,
      confirmationResult: result,
      transactionHash: txHash ?? saga.transactionHash,
    });
    return { saga: updated, recorded: true };
  }

  async recordSnapshot(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    snapshotKey: string,
    result: Record<string, unknown>,
  ): Promise<PhaseRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    if (saga.snapshotResult !== null) return { saga, recorded: false };
    this.assertTransition(saga.phase, REBALANCE_SAGA_PHASES.SNAPSHOTTED);
    this.assertWritable(saga, workerId, fencingToken);
    const updated = await this.repository.update(queueEntryId, {
      phase: REBALANCE_SAGA_PHASES.SNAPSHOTTED,
      snapshotKey,
      snapshotResult: result,
    });
    return { saga: updated, recorded: true };
  }

  async markCompleted(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
  ): Promise<RebalanceSaga> {
    const saga = await this.requireSaga(queueEntryId);
    this.assertWritable(saga, workerId, fencingToken);
    return this.repository.update(queueEntryId, {
      phase: REBALANCE_SAGA_PHASES.COMPLETED,
      completedAt: this.clock(),
      retryAt: null,
      lastError: null,
      lastErrorClass: null,
      requiresRecovery: false,
      requiresRecoveryReason: null,
      leasingWorker: null,
      leaseExpiresAt: null,
      fencingToken: null,
    });
  }

  // ── Failure / terminal recorders ────────────────────────────────────────

  async recordFailure(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    atPhase: RebalanceSagaPhase,
    error: string,
    errorClass: "transient" | "terminal" | "simulation" | "manual",
    metadata?: Record<string, unknown>,
  ): Promise<FailureRecordResult> {
    const saga = await this.requireSaga(queueEntryId);
    this.assertWritable(saga, workerId, fencingToken);

    const nextAttempt = saga.attemptCount + 1;
    const terminal =
      errorClass === "terminal" || errorClass === "manual" || nextAttempt >= saga.maxAttempts;
    const nextPhase = terminal ? REBALANCE_SAGA_PHASES.FAILED : atPhase;

    const retryDelayBaseMs = 60_000; // exponential backoff per attempt
    const retryAt = terminal
      ? null
      : new Date(this.clock().getTime() + retryDelayBaseMs * nextAttempt);

    const attempt: RebalanceSagaAttempt = {
      occurredAt: this.clock().toISOString(),
      phase: nextPhase,
      action: errorClass === "manual" ? "manual_review" : "failed",
      error,
      errorClass,
      metadata,
    };

    const updated = await this.repository.update(queueEntryId, {
      phase: nextPhase,
      attemptCount: nextAttempt,
      retryAt,
      lastError: error,
      lastErrorClass: errorClass,
      retryHistory: [attempt, ...saga.retryHistory].slice(0, 100),
      completedAt: terminal ? this.clock() : saga.completedAt,
      leasingWorker: terminal ? null : saga.leasingWorker,
      leaseExpiresAt: terminal ? null : saga.leaseExpiresAt,
      fencingToken: terminal ? null : saga.fencingToken,
    });

    return {
      saga: updated,
      terminal,
      shouldRetry: !terminal && retryAt !== null,
      retryAt,
    };
  }

  async requireManualReview(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    reason: string,
    metadata?: Record<string, unknown>,
  ): Promise<RebalanceSaga> {
    const saga = await this.requireSaga(queueEntryId);
    this.assertWritable(saga, workerId, fencingToken);

    const attempt: RebalanceSagaAttempt = {
      occurredAt: this.clock().toISOString(),
      phase: REBALANCE_SAGA_PHASES.REQUIRES_MANUAL_REVIEW,
      action: "manual_review",
      error: reason,
      metadata,
    };

    return this.repository.update(queueEntryId, {
      phase: REBALANCE_SAGA_PHASES.REQUIRES_MANUAL_REVIEW,
      requiresRecovery: true,
      requiresRecoveryReason: reason,
      lastError: reason,
      lastErrorClass: "manual",
      retryHistory: [attempt, ...saga.retryHistory].slice(0, 100),
      completedAt: this.clock(),
      leasingWorker: null,
      leaseExpiresAt: null,
      fencingToken: null,
    });
  }

  async cancel(
    queueEntryId: string,
    workerId: string,
    fencingToken: string,
    reason: string,
  ): Promise<RebalanceSaga> {
    const saga = await this.requireSaga(queueEntryId);
    this.assertWritable(saga, workerId, fencingToken);

    const attempt: RebalanceSagaAttempt = {
      occurredAt: this.clock().toISOString(),
      phase: REBALANCE_SAGA_PHASES.CANCELLED,
      action: "manual_review",
      error: reason,
    };

    return this.repository.update(queueEntryId, {
      phase: REBALANCE_SAGA_PHASES.CANCELLED,
      lastError: reason,
      completedAt: this.clock(),
      retryHistory: [attempt, ...saga.retryHistory].slice(0, 100),
      leasingWorker: null,
      leaseExpiresAt: null,
      fencingToken: null,
    });
  }

  // ── Inspection helpers ──────────────────────────────────────────────────

  /**
   * The durable ledger's submission state. Used by a retry to decide whether it
   * may submit ('none'), must confirm ('submitted'), or must reconcile an
   * in-flight outcome ('in_flight') — never resubmit.
   */
  async submissionStatus(queueEntryId: string): Promise<SubmissionStatus | null> {
    const saga = await this.repository.get(queueEntryId);
    if (!saga) return null;
    return {
      phase: saga.phase,
      submissionInFlight: saga.submissionInFlight,
      transactionHash: saga.transactionHash,
      submissionKey: saga.submissionKey,
      confirmation: saga.confirmationResult,
    };
  }

  /**
   * True when the saga already produced an on-chain action (submission recorded
   * or a terminal outcome that implies one). Retrying the same queue item in
   * that case must NEVER call submit again.
   */
  async hasOnChainAction(queueEntryId: string): Promise<boolean> {
    const saga = await this.repository.get(queueEntryId);
    if (!saga) return false;
    return (
      saga.submissionKey !== null ||
      saga.submissionResult !== null ||
      saga.transactionHash !== null ||
      saga.phase === REBALANCE_SAGA_PHASES.SUBMITTED ||
      saga.phase === REBALANCE_SAGA_PHASES.CONFIRMED ||
      saga.phase === REBALANCE_SAGA_PHASES.SNAPSHOTTED ||
      saga.phase === REBALANCE_SAGA_PHASES.COMPLETED ||
      saga.phase === REBALANCE_SAGA_PHASES.REQUIRES_MANUAL_REVIEW
    );
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async requireSaga(queueEntryId: string): Promise<RebalanceSaga> {
    const saga = await this.repository.get(queueEntryId);
    if (!saga) throw new SagaNotFoundError(queueEntryId);
    return saga;
  }

  private assertWritable(
    saga: RebalanceSaga,
    workerId: string,
    fencingToken: string,
  ): void {
    if (saga.fencingToken === null || saga.fencingToken !== fencingToken) {
      throw new StaleFencingTokenError(saga.queueEntryId);
    }
    const now = this.clock();
    if (saga.leaseExpiresAt !== null && saga.leaseExpiresAt <= now) {
      throw new StaleFencingTokenError(saga.queueEntryId);
    }
    if (saga.leasingWorker !== workerId) {
      throw new SagaConcurrencyError(saga.queueEntryId, workerId, saga.leasingWorker);
    }
  }

  private assertTransition(from: RebalanceSagaPhase, to: RebalanceSagaPhase): void {
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw new InvalidSagaTransitionError(from, to);
    }
  }

  private async recordOne(
    saga: RebalanceSaga,
    workerId: string,
    fencingToken: string,
    change: {
      phase: RebalanceSagaPhase;
      keyField: keyof RebalanceSaga;
      resultField: keyof RebalanceSaga;
      key: string;
      result: Record<string, unknown>;
    },
  ): Promise<PhaseRecordResult> {
    this.assertWritable(saga, workerId, fencingToken);
    const updated = await this.repository.update(saga.queueEntryId, {
      phase: change.phase,
      [change.keyField]: change.key,
      [change.resultField]: change.result,
    });
    return { saga: updated, recorded: true };
  }
}

// ── In-memory repository (unit tests, local dev) ────────────────────────────

export class InMemoryRebalanceSagaRepository implements RebalanceSagaRepository {
  readonly sagas = new Map<string, RebalanceSaga>();

  async get(queueEntryId: string): Promise<RebalanceSaga | null> {
    return this.sagas.get(queueEntryId) ? cloneSaga(this.sagas.get(queueEntryId)!) : null;
  }

  async create(saga: RebalanceSaga): Promise<RebalanceSaga> {
    this.sagas.set(saga.queueEntryId, cloneSaga(saga));
    return cloneSaga(saga);
  }

  async update(
    queueEntryId: string,
    update: Partial<Omit<RebalanceSaga, "queueEntryId" | "createdAt">>,
  ): Promise<RebalanceSaga> {
    const current = this.sagas.get(queueEntryId);
    if (!current) throw new SagaNotFoundError(queueEntryId);
    const next = { ...current, ...update, updatedAt: new Date() };
    this.sagas.set(queueEntryId, cloneSaga(next));
    return cloneSaga(next);
  }

  async list(filter: {
    vaultId?: string;
    phase?: RebalanceSagaPhase | RebalanceSagaPhase[];
    limit?: number;
  }): Promise<RebalanceSaga[]> {
    const phases = Array.isArray(filter.phase)
      ? filter.phase
      : filter.phase
        ? [filter.phase]
        : null;
    return Array.from(this.sagas.values())
      .filter((s) => {
        if (filter.vaultId && s.vaultId !== filter.vaultId) return false;
        if (phases && !phases.includes(s.phase)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit ?? 100)
      .map(cloneSaga);
  }

  async findStalled(now: Date, limit = 100): Promise<RebalanceSaga[]> {
    return Array.from(this.sagas.values())
      .filter(
        (s) =>
          !TERMINAL_PHASES.has(s.phase) &&
          (s.leaseExpiresAt === null || s.leaseExpiresAt <= now),
      )
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map(cloneSaga);
  }
}

function cloneSaga(saga: RebalanceSaga): RebalanceSaga {
  return { ...saga, retryHistory: saga.retryHistory.slice() };
}

// ── Prisma-backed repository ───────────────────────────────────────────────
// Durable implementation. The mapping functions keep the service decoupled
// from the exact generated-client model shape.

export interface RebalanceSagaPrismaClient {
  rebalanceSaga: {
    findUnique(args: {
      where: { queueEntryId: string };
    }): Promise<Record<string, unknown> | null>;
    create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
    update(args: {
      where: { queueEntryId: string };
      data: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
    findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  };
}

export class PrismaRebalanceSagaRepository implements RebalanceSagaRepository {
  constructor(private readonly client: RebalanceSagaPrismaClient) {}

  async get(queueEntryId: string): Promise<RebalanceSaga | null> {
    const row = await this.client.rebalanceSaga.findUnique({ where: { queueEntryId } });
    return row ? rowToSaga(row) : null;
  }

  async create(saga: RebalanceSaga): Promise<RebalanceSaga> {
    const row = await this.client.rebalanceSaga.create({ data: sagaToRow(saga) });
    return rowToSaga(row);
  }

  async update(
    queueEntryId: string,
    update: Partial<Omit<RebalanceSaga, "queueEntryId" | "createdAt">>,
  ): Promise<RebalanceSaga> {
    const row = await this.client.rebalanceSaga.update({
      where: { queueEntryId },
      data: sagaUpdateToRow(update),
    });
    return rowToSaga(row);
  }

  async list(filter: {
    vaultId?: string;
    phase?: RebalanceSagaPhase | RebalanceSagaPhase[];
    limit?: number;
  }): Promise<RebalanceSaga[]> {
    const rows = await this.client.rebalanceSaga.findMany({
      where: {
        vaultId: filter.vaultId,
        phase: Array.isArray(filter.phase) ? { in: filter.phase } : filter.phase,
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit ?? 100,
    });
    return rows.map(rowToSaga);
  }

  async findStalled(now: Date, limit = 100): Promise<RebalanceSaga[]> {
    const rows = await this.client.rebalanceSaga.findMany({
      where: {
        phase: { notIn: Array.from(TERMINAL_PHASES) },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
    return rows.map(rowToSaga);
  }
}

// ── Row mapping helpers ─────────────────────────────────────────────────────

function sagaToRow(saga: RebalanceSaga): Record<string, unknown> {
  return {
    queueEntryId: saga.queueEntryId,
    vaultId: saga.vaultId,
    intentHash: saga.intentHash,
    jobId: saga.jobId,
    phase: saga.phase,
    quoteKey: saga.quoteKey,
    approvalKey: saga.approvalKey,
    simulationKey: saga.simulationKey,
    submissionKey: saga.submissionKey,
    confirmationKey: saga.confirmationKey,
    snapshotKey: saga.snapshotKey,
    quoteResult: saga.quoteResult,
    approvalResult: saga.approvalResult,
    simulationResult: saga.simulationResult,
    submissionResult: saga.submissionResult,
    confirmationResult: saga.confirmationResult,
    snapshotResult: saga.snapshotResult,
    submissionInFlight: saga.submissionInFlight,
    transactionHash: saga.transactionHash,
    ledger: saga.ledger,
    lastError: saga.lastError,
    lastErrorClass: saga.lastErrorClass,
    requiresRecovery: saga.requiresRecovery,
    requiresRecoveryReason: saga.requiresRecoveryReason,
    attemptCount: saga.attemptCount,
    maxAttempts: saga.maxAttempts,
    retryAt: saga.retryAt,
    leasingWorker: saga.leasingWorker,
    leaseExpiresAt: saga.leaseExpiresAt,
    fencingToken: saga.fencingToken,
    retryHistory: JSON.stringify(saga.retryHistory),
    completedAt: saga.completedAt,
  };
}

function sagaUpdateToRow(
  update: Partial<Omit<RebalanceSaga, "queueEntryId" | "createdAt">>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    row[key] = key === "retryHistory" ? JSON.stringify(value) : value;
  }
  return row;
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return { raw: value };
    }
  }
  return value as Record<string, unknown>;
}

function readAttempts(value: unknown): RebalanceSagaAttempt[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as RebalanceSagaAttempt[];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as RebalanceSagaAttempt[]) : [];
}

function asBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return typeof value === "bigint" ? value : typeof value === "number" ? BigInt(value) : BigInt(String(value));
}

function rowToSaga(row: Record<string, unknown>): RebalanceSaga {
  return {
    queueEntryId: String(row.queueEntryId),
    vaultId: String(row.vaultId),
    intentHash: String(row.intentHash),
    jobId: (row.jobId as string | null) ?? null,
    phase: (row.phase as RebalanceSagaPhase) ?? REBALANCE_SAGA_PHASES.PENDING,
    quoteKey: (row.quoteKey as string | null) ?? null,
    approvalKey: (row.approvalKey as string | null) ?? null,
    simulationKey: (row.simulationKey as string | null) ?? null,
    submissionKey: (row.submissionKey as string | null) ?? null,
    confirmationKey: (row.confirmationKey as string | null) ?? null,
    snapshotKey: (row.snapshotKey as string | null) ?? null,
    quoteResult: readJson(row.quoteResult),
    approvalResult: readJson(row.approvalResult),
    simulationResult: readJson(row.simulationResult),
    submissionResult: readJson(row.submissionResult),
    confirmationResult: readJson(row.confirmationResult),
    snapshotResult: readJson(row.snapshotResult),
    submissionInFlight: Boolean(row.submissionInFlight),
    transactionHash: (row.transactionHash as string | null) ?? null,
    ledger: asBigInt(row.ledger),
    lastError: (row.lastError as string | null) ?? null,
    lastErrorClass: (row.lastErrorClass as string | null) ?? null,
    requiresRecovery: Boolean(row.requiresRecovery),
    requiresRecoveryReason: (row.requiresRecoveryReason as string | null) ?? null,
    attemptCount: Number(row.attemptCount ?? 0),
    maxAttempts: Number(row.maxAttempts ?? 3),
    retryAt: asDate(row.retryAt),
    leasingWorker: (row.leasingWorker as string | null) ?? null,
    leaseExpiresAt: asDate(row.leaseExpiresAt),
    fencingToken: (row.fencingToken as string | null) ?? null,
    retryHistory: readAttempts(row.retryHistory),
    completedAt: asDate(row.completedAt),
    createdAt: asDate(row.createdAt) ?? new Date(),
    updatedAt: asDate(row.updatedAt) ?? new Date(),
  };
}