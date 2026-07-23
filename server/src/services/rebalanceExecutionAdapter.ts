import * as StellarSdk from '@stellar/stellar-sdk';
import {
  recordRelayStart,
  recordRelaySuccess,
  recordRelayFailure,
} from './relayerStatusService';

export type ErrorClass = 'transient' | 'terminal' | 'simulation';

export interface ExecutionSimulationResult {
  success: boolean;
  error?: string;
  errorClass?: ErrorClass;
  metadata?: Record<string, unknown>;
}

export interface ExecutionSubmitResult {
  success: boolean;
  transactionHash?: string;
  ledger?: number;
  status: 'submitted' | 'confirmed' | 'failed';
  error?: string;
  errorClass?: ErrorClass;
  metadata?: Record<string, unknown>;
}

export interface RebalanceExecutionRequest {
  queueEntryId: string;
  vaultId: string;
  vaultContractId: string;
  targetAllocations: Record<string, number>;
  currentAllocations: Record<string, number>;
  executionStrategy: Record<string, unknown>;
  intentHash: string;
  adminAddress?: string;
}

export interface ExecutionAdapter {
  name: string;
  simulate(request: RebalanceExecutionRequest): Promise<ExecutionSimulationResult>;
  submit(request: RebalanceExecutionRequest): Promise<ExecutionSubmitResult>;
}

const TRANSIENT_PATTERNS = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'timeout',
  'network',
  'rate limit',
  '503',
  '502',
  '500',
  'try again',
  'overloaded',
];

function classifyError(error: unknown): ErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('simulation')) return 'simulation';
  if (
    lower.includes('tx_bad_auth') ||
    lower.includes('unauthorized') ||
    lower.includes('insufficient') ||
    lower.includes('negative') ||
    lower.includes('already')
  ) {
    return 'terminal';
  }
  if (TRANSIENT_PATTERNS.some(p => lower.includes(p))) return 'transient';

  return 'terminal';
}

export class InMemoryIdempotencyStore {
  private cache = new Map<string, { result: ExecutionSubmitResult; timestamp: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(intentHash: string): ExecutionSubmitResult | undefined {
    const entry = this.cache.get(intentHash);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(intentHash);
      return undefined;
    }
    return entry.result;
  }

