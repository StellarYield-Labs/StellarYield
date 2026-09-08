import crypto from 'crypto';

export const EXECUTION_STATES = {
  READY: 'READY',
  LEASED: 'LEASED',
  BUILT: 'BUILT',
  SIMULATED: 'SIMULATED',
  SIGNED: 'SIGNED',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  RECONCILING: 'RECONCILING',
} as const;

export type ExecutionState = (typeof EXECUTION_STATES)[keyof typeof EXECUTION_STATES];

export interface ExecutionRecord {
  intentId: string;
  intentHash: string;
  vaultId: string;
  operation: string;
  state: ExecutionState;
  fencingToken: bigint;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  sourceAccount: string | null;
  reservedSequence: bigint | null;
  unsignedXdr: string | null;
  simulatedXdr: string | null;
  signedEnvelopeHash: string | null;
  submissionHash: string | null;
  latestRpcStatus: string | null;
  validUntilLedger: bigint | null;
  resultXdr: string | null;
  retryClass: 'transport' | 'contract' | 'unknown' | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutboxMessage {
  id: string;
  aggregateId: string;
  topic: string;
  payload: Record<string, unknown>;
  publishedAt: Date | null;
  createdAt: Date;
}

export interface InboxMessage {
  messageId: string;
  consumer: string;
  intentId: string;
  processedAt: Date;
}

export interface SequenceReservation {
  sourceAccount: string;
  sequence: bigint;
  intentId: string;
  fencingToken: bigint;
  reservedUntil: Date;
}

export interface ExecutionCoordinatorRepository {
  getExecution(intentId: string): Promise<ExecutionRecord | null>;
  createExecution(record: ExecutionRecord): Promise<ExecutionRecord>;
  updateExecution(intentId: string, update: Partial<ExecutionRecord>): Promise<ExecutionRecord>;
  addOutbox(message: OutboxMessage): Promise<void>;
  getInbox(messageId: string, consumer: string): Promise<InboxMessage | null>;
  addInbox(message: InboxMessage): Promise<void>;
  getSequenceReservation(sourceAccount: string, sequence: bigint): Promise<SequenceReservation | null>;
  addSequenceReservation(reservation: SequenceReservation): Promise<void>;
  releaseSequenceReservation(sourceAccount: string, sequence: bigint, intentId: string): Promise<void>;
}

export interface CreateExecutionInput {
  intentId: string;
  vaultId: string;
  operation: string;
  payload: Record<string, unknown>;
}

export interface LeaseResult {
  execution: ExecutionRecord;
  fencingToken: bigint;
}

const TERMINAL_STATES = new Set<ExecutionState>([
  EXECUTION_STATES.CONFIRMED,
  EXECUTION_STATES.FAILED,
  EXECUTION_STATES.EXPIRED,
]);

const ALLOWED_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  READY: [EXECUTION_STATES.LEASED, EXECUTION_STATES.EXPIRED],
  LEASED: [EXECUTION_STATES.BUILT, EXECUTION_STATES.FAILED, EXECUTION_STATES.EXPIRED],
  BUILT: [EXECUTION_STATES.SIMULATED, EXECUTION_STATES.FAILED, EXECUTION_STATES.EXPIRED],
  SIMULATED: [EXECUTION_STATES.SIGNED, EXECUTION_STATES.FAILED, EXECUTION_STATES.EXPIRED],
  SIGNED: [EXECUTION_STATES.SUBMITTED, EXECUTION_STATES.FAILED, EXECUTION_STATES.EXPIRED],
  SUBMITTED: [EXECUTION_STATES.CONFIRMED, EXECUTION_STATES.RECONCILING, EXECUTION_STATES.FAILED],
  RECONCILING: [EXECUTION_STATES.CONFIRMED, EXECUTION_STATES.FAILED],
  CONFIRMED: [],
  FAILED: [],
  EXPIRED: [],
};

export class StaleLeaseError extends Error {
  constructor(intentId: string) {
    super(`Execution ${intentId} cannot be updated by a stale lease`);
    this.name = 'StaleLeaseError';
  }
}

export class InvalidExecutionTransitionError extends Error {
  constructor(from: ExecutionState, to: ExecutionState) {
    super(`Invalid execution transition ${from} -> ${to}`);
    this.name = 'InvalidExecutionTransitionError';
  }
}

