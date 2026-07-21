/**
 * Solver Worker
 * 
 * Coordinates solver participation in rebalance auctions.
 * Monitors for new intents, generates bids, and executes winning bids.
 * 
 * Responsibilities:
 * - Watch for new auction intents
 * - Select appropriate solver based on intent requirements
 * - Generate and submit bids
 * - Execute winning bids
 * - Handle crash recovery
 */

import { Solver, SolverConfig, SolverBidProposal, SolverContext } from './solverInterface';
import { GreedySolver } from './greedySolver';
import { OptimalSolver } from './optimalSolver';
import { rebalanceAuctionService, RebalanceAuctionIntent } from '../../server/src/services/rebalanceAuctionService';

// ── Types ───────────────────────────────────────────────────────────────

interface WorkerConfig {
  pollIntervalMs: number;
  maxConcurrentIntents: number;
  retryDelayMs: number;
  maxRetries: number;
}

interface IntentProcessingState {
  intentId: string;
  solverName: string;
  status: 'pending' | 'committing' | 'committed' | 'revealing' | 'revealed' | 'executing' | 'completed' | 'failed';
  commitHash?: string;
  bidProposal?: SolverBidProposal;
  retries: number;
  startedAt: Date;
  lastUpdated: Date;
}

// ── Worker ──────────────────────────────────────────────────────────────

export class SolverWorker {
  private solvers: Solver[];
  private processingIntents: Map<string, IntentProcessingState> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private config: WorkerConfig;

  constructor(config?: Partial<WorkerConfig>) {
    this.config = {
      pollIntervalMs: config?.pollIntervalMs ?? 10_000, // 10 seconds
      maxConcurrentIntents: config?.maxConcurrentIntents ?? 5,
      retryDelayMs: config?.retryDelayMs ?? 5_000,
      maxRetries: config?.maxRetries ?? 3,
    };

    // Initialize solvers
    this.solvers = [
      new GreedySolver(),
      new OptimalSolver(),
    ];
  }

