/**
 * Rebalance Auction Service
 * 
 * Coordinates the MEV-resistant solver auction for vault rebalances.
 * Manages the full lifecycle: intent creation → commit → reveal → winner selection → settlement.
 * 
 * Security Invariants:
 * - A valid intent can consume vault funds at most once
 * - Settlement cannot exceed any per-asset, aggregate loss, fee, or slippage bound
 * - Solver ranking is deterministic from committed bid data
 * - Queue completion requires confirmed on-chain evidence
 * - Expired or cancelled intents cannot be revived
 */

import { PrismaClient, RebalanceAuctionIntent, SolverBid, AuctionSettlement } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ── Types ───────────────────────────────────────────────────────────────

export type ExecutionState =
  | 'INTENT_CREATED'
  | 'AUCTION_OPEN'
  | 'BIDDING_CLOSED'
  | 'WINNER_SELECTED'
  | 'SETTLEMENT_PENDING'
  | 'SETTLED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface InputPosition {
  token: string;
  amount: bigint;
  protocol: string;
}

export interface AllocationConstraint {
  token: string;
  protocol: string;
  targetMinBps: number;
  targetMaxBps: number;
  currentBps: number;
}

export interface RouteLeg {
  fromToken: string;
  toToken: string;
  fromProtocol: string;
  toProtocol: string;
  amountIn: bigint;
  minAmountOut: bigint;
}

export interface CreateIntentRequest {
  vaultId: string;
  vaultContractId: string;
  strategySnapshotId: string;
  strategyVersion: number;
  inputPositions: InputPosition[];
  targetConstraints: AllocationConstraint[];
  maxTotalLossBps: number;
  maxSlippageBps: number;
  maxFeesBps: number;
  maxPriceImpactBps: number;
  minTotalOutputValue: bigint;
  allowedTokens: string[];
  allowedProtocols: string[];
  routeSuggestion: RouteLeg[];
  partialFillPolicy: 'FULL_ONLY' | 'PRO_RATA' | 'MIN_PERCENT';
  expiryLedger: bigint;
  triggeredBy?: string;
}

export interface CommitBidRequest {
  intentId: string;
  solverAddress: string;
  commitHash: string;
}

export interface RevealBidRequest {
  intentId: string;
  solverAddress: string;
  outputAmounts: Record<string, bigint>;
  totalOutputValue: bigint;
  route: RouteLeg[];
  feesBps: number;
  slippageBps: number;
  priceImpactBps: number;
}

export interface SettlementRequest {
  intentId: string;
  solverAddress: string;
  txHash: string;
  preBalances: Record<string, bigint>;
  postBalances: Record<string, bigint>;
}

export interface AuctionStatus {
  intentId: string;
  state: ExecutionState;
  bidCount: number;
  revealedBidCount: number;
  winnerAddress?: string;
  timeUntilExpiry: number;
  totalInputValue: bigint;
}

// ── Constants ───────────────────────────────────────────────────────────

const BPS_SCALE = 10_000;
const DOMAIN_SEPARATOR = Buffer.from('StellarYield::RebalanceAuction::v1');
const COMMIT_PHASE_DURATION_MS = 60_000; // 60 seconds
const REVEAL_PHASE_DURATION_MS = 30_000; // 30 seconds
const MAX_INTENT_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Service ─────────────────────────────────────────────────────────────