export class DuplicateInboxMessageError extends Error {
  constructor(messageId: string, consumer: string) {
    super(`Message ${messageId} was already processed by ${consumer}`);
    this.name = 'DuplicateInboxMessageError';
  }
}

export class ExecutionCoordinatorService {
  constructor(
    private readonly repository: ExecutionCoordinatorRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createExecution(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const existing = await this.repository.getExecution(input.intentId);
    if (existing) return existing;

    const timestamp = this.now();
    const record: ExecutionRecord = {
      intentId: input.intentId,
      intentHash: this.hashIntent(input),
      vaultId: input.vaultId,
      operation: input.operation,
      state: EXECUTION_STATES.READY,
      fencingToken: 0n,
      leaseOwner: null,
      leaseExpiresAt: null,
      sourceAccount: null,
      reservedSequence: null,
      unsignedXdr: null,
      simulatedXdr: null,
      signedEnvelopeHash: null,
      submissionHash: null,
      latestRpcStatus: null,
      validUntilLedger: null,
      resultXdr: null,
      retryClass: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const created = await this.repository.createExecution(record);
    await this.enqueueOutbox(created.intentId, 'execution.ready', { state: created.state });
    return created;
  }

  async recordInbox(messageId: string, consumer: string, intentId: string): Promise<void> {
    const existing = await this.repository.getInbox(messageId, consumer);
    if (existing) throw new DuplicateInboxMessageError(messageId, consumer);

    await this.repository.addInbox({
      messageId,
      consumer,
      intentId,
      processedAt: this.now(),
    });
  }

  async acquireLease(
    intentId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<LeaseResult> {
    const execution = await this.requireExecution(intentId);
    if (TERMINAL_STATES.has(execution.state)) {
      throw new Error(`Execution ${intentId} is terminal (${execution.state})`);
    }

    const now = this.now();
    if (execution.leaseExpiresAt && execution.leaseExpiresAt > now && execution.leaseOwner !== workerId) {
      throw new Error(`Execution ${intentId} is leased by ${execution.leaseOwner}`);
    }

    const fencingToken = execution.fencingToken + 1n;
    const updated = await this.repository.updateExecution(intentId, {
      state: EXECUTION_STATES.LEASED,
      fencingToken,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
    });

    await this.enqueueOutbox(intentId, 'execution.leased', { workerId, fencingToken: fencingToken.toString() });
    return { execution: updated, fencingToken };
  }

  async transition(
    intentId: string,
    fencingToken: bigint,
    nextState: ExecutionState,
    patch: Partial<ExecutionRecord> = {},
  ): Promise<ExecutionRecord> {
    const execution = await this.requireExecution(intentId);
    this.assertCurrentLease(execution, fencingToken);
    this.assertTransition(execution.state, nextState);

    const updated = await this.repository.updateExecution(intentId, {
      ...patch,
      state: nextState,
      updatedAt: this.now(),
    });

    await this.enqueueOutbox(intentId, `execution.${nextState.toLowerCase()}`, {
      from: execution.state,
      to: nextState,
      fencingToken: fencingToken.toString(),
    });

    return updated;
  }

  async reserveSequence(
    intentId: string,
    fencingToken: bigint,
    sourceAccount: string,
    sequence: bigint,
    reserveMs: number,
  ): Promise<SequenceReservation> {
    const execution = await this.requireExecution(intentId);
    this.assertCurrentLease(execution, fencingToken);

    const existing = await this.repository.getSequenceReservation(sourceAccount, sequence);
    if (existing && existing.intentId !== intentId && existing.reservedUntil > this.now()) {
      throw new Error(
        `Sequence ${sequence.toString()} for ${sourceAccount} is reserved by ${existing.intentId}`,
      );
    }

    const reservation: SequenceReservation = {
      sourceAccount,
      sequence,
      intentId,
      fencingToken,
      reservedUntil: new Date(this.now().getTime() + reserveMs),
    };

    await this.repository.addSequenceReservation(reservation);
    await this.repository.updateExecution(intentId, {
      sourceAccount,
      reservedSequence: sequence,
      updatedAt: this.now(),
    });
    await this.enqueueOutbox(intentId, 'execution.sequence_reserved', {
      sourceAccount,
      sequence: sequence.toString(),
      fencingToken: fencingToken.toString(),
    });

    return reservation;
  }

  async recordSubmission(
    intentId: string,
    fencingToken: bigint,
    submissionHash: string,
    latestRpcStatus: string,
  ): Promise<ExecutionRecord> {
    return this.transition(intentId, fencingToken, EXECUTION_STATES.SUBMITTED, {
      submissionHash,
      latestRpcStatus,
    });
  }

  async markReconciling(intentId: string, fencingToken: bigint, latestRpcStatus: string): Promise<ExecutionRecord> {
    return this.transition(intentId, fencingToken, EXECUTION_STATES.RECONCILING, {
      latestRpcStatus,
      retryClass: 'transport',
    });
  }

  async confirm(intentId: string, fencingToken: bigint, resultXdr: string): Promise<ExecutionRecord> {
    const updated = await this.transition(intentId, fencingToken, EXECUTION_STATES.CONFIRMED, {
      latestRpcStatus: 'CONFIRMED',
      resultXdr,
    });

    if (updated.sourceAccount && updated.reservedSequence !== null) {
      await this.repository.releaseSequenceReservation(
        updated.sourceAccount,
        updated.reservedSequence,
        intentId,
      );
    }

    return updated;
  }

  private async requireExecution(intentId: string): Promise<ExecutionRecord> {
    const execution = await this.repository.getExecution(intentId);
    if (!execution) throw new Error(`Execution ${intentId} not found`);
    return execution;
  }

  private assertCurrentLease(execution: ExecutionRecord, fencingToken: bigint): void {
    if (
      execution.fencingToken !== fencingToken ||
      !execution.leaseExpiresAt ||
      execution.leaseExpiresAt <= this.now()
    ) {
      throw new StaleLeaseError(execution.intentId);
    }
  }

  private assertTransition(from: ExecutionState, to: ExecutionState): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new InvalidExecutionTransitionError(from, to);
    }
  }

  private async enqueueOutbox(
    aggregateId: string,
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.addOutbox({
      id: crypto.randomUUID(),
      aggregateId,
      topic,
      payload,
      publishedAt: null,
      createdAt: this.now(),
    });
  }

  private hashIntent(input: CreateExecutionInput): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        intentId: input.intentId,
        vaultId: input.vaultId,
        operation: input.operation,
        payload: input.payload,
      }))
      .digest('hex');
  }
}