  /**
   * Start the solver worker.
   */
  start(): void {
    console.log('Starting solver worker...');
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        console.error('Solver worker poll error:', error);
      });
    }, this.config.pollIntervalMs);

    // Initial poll
    this.poll().catch((error) => {
      console.error('Solver worker initial poll error:', error);
    });
  }

  /**
   * Stop the solver worker.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('Solver worker stopped');
  }

  /**
   * Main poll loop: check for new intents and process them.
   */
  private async poll(): Promise<void> {
    // Check capacity
    if (this.processingIntents.size >= this.config.maxConcurrentIntents) {
      return;
    }

    // Process expired intents
    const expiredCount = await rebalanceAuctionService.processExpiredIntents();
    if (expiredCount > 0) {
      console.log(`Expired ${expiredCount} stale intents`);
    }

    // In production, this would query for new intents
    // For now, we process intents that are in AUCTION_OPEN state
    await this.processPendingIntents();
  }

  /**
   * Process intents that are in AUCTION_OPEN state.
   */
  private async processPendingIntents(): Promise<void> {
    // In production, this would query the database or chain for new intents
    // For now, we simulate processing
    console.log('Checking for new auction intents...');
  }

  /**
   * Process a specific intent.
   */
  async processIntent(intentId: string): Promise<void> {
    // Check if already processing
    if (this.processingIntents.has(intentId)) {
      console.log(`Intent ${intentId} already being processed`);
      return;
    }

    // Get intent details
    const intent = await rebalanceAuctionService.getAuctionStatus(intentId);

    // Select appropriate solver
    const solver = this.selectSolver(intent);
    if (!solver) {
      console.log(`No suitable solver found for intent ${intentId}`);
      return;
    }

    // Create processing state
    const state: IntentProcessingState = {
      intentId,
      solverName: solver.config.name,
      status: 'pending',
      retries: 0,
      startedAt: new Date(),
      lastUpdated: new Date(),
    };
    this.processingIntents.set(intentId, state);

    try {
      // Phase 1: Commit
      await this.commitBid(intentId, solver, state);

      // Phase 2: Reveal (after commit phase ends)
      // This would be triggered by a timer or event
      console.log(`Intent ${intentId}: Commit phase completed, waiting for reveal phase`);
    } catch (error) {
      console.error(`Failed to process intent ${intentId}:`, error);
      state.status = 'failed';
      state.lastUpdated = new Date();
    }
  }

  /**
   * Commit a bid for an intent.
   */
  private async commitBid(
    intentId: string,
    solver: Solver,
    state: IntentProcessingState
  ): Promise<void> {
    state.status = 'committing';
    state.lastUpdated = new Date();

    // Build solver context from intent
    const context = await this.buildSolverContext(intentId);

    // Check if solver can handle this intent
    if (!solver.canHandle(context)) {
      throw new Error(`Solver ${solver.config.name} cannot handle intent ${intentId}`);
    }

    // Generate bid proposal
    const bidProposal = await solver.proposeBid(context);
    state.bidProposal = bidProposal;

    // Generate commit hash
    const commitHash = this.generateCommitHash(
      solver.config.address,
      intentId,
      bidProposal
    );
    state.commitHash = commitHash;

    // Submit commit to auction service
    await rebalanceAuctionService.commitBid({
      intentId,
      solverAddress: solver.config.address,
      commitHash,
    });

    state.status = 'committed';
    state.lastUpdated = new Date();

    console.log(`Intent ${intentId}: Solver ${solver.config.name} committed bid`);
  }

  /**
   * Reveal a bid for an intent.
   */
  async revealBid(intentId: string): Promise<void> {
    const state = this.processingIntents.get(intentId);
    if (!state || state.status !== 'committed') {
      throw new Error(`Intent ${intentId} not ready for reveal`);
    }

    state.status = 'revealing';
    state.lastUpdated = new Date();

    const solver = this.solvers.find((s) => s.config.name === state.solverName);
    if (!solver) {
      throw new Error(`Solver ${state.solverName} not found`);
    }

    const bidProposal = state.bidProposal;
    if (!bidProposal) {
      throw new Error('No bid proposal found');
    }

    // Submit reveal
    await rebalanceAuctionService.revealBid({
      intentId,
      solverAddress: solver.config.address,
      outputAmounts: bidProposal.outputAmounts,
      totalOutputValue: bidProposal.totalOutputValue,
      route: bidProposal.route,
      feesBps: bidProposal.feesBps,
      slippageBps: bidProposal.slippageBps,
      priceImpactBps: bidProposal.priceImpactBps,
    });

    state.status = 'revealed';
    state.lastUpdated = new Date();

    console.log(`Intent ${intentId}: Solver ${solver.config.name} revealed bid`);
  }

  /**
   * Execute a winning bid.
   */
  async executeWinningBid(intentId: string): Promise<void> {
    const state = this.processingIntents.get(intentId);
    if (!state || state.status !== 'revealed') {
      throw new Error(`Intent ${intentId} not ready for execution`);
    }

    state.status = 'executing';
    state.lastUpdated = new Date();

    const solver = this.solvers.find((s) => s.config.name === state.solverName);
    if (!solver) {
      throw new Error(`Solver ${state.solverName} not found`);
    }

    const bidProposal = state.bidProposal;
    if (!bidProposal) {
      throw new Error('No bid proposal found');
    }

    const context = await this.buildSolverContext(intentId);

    // Execute on-chain
    const txHash = await solver.executeBid(context, bidProposal);

    // Record settlement
    const preBalances = await this.getPreSettlementBalances(context);
    const postBalances = await this.getPostSettlementBalances(context, txHash);

    await rebalanceAuctionService.recordSettlement({
      intentId,
      solverAddress: solver.config.address,
      txHash,
      preBalances,
      postBalances,
    });

    state.status = 'completed';
    state.lastUpdated = new Date();

    console.log(`Intent ${intentId}: Solver ${solver.config.name} executed bid, tx: ${txHash}`);

    // Clean up
    this.processingIntents.delete(intentId);
  }

  /**
   * Handle failed intent processing with retries.
   */
  async handleFailure(intentId: string, error: Error): Promise<void> {
    const state = this.processingIntents.get(intentId);
    if (!state) return;

    state.retries++;
    state.lastUpdated = new Date();

    if (state.retries >= this.config.maxRetries) {
      console.error(`Intent ${intentId}: Max retries exceeded, marking as failed`);
      state.status = 'failed';
      this.processingIntents.delete(intentId);
      return;
    }

    console.log(`Intent ${intentId}: Retry ${state.retries}/${this.config.maxRetries}`);
    
    // Wait before retry
    await new Promise((resolve) => setTimeout(resolve, this.config.retryDelayMs));

    // Reset status for retry
    state.status = 'pending';

    try {
      await this.processIntent(intentId);
    } catch (error) {
      await this.handleFailure(intentId, error as Error);
    }
  }

  /**
   * Select the best solver for an intent.
   */
  private selectSolver(intent: { intentId: string; totalInputValue: bigint }): Solver | null {
    // Try solvers in order of sophistication
    // OptimalSolver for high-value intents, GreedySolver for smaller ones
    for (const solver of this.solvers) {
      if (intent.totalInputValue >= solver.config.minBidValue) {
        return solver;
      }
    }
    return null;
  }

  /**
   * Build solver context from intent data.
   */
  private async buildSolverContext(intentId: string): Promise<SolverContext> {
    // In production, this would fetch full intent details from the chain
    // For now, return a mock context
    return {
      intentId,
      vaultContractId: 'VAULT_CONTRACT',
      inputPositions: [],
      targetConstraints: [],
      allowedTokens: [],
      allowedProtocols: [],
      maxSlippageBps: 200,
      maxFeesBps: 100,
      maxPriceImpactBps: 300,
      minTotalOutputValue: BigInt(9000),
      totalInputValue: BigInt(10000),
      currentBalances: {},
    };
  }

  /**
   * Generate commit hash for bid.
   */
  private generateCommitHash(
    solverAddress: string,
    intentId: string,
    bidProposal: SolverBidProposal
  ): string {
    const data = [
      solverAddress,
      intentId,
      bidProposal.totalOutputValue.toString(),
      bidProposal.feesBps.toString(),
      bidProposal.slippageBps.toString(),
      JSON.stringify(bidProposal.outputAmounts),
    ].join('|');

    // In production, this would use cryptographic hash
    return `COMMIT_${Buffer.from(data).toString('base64').slice(0, 32)}`;
  }

  /**
   * Get pre-settlement balances.
   */
  private async getPreSettlementBalances(
    context: SolverContext
  ): Promise<Record<string, bigint>> {
    // In production, this would query on-chain balances
    return context.currentBalances;
  }

  /**
   * Get post-settlement balances.
   */
  private async getPostSettlementBalances(
    context: SolverContext,
    _txHash: string
  ): Promise<Record<string, bigint>> {
    // In production, this would query on-chain balances after tx
    return context.currentBalances;
  }

  /**
   * Get processing state for monitoring.
   */
  getProcessingState(): Map<string, IntentProcessingState> {
    return new Map(this.processingIntents);
  }
}

// Export singleton
export const solverWorker = new SolverWorker();