  set(intentHash: string, result: ExecutionSubmitResult): void {
    this.cache.set(intentHash, { result, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }
}

export class MockExecutionAdapter implements ExecutionAdapter {
  name = 'mock';
  private idempotency = new InMemoryIdempotencyStore();
  private simulationFailures = 0;
  private submitFailures = 0;
  private failureErrorClass: ErrorClass = 'transient';
  private simulationErrorClass: ErrorClass = 'simulation';
  private submitResults: ExecutionSubmitResult[] = [];

  configureSimulationFailure(count: number, errorClass: ErrorClass = 'simulation'): this {
    this.simulationFailures = count;
    this.simulationErrorClass = errorClass;
    return this;
  }

  configureSubmitFailure(count: number, errorClass: ErrorClass = 'transient'): this {
    this.submitFailures = count;
    this.failureErrorClass = errorClass;
    return this;
  }

  addSubmitResult(result: ExecutionSubmitResult): this {
    this.submitResults.push(result);
    return this;
  }

  reset(): void {
    this.idempotency.clear();
    this.simulationFailures = 0;
    this.submitFailures = 0;
    this.submitResults = [];
  }

  async simulate(_request: RebalanceExecutionRequest): Promise<ExecutionSimulationResult> {
    if (this.simulationFailures > 0) {
      this.simulationFailures--;
      return {
        success: false,
        error: 'Simulation failed: insufficient liquidity',
        errorClass: this.simulationErrorClass,
        metadata: { reason: 'mock_simulation_failure' },
      };
    }
    return {
      success: true,
      metadata: { simulated: true },
    };
  }

  async submit(request: RebalanceExecutionRequest): Promise<ExecutionSubmitResult> {
    const cached = this.idempotency.get(request.intentHash);
    if (cached) {
      return { ...cached, metadata: { ...cached.metadata, fromCache: true } };
    }

    let result: ExecutionSubmitResult;
    if (this.submitResults.length > 0) {
      result = this.submitResults.shift()!;
    } else if (this.submitFailures > 0) {
      this.submitFailures--;
      result = {
        success: false,
        status: 'failed',
        error: 'Submit failed: relayer unavailable',
        errorClass: this.failureErrorClass,
        metadata: { reason: 'mock_submit_failure' },
      };
    } else {
      const hash = StellarSdk.hash(Buffer.from(request.intentHash)).toString('hex').slice(0, 64);
      const ledgerSource = Buffer.from(request.intentHash + '-ledger');
      const ledgerHash = StellarSdk.hash(ledgerSource).toString('hex');
      const ledger = parseInt(ledgerHash.slice(0, 8), 16) % 1000000 + 500000;
      result = {
        success: true,
        transactionHash: `0x${hash}`,
        ledger,
        status: 'confirmed',
        metadata: { confirmed: true },
      };
    }

    this.idempotency.set(request.intentHash, result);
    return result;
  }
}

export class SorobanRelayerExecutionAdapter implements ExecutionAdapter {
  name = 'soroban-relayer';
  private idempotency = new InMemoryIdempotencyStore();
  private readonly rpcUrl: string;
  private readonly relayerUrl: string;
  private readonly networkPassphrase: string;
  private readonly adminKeypair: StellarSdk.Keypair;
  private readonly vaultContractId: string;

  constructor(config: {
    rpcUrl: string;
    relayerUrl: string;
    networkPassphrase: string;
    adminKeypair: StellarSdk.Keypair;
    vaultContractId: string;
  }) {
    this.rpcUrl = config.rpcUrl;
    this.relayerUrl = config.relayerUrl;
    this.networkPassphrase = config.networkPassphrase;
    this.adminKeypair = config.adminKeypair;
    this.vaultContractId = config.vaultContractId;
  }

  async simulate(request: RebalanceExecutionRequest): Promise<ExecutionSimulationResult> {
    const server = new StellarSdk.rpc.Server(this.rpcUrl);

    try {
      const contract = new StellarSdk.Contract(this.vaultContractId);
      const op = contract.call(
        'rebalance',
        new StellarSdk.Address(this.adminKeypair.publicKey()).toScVal(),
        new StellarSdk.Address(this.vaultContractId).toScVal(),
        StellarSdk.nativeToScVal(1000000n, { type: 'i128' }),
      );

      const source = await server.getAccount(this.adminKeypair.publicKey());
      const tx = new StellarSdk.TransactionBuilder(source, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const timeoutMs = parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS ?? '10000', 10);
      const simulated = await Promise.race([
        server.simulateTransaction(tx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Simulation timeout')), timeoutMs)
        ),
      ]);

      if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
        const error = (simulated as StellarSdk.rpc.Api.SimulateTransactionErrorResponse).error;
        return {
          success: false,
          error: error ?? 'Simulation failed',
          errorClass: classifyError(error),
          metadata: { simulationError: error },
        };
      }

      return {
        success: true,
        metadata: { simulated: true },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorClass: classifyError(error),
        metadata: { simulationException: true },
      };
    }
  }

  async submit(request: RebalanceExecutionRequest): Promise<ExecutionSubmitResult> {
    const cached = this.idempotency.get(request.intentHash);
    if (cached) {
      return { ...cached, metadata: { ...cached.metadata, fromCache: true } };
    }

    try {
      const server = new StellarSdk.rpc.Server(this.rpcUrl);
      const contract = new StellarSdk.Contract(this.vaultContractId);
      const op = contract.call(
        'rebalance',
        new StellarSdk.Address(this.adminKeypair.publicKey()).toScVal(),
        new StellarSdk.Address(this.vaultContractId).toScVal(),
        StellarSdk.nativeToScVal(1000000n, { type: 'i128' }),
      );

      const source = await server.getAccount(this.adminKeypair.publicKey());
      const tx = new StellarSdk.TransactionBuilder(source, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      tx.sign(this.adminKeypair);

      const relayId = recordRelayStart();
      const startMs = Date.now();

      const relayerResponse = await fetch(`${this.relayerUrl}/api/relayer/fee-bump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ innerTxXdr: tx.toXDR() }),
      });

      if (!relayerResponse.ok) {
        const errorText = await relayerResponse.text();
        const durationMs = Date.now() - startMs;
        recordRelayFailure(relayId, durationMs, `Relayer error: ${relayerResponse.status}`);
        throw new Error(`Relayer rejected transaction: ${relayerResponse.status} ${errorText}`);
      }

      const relayerResult = await relayerResponse.json();
      const feeBumpTx = StellarSdk.TransactionBuilder.fromXDR(
        relayerResult.feeBumpXdr,
        this.networkPassphrase
      );

      const sendResponse = await server.sendTransaction(feeBumpTx);
      const durationMs = Date.now() - startMs;

      if (sendResponse.status === 'ERROR') {
        const errorMsg = sendResponse.errorResult
          ? `Transaction submission failed: ${JSON.stringify(sendResponse.errorResult)}`
          : 'Transaction submission failed';
        recordRelayFailure(relayId, durationMs, errorMsg);
        return {
          success: false,
          status: 'failed',
          error: errorMsg,
          errorClass: classifyError(errorMsg),
          metadata: { sendError: errorMsg },
        };
      }

      recordRelaySuccess(relayId, durationMs, relayerResult.innerTxHash, relayerResult.feeBumpHash);

      const result: ExecutionSubmitResult = {
        success: true,
        transactionHash: sendResponse.hash ?? relayerResult.feeBumpHash,
        status: 'submitted',
        metadata: {
          feeBumpHash: relayerResult.feeBumpHash,
          innerTxHash: relayerResult.innerTxHash,
          relayId,
        },
      };

      this.idempotency.set(request.intentHash, result);
      return result;
    } catch (error) {
      const result: ExecutionSubmitResult = {
        success: false,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        errorClass: classifyError(error),
        metadata: { submitException: true },
      };
      return result;
    }
  }
}