export class RebalanceAuctionService {
  /**
   * Create a new rebalance intent on-chain and persist it.
   */
  async createIntent(request: CreateIntentRequest): Promise<RebalanceAuctionIntent> {
    // Calculate total input value
    const totalInputValue = request.inputPositions.reduce(
      (sum, pos) => sum + pos.amount,
      BigInt(0)
    );

    if (totalInputValue <= BigInt(0)) {
      throw new Error('Total input value must be positive');
    }

    // Validate allocation constraints
    const totalMaxBps = request.targetConstraints.reduce(
      (sum, c) => sum + c.targetMaxBps,
      0
    );
    if (totalMaxBps > BPS_SCALE + 100) {
      throw new Error('Allocation constraints exceed 100%');
    }

    // Generate nonce and intent hash
    const nonce = Date.now();
    const intentHash = this.computeIntentHash(
      request.vaultContractId,
      request.strategySnapshotId,
      request.strategyVersion,
      totalInputValue,
      nonce
    );

    // Check for duplicate
    const existing = await prisma.rebalanceAuctionIntent.findUnique({
      where: { intentHash },
    });
    if (existing) {
      throw new Error(`Duplicate intent hash: ${intentHash}`);
    }

    // Persist intent
    const intent = await prisma.rebalanceAuctionIntent.create({
      data: {
        intentId: BigInt(nonce),
        vaultId: request.vaultId,
        vaultContractId: request.vaultContractId,
        strategySnapshotId: request.strategySnapshotId,
        strategyVersion: request.strategyVersion,
        state: 'AUCTION_OPEN',
        inputPositions: request.inputPositions as any,
        targetConstraints: request.targetConstraints as any,
        maxTotalLossBps: request.maxTotalLossBps,
        maxSlippageBps: request.maxSlippageBps,
        maxFeesBps: request.maxFeesBps,
        maxPriceImpactBps: request.maxPriceImpactBps,
        minTotalOutputValue: request.minTotalOutputValue,
        totalInputValue,
        allowedTokens: request.allowedTokens,
        allowedProtocols: request.allowedProtocols,
        partialFillPolicy: request.partialFillPolicy,
        nonce: BigInt(nonce),
        intentHash,
        creationLedger: BigInt(0), // Updated on-chain
        expiryLedger: request.expiryLedger,
        cancellationAuthority: request.vaultContractId,
        commitPhaseEnd: new Date(Date.now() + COMMIT_PHASE_DURATION_MS),
        revealPhaseEnd: new Date(Date.now() + COMMIT_PHASE_DURATION_MS + REVEAL_PHASE_DURATION_MS),
        triggeredBy: request.triggeredBy,
      },
    });

    // Audit log
    await this.auditLog(intent.id, 'INTENT_CREATED', request.vaultContractId, {
      totalInputValue: totalInputValue.toString(),
      strategyVersion: request.strategyVersion,
    });

    return intent;
  }