export class InMemoryExecutionCoordinatorRepository implements ExecutionCoordinatorRepository {
  readonly executions = new Map<string, ExecutionRecord>();
  readonly outbox: OutboxMessage[] = [];
  readonly inbox = new Map<string, InboxMessage>();
  readonly sequences = new Map<string, SequenceReservation>();

  async getExecution(intentId: string): Promise<ExecutionRecord | null> {
    return this.executions.get(intentId) ?? null;
  }

  async createExecution(record: ExecutionRecord): Promise<ExecutionRecord> {
    this.executions.set(record.intentId, { ...record });
    return { ...record };
  }

  async updateExecution(intentId: string, update: Partial<ExecutionRecord>): Promise<ExecutionRecord> {
    const current = this.executions.get(intentId);
    if (!current) throw new Error(`Execution ${intentId} not found`);
    const next = { ...current, ...update };
    this.executions.set(intentId, next);
    return { ...next };
  }

  async addOutbox(message: OutboxMessage): Promise<void> {
    this.outbox.push(message);
  }

  async getInbox(messageId: string, consumer: string): Promise<InboxMessage | null> {
    return this.inbox.get(`${consumer}:${messageId}`) ?? null;
  }

  async addInbox(message: InboxMessage): Promise<void> {
    this.inbox.set(`${message.consumer}:${message.messageId}`, message);
  }

  async getSequenceReservation(sourceAccount: string, sequence: bigint): Promise<SequenceReservation | null> {
    return this.sequences.get(`${sourceAccount}:${sequence.toString()}`) ?? null;
  }

  async addSequenceReservation(reservation: SequenceReservation): Promise<void> {
    this.sequences.set(`${reservation.sourceAccount}:${reservation.sequence.toString()}`, reservation);
  }

  async releaseSequenceReservation(sourceAccount: string, sequence: bigint, intentId: string): Promise<void> {
    const key = `${sourceAccount}:${sequence.toString()}`;
    const current = this.sequences.get(key);
    if (current?.intentId === intentId) {
      this.sequences.delete(key);
    }
  }
}
