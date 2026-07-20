import {
  ExecutionAdapter,
  ExecutionSimulationResult,
  ExecutionSubmitResult,
  RebalanceExecutionRequest,
} from '../services/rebalanceExecutionAdapter';
import { rebalanceQueueService, PartialFillConfig } from '../services/rebalanceQueueService';
import { REBALANCE_STATUS } from '../queues/types';

export interface QueueEntryForProcessing {
  id: string;
  vaultId: string;
  status: string;
  targetAllocations: Record<string, number>;
  currentAllocations: Record<string, number>;
  executionStrategy: Record<string, unknown>;
  intentHash: string;
  triggeredBy?: string;
  lastTransactionHash?: string | null;
}

export interface JobConfig {
  enabled: boolean;
  schedule?: string;
  batchSize: number;
  enableRetries: boolean;
  enableDeferredProcessing: boolean;
  partialFillConfig?: Partial<PartialFillConfig>;
  logResults: boolean;
  executionAdapter: ExecutionAdapter;
}

let jobHandle: ReturnType<typeof setInterval> | null = null;

export function startRebalanceQueueProcessorJob(
  config: Partial<JobConfig> = {},
): void {
  const finalConfig: JobConfig = {
    enabled: config.enabled !== false,
    batchSize: config.batchSize ?? 10,
    enableRetries: config.enableRetries !== false,
    enableDeferredProcessing: config.enableDeferredProcessing !== false,
    partialFillConfig: config.partialFillConfig,
    logResults: config.logResults !== false,
    executionAdapter: config.executionAdapter!,
  };

  if (!finalConfig.enabled) {
    console.log('Rebalance queue processor job is disabled');
    return;
  }

  if (!finalConfig.executionAdapter) {
    throw new Error('executionAdapter is required for rebalance queue processor job');
  }

  const intervalMs = 30000;
  console.log(
    `Starting rebalance queue processor job (interval: ${intervalMs}ms, batch size: ${finalConfig.batchSize})`,
  );

  jobHandle = setInterval(async () => {
    try {
      await runRebalanceQueueProcessorJob(finalConfig);
    } catch (error) {
      console.error('Rebalance queue processor job failed:', error);
    }
  }, intervalMs);
}

export function stopRebalanceQueueProcessorJob(): void {
  if (jobHandle) {
    clearInterval(jobHandle);
    jobHandle = null;
    console.log('Rebalance queue processor job stopped');
  }
}