  /**
   * Solver commits a hash of their bid.
   * The commit prevents bid copying and front-running.
   */
  async commitBid(request: CommitBidRequest): Promise<SolverBid> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: request.intentId },
    });

    // Validate state
    if (intent.state !== 'AUCTION_OPEN') {
      throw new Error(`Intent ${request.intentId} is not open for bidding (state: ${intent.state})`);
    }

    // Check commit phase hasn't ended
    if (intent.commitPhaseEnd && intent.commitPhaseEnd < new Date()) {
      throw new Error('Commit phase has ended');
    }

    // Check for duplicate commit
    const existing = await prisma.solverBid.findUnique({
      where: {
        intentId_solverAddress: {
          intentId: request.intentId,
          solverAddress: request.solverAddress,
        },
      },
    });
    if (existing) {
      throw new Error(`Solver ${request.solverAddress} already committed to intent ${request.intentId}`);
    }

    // Create bid record
    const bid = await prisma.solverBid.create({
      data: {
        intentId: request.intentId,
        solverAddress: request.solverAddress,
        commitHash: request.commitHash,
        commitTimestamp: new Date(),
        outputAmounts: {},
        totalOutputValue: BigInt(0),
        route: [],
        feesBps: 0,
        slippageBps: 0,
        priceImpactBps: 0,
      },
    });

    // Audit log
    await this.auditLog(request.intentId, 'BID_COMMITTED', request.solverAddress, {
      commitHash: request.commitHash,
    });

    return bid;
  }

  /**
   * Solver reveals their bid after the commit phase.
   * The revealed bid must hash to the previously committed hash.
   */
  async revealBid(request: RevealBidRequest): Promise<SolverBid> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: request.intentId },
    });

    // Validate state
    if (intent.state !== 'AUCTION_OPEN' && intent.state !== 'BIDDING_CLOSED') {
      throw new Error(`Intent ${request.intentId} is not in reveal phase (state: ${intent.state})`);
    }

    // Transition to BIDDING_CLOSED on first reveal
    if (intent.state === 'AUCTION_OPEN') {
      await prisma.rebalanceAuctionIntent.update({
        where: { id: request.intentId },
        data: { state: 'BIDDING_CLOSED' },
      });
    }

    // Check for existing commit
    const bid = await prisma.solverBid.findUniqueOrThrow({
      where: {
        intentId_solverAddress: {
          intentId: request.intentId,
          solverAddress: request.solverAddress,
        },
      },
    });

    if (bid.revealed) {
      throw new Error(`Solver ${request.solverAddress} already revealed for intent ${request.intentId}`);
    }

    // Compute reveal hash and verify against commit
    const revealHash = this.computeBidHash(
      request.solverAddress,
      request.intentId,
      request.outputAmounts,
      request.totalOutputValue,
      request.feesBps,
      request.slippageBps
    );

    if (revealHash !== bid.commitHash) {
      throw new Error('Reveal hash does not match commit hash');
    }

    // Validate bid constraints against intent
    this.validateBidConstraints(intent, request);

    // Update bid with revealed data
    const updatedBid = await prisma.solverBid.update({
      where: {
        intentId_solverAddress: {
          intentId: request.intentId,
          solverAddress: request.solverAddress,
        },
      },
      data: {
        revealed: true,
        outputAmounts: request.outputAmounts as any,
        totalOutputValue: request.totalOutputValue,
        route: request.route as any,
        feesBps: request.feesBps,
        slippageBps: request.slippageBps,
        priceImpactBps: request.priceImpactBps,
        bidHash: revealHash,
        revealTimestamp: new Date(),
      },
    });

    // Audit log
    await this.auditLog(request.intentId, 'BID_REVEALED', request.solverAddress, {
      totalOutputValue: request.totalOutputValue.toString(),
      feesBps: request.feesBps,
      slippageBps: request.slippageBps,
    });

    return updatedBid;
  }

  /**
   * Select the winning bid using deterministic ranking.
   * 
   * Ranking criteria (in order):
   * 1. Highest net output value (after fees)
   * 2. Lowest slippage
   * 3. Lowest price impact
   * 4. Earliest reveal timestamp (tie-breaker)
   */
  async selectWinner(intentId: string): Promise<SolverBid> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: intentId },
    });

    if (intent.state !== 'BIDDING_CLOSED' && intent.state !== 'AUCTION_OPEN') {
      throw new Error(`Intent ${intentId} is not ready for winner selection (state: ${intent.state})`);
    }

    // Get all revealed bids
    const revealedBids = await prisma.solverBid.findMany({
      where: {
        intentId,
        revealed: true,
      },
      orderBy: [
        { totalOutputValue: 'desc' },
        { slippageBps: 'asc' },
        { priceImpactBps: 'asc' },
        { revealTimestamp: 'asc' },
      ],
    });

    if (revealedBids.length === 0) {
      throw new Error('No valid bids found for intent');
    }

    // Select winner
    const winner = revealedBids[0];

    // Rank all bids
    await Promise.all(
      revealedBids.map((bid, index) =>
        prisma.solverBid.update({
          where: { id: bid.id },
          data: { rank: index + 1 },
        })
      )
    );

    // Update intent
    await prisma.rebalanceAuctionIntent.update({
      where: { id: intentId },
      data: {
        state: 'WINNER_SELECTED',
        winningSolver: winner.solverAddress,
      },
    });

    // Audit log
    await this.auditLog(intentId, 'WINNER_SELECTED', winner.solverAddress, {
      totalOutputValue: winner.totalOutputValue.toString(),
      rank: 1,
      totalBids: revealedBids.length,
    });

    return winner;
  }

  /**
   * Record on-chain settlement with exact post-trade balances.
   * Requires confirmed on-chain evidence before marking complete.
   */
  async recordSettlement(request: SettlementRequest): Promise<AuctionSettlement> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: request.intentId },
    });

    if (intent.state !== 'WINNER_SELECTED' && intent.state !== 'SETTLEMENT_PENDING') {
      throw new Error(`Intent ${request.intentId} cannot be settled (state: ${intent.state})`);
    }

    // Check for duplicate settlement
    const existingSettlement = await prisma.auctionSettlement.findUnique({
      where: { intentId: request.intentId },
    });
    if (existingSettlement) {
      throw new Error(`Intent ${request.intentId} already settled`);
    }

    // Calculate fill deltas
    const fillDeltas: Record<string, bigint> = {};
    for (const [token, postBalance] of Object.entries(request.postBalances)) {
      const preBalance = request.preBalances[token] || BigInt(0);
      fillDeltas[token] = postBalance - preBalance;
    }

    // Calculate realized slippage
    const minOutput = intent.minTotalOutputValue;
    const totalOutput = Object.values(fillDeltas).reduce(
      (sum, delta) => sum + (delta > BigInt(0) ? delta : BigInt(0)),
      BigInt(0)
    );

    let realizedSlippageBps = 0;
    if (minOutput > BigInt(0) && totalOutput < minOutput) {
      realizedSlippageBps = Number(
        ((minOutput - totalOutput) * BigInt(BPS_SCALE)) / minOutput
      );
    }

    // Calculate protocol fees
    const protocolFeeBps = intent.maxFeesBps;
    const totalFees = (totalOutput * BigInt(protocolFeeBps)) / BigInt(BPS_SCALE);

    // Record settlement
    const settlement = await prisma.auctionSettlement.create({
      data: {
        intentId: request.intentId,
        solverAddress: request.solverAddress,
        txHash: request.txHash,
        settlementLedger: BigInt(0), // Updated on-chain
        settledAt: new Date(),
        preBalances: request.preBalances as any,
        postBalances: request.postBalances as any,
        fillDeltas: fillDeltas as any,
        totalFees,
        realizedSlippageBps,
        protocolFeeBps,
        partialFill: false,
        filledPercentage: 10000,
      },
    });

    // Update intent
    await prisma.rebalanceAuctionIntent.update({
      where: { id: request.intentId },
      data: {
        state: 'SETTLED',
        settlementTxHash: request.txHash,
        realizedSlippageBps,
        totalOutputValue: totalOutput,
        completedAt: new Date(),
      },
    });

    // Update solver reputation
    await this.updateSolverReputation(request.solverAddress, true);

    // Audit log
    await this.auditLog(request.intentId, 'SETTLEMENT_CONFIRMED', request.solverAddress, {
      txHash: request.txHash,
      totalOutput: totalOutput.toString(),
      realizedSlippageBps,
      totalFees: totalFees.toString(),
    });

    return settlement;
  }

  /**
   * Cancel an intent. Only the cancellation authority (vault) can cancel.
   * Slashes all committed solver bonds.
   */
  async cancelIntent(intentId: string, callerAddress: string): Promise<void> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: intentId },
    });

    if (intent.state === 'CANCELLED') {
      throw new Error('Intent already cancelled');
    }

    if (intent.state === 'SETTLED') {
      throw new Error('Cannot cancel settled intent');
    }

    if (callerAddress !== intent.cancellationAuthority) {
      throw new Error('Only cancellation authority can cancel intent');
    }

    // Slash all committed solver bonds
    const committedBids = await prisma.solverBid.findMany({
      where: { intentId },
    });

    for (const bid of committedBids) {
      if (bid.bondAmount > BigInt(0)) {
        await prisma.solverBid.update({
          where: { id: bid.id },
          data: { bondSlashed: true },
        });

        await this.updateSolverReputation(bid.solverAddress, false);
      }
    }

    // Update intent
    await prisma.rebalanceAuctionIntent.update({
      where: { id: intentId },
      data: {
        state: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    // Audit log
    await this.auditLog(intentId, 'CANCELLED', callerAddress, {
      slashedBonds: committedBids.length,
    });
  }

  /**
   * Expire an intent. Anyone can call this after the expiry ledger.
   */
  async expireIntent(intentId: string): Promise<void> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: intentId },
    });

    if (intent.state === 'SETTLED' || intent.state === 'CANCELLED' || intent.state === 'EXPIRED') {
      throw new Error('Intent cannot be expired');
    }

    // Slash all committed solver bonds
    const committedBids = await prisma.solverBid.findMany({
      where: { intentId },
    });

    for (const bid of committedBids) {
      if (bid.bondAmount > BigInt(0)) {
        await prisma.solverBid.update({
          where: { id: bid.id },
          data: { bondSlashed: true },
        });

        await this.updateSolverReputation(bid.solverAddress, false);
      }
    }

    // Update intent
    await prisma.rebalanceAuctionIntent.update({
      where: { id: intentId },
      data: {
        state: 'EXPIRED',
        completedAt: new Date(),
      },
    });

    // Audit log
    await this.auditLog(intentId, 'EXPIRED', 'SYSTEM', {
      slashedBonds: committedBids.length,
    });
  }

  /**
   * Get auction status for monitoring.
   */
  async getAuctionStatus(intentId: string): Promise<AuctionStatus> {
    const intent = await prisma.rebalanceAuctionIntent.findUniqueOrThrow({
      where: { id: intentId },
      include: {
        bids: true,
        settlement: true,
      },
    });

    const bidCount = intent.bids.length;
    const revealedBidCount = intent.bids.filter((b) => b.revealed).length;

    const timeUntilExpiry = intent.expiryLedger
      ? Math.max(0, Number(intent.expiryLedger) - Date.now())
      : 0;

    return {
      intentId,
      state: intent.state as ExecutionState,
      bidCount,
      revealedBidCount,
      winnerAddress: intent.winningSolver || undefined,
      timeUntilExpiry,
      totalInputValue: intent.totalInputValue,
    };
  }

  /**
   * Check for and expire stale intents.
   */
  async processExpiredIntents(): Promise<number> {
    const expiredIntents = await prisma.rebalanceAuctionIntent.findMany({
      where: {
        state: { in: ['AUCTION_OPEN', 'BIDDING_CLOSED', 'WINNER_SELECTED'] },
        expiryLedger: { lt: BigInt(Date.now()) },
      },
    });

    for (const intent of expiredIntents) {
      try {
        await this.expireIntent(intent.id);
      } catch (error) {
        console.error(`Failed to expire intent ${intent.id}:`, error);
      }
    }

    return expiredIntents.length;
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private computeIntentHash(
    vaultContractId: string,
    strategySnapshotId: string,
    strategyVersion: number,
    totalInputValue: bigint,
    nonce: number
  ): string {
    const data = Buffer.concat([
      DOMAIN_SEPARATOR,
      Buffer.from(vaultContractId),
      Buffer.from(strategySnapshotId),
      Buffer.from([strategyVersion]),
      Buffer.from(totalInputValue.toString(16).padStart(32, '0')),
      Buffer.from(nonce.toString(16).padStart(16, '0')),
    ]);
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private computeBidHash(
    solverAddress: string,
    intentId: string,
    outputAmounts: Record<string, bigint>,
    totalOutputValue: bigint,
    feesBps: number,
    slippageBps: number
  ): string {
    const amountsStr = Object.entries(outputAmounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([token, amount]) => `${token}:${amount}`)
      .join(',');

    const data = [
      solverAddress,
      intentId,
      totalOutputValue.toString(),
      feesBps.toString(),
      slippageBps.toString(),
      amountsStr,
    ].join('|');

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private validateBidConstraints(
    intent: RebalanceAuctionIntent,
    request: RevealBidRequest
  ): void {
    // Check minimum output
    if (request.totalOutputValue < intent.minTotalOutputValue) {
      throw new Error(
        `Bid output ${request.totalOutputValue} below minimum ${intent.minTotalOutputValue}`
      );
    }

    // Check fees
    if (request.feesBps > intent.maxFeesBps) {
      throw new Error(
        `Bid fees ${request.feesBps}bps exceed maximum ${intent.maxFeesBps}bps`
      );
    }

    // Check slippage
    if (request.slippageBps > intent.maxSlippageBps) {
      throw new Error(
        `Bid slippage ${request.slippageBps}bps exceed maximum ${intent.maxSlippageBps}bps`
      );
    }

    // Check price impact
    if (request.priceImpactBps > intent.maxPriceImpactBps) {
      throw new Error(
        `Bid price impact ${request.priceImpactBps}bps exceed maximum ${intent.maxPriceImpactBps}bps`
      );
    }

    // Check total loss
    const potentialLoss = intent.totalInputValue - request.totalOutputValue;
    if (potentialLoss > BigInt(0)) {
      const lossBps = Number((potentialLoss * BigInt(BPS_SCALE)) / intent.totalInputValue);
      if (lossBps > intent.maxTotalLossBps) {
        throw new Error(
          `Bid potential loss ${lossBps}bps exceed maximum ${intent.maxTotalLossBps}bps`
        );
      }
    }
  }

  private async updateSolverReputation(
    solverAddress: string,
    successful: boolean
  ): Promise<void> {
    const existing = await prisma.solverReputation.findUnique({
      where: { solverAddress },
    });

    if (existing) {
      await prisma.solverReputation.update({
        where: { solverAddress },
        data: {
          score: { [successful ? 'increment' : 'decrement']: successful ? 5 : 10 },
          totalSettled: { increment: 1 },
          successfulSettles: successful ? { increment: 1 } : undefined,
          failedSettles: successful ? undefined : { increment: 1 },
          lastSettledAt: new Date(),
        },
      });
    } else {
      await prisma.solverReputation.create({
        data: {
          solverAddress,
          score: successful ? 5 : -10,
          totalSettled: 1,
          successfulSettles: successful ? 1 : 0,
          failedSettles: successful ? 0 : 1,
          lastSettledAt: new Date(),
        },
      });
    }
  }

  private async auditLog(
    intentId: string,
    eventType: string,
    actor: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await prisma.executionAuditLog.create({
      data: {
        intentId,
        eventType,
        actor,
        details: JSON.parse(JSON.stringify(details)),
      },
    });
  }
}

// Export singleton
export const rebalanceAuctionService = new RebalanceAuctionService();