export async function runRebalanceQueueProcessorJob(config: JobConfig): Promise<{
  success: boolean;
  processedRetries: number;
  processedDeferred: number;
  failedProcessing: number;
  timestamp: string;
}> {
  const startTime = Date.now();
  let processedRetries = 0;
  let processedDeferred = 0;
  let failedProcessing = 0;

  try {
    if (config.enableRetries) {
      const pendingRetries = await rebalanceQueueService.getPendingRetries();
      const toProcess = pendingRetries.slice(0, config.batchSize);

      if (config.logResults && toProcess.length > 0) {
        console.log(`Processing ${toProcess.length} pending retries...`);
      }

      for (const entry of toProcess) {
        try {
          await processQueueEntry(entry, config);
          processedRetries++;
        } catch (error) {
          console.error(`Failed to process retry for entry ${entry.id}:`, error);
          failedProcessing++;

          await rebalanceQueueService.recordFailedAttempt(
            entry.id,
            `Job processing failed: ${error instanceof Error ? error.message : String(error)}`,
            { errorClass: 'terminal', executionMetadata: { jobError: true } },
          );
        }
      }
    }

    if (config.enableDeferredProcessing) {
      const deferredEntries = await rebalanceQueueService.getDeferredEntries();
      const toProcess = deferredEntries.slice(0, config.batchSize);

      if (config.logResults && toProcess.length > 0) {
        console.log(`Processing ${toProcess.length} deferred entries...`);
      }

      for (const entry of toProcess) {
        try {
          await processQueueEntry(entry, config);
          processedDeferred++;
        } catch (error) {
          console.error(`Failed to process deferred entry ${entry.id}:`, error);
          failedProcessing++;

          await rebalanceQueueService.recordFailedAttempt(
            entry.id,
            `Job processing failed: ${error instanceof Error ? error.message : String(error)}`,
            { errorClass: 'terminal', executionMetadata: { jobError: true } },
          );
        }
      }
    }

    if (config.logResults) {
      const elapsed = Date.now() - startTime;
      console.log(
        `Rebalance queue processor job completed: ` +
          `${processedRetries} retries, ${processedDeferred} deferred, ` +
          `${failedProcessing} failed (${elapsed}ms)`,
      );
    }

    return {
      success: failedProcessing === 0,
      processedRetries,
      processedDeferred,
      failedProcessing,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Rebalance queue processor job error:', error);
    return {
      success: false,
      processedRetries,
      processedDeferred,
      failedProcessing,
      timestamp: new Date().toISOString(),
    };
  }
}

async function processQueueEntry(
  entry: QueueEntryForProcessing,
  config: JobConfig,
): Promise<void> {
  const queueEntryId = entry.id;

  if (entry.status === REBALANCE_STATUS.COMPLETED && entry.lastTransactionHash) {
    return;
  }

  await rebalanceQueueService.markAsProcessing(queueEntryId);

  const request: RebalanceExecutionRequest = {
    queueEntryId,
    vaultId: entry.vaultId,
    vaultContractId: entry.vaultId,
    targetAllocations: entry.targetAllocations,
    currentAllocations: entry.currentAllocations,
    executionStrategy: entry.executionStrategy,
    intentHash: entry.intentHash,
    adminAddress: entry.triggeredBy ?? undefined,
  };

  const simulationResult = await config.executionAdapter.simulate(request);
  if (!simulationResult.success) {
    await rebalanceQueueService.recordFailedAttempt(
      queueEntryId,
      simulationResult.error ?? 'Simulation failed',
      {
        ...config.partialFillConfig,
        errorClass: simulationResult.errorClass ?? 'terminal',
        executionMetadata: simulationResult.metadata,
      },
    );
    return;
  }

  const submitResult = await config.executionAdapter.submit(request);

  if (submitResult.success) {
    await rebalanceQueueService.recordSubmission(
      queueEntryId,
      submitResult.transactionHash ?? '',
      submitResult.ledger ?? 0,
      submitResult.errorClass,
      submitResult.metadata,
    );

    const filledPercentage = (submitResult.metadata?.filledPercentage as number | undefined) ?? 100;
    const totalExecuted = (submitResult.metadata?.totalExecuted as number | undefined) ?? filledPercentage;

    if (filledPercentage >= 100) {
      await rebalanceQueueService.markAsCompleted(
        queueEntryId,
        submitResult.transactionHash,
        submitResult.ledger,
        submitResult.errorClass,
        submitResult.metadata,
      );
    } else {
      await rebalanceQueueService.recordPartialExecution(
        queueEntryId,
        {
          queueEntryId,
          totalExecuted,
          expectedAmount: 100,
          filledPercentage,
          transactionHash: submitResult.transactionHash,
          executionDetails: {
            status: 'partial',
            ...submitResult.metadata,
          },
        },
        {
          ...config.partialFillConfig,
          ledger: submitResult.ledger,
          errorClass: submitResult.errorClass,
          executionMetadata: submitResult.metadata,
        },
      );
    }
  } else {
    const isTerminal = submitResult.errorClass === 'terminal';
    await rebalanceQueueService.recordFailedAttempt(
      queueEntryId,
      submitResult.error ?? 'Submission failed',
      {
        ...config.partialFillConfig,
        maxRetries: isTerminal ? 0 : config.partialFillConfig?.maxRetries,
        errorClass: submitResult.errorClass ?? 'terminal',
        transactionHash: submitResult.transactionHash,
        ledger: submitResult.ledger,
        executionMetadata: submitResult.metadata,
      },
    );
  }
}

export async function triggerQueueProcessing(
  batchSize = 10,
  executionAdapter: ExecutionAdapter,
): Promise<{
  retries: number;
  deferred: number;
  failed: number;
}> {
  const result = await runRebalanceQueueProcessorJob({
    enabled: true,
    batchSize,
    enableRetries: true,
    enableDeferredProcessing: true,
    logResults: true,
    executionAdapter,
  });

  return {
    retries: result.processedRetries,
    deferred: result.processedDeferred,
    failed: result.failedProcessing,
  };
}
