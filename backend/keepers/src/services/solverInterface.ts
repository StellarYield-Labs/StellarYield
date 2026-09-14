/**
 * Solver Interface
 * 
 * Defines the contract for MEV-resistant solvers that participate
 * in the rebalance auction protocol.
 */

import { RouteLeg } from './rebalanceAuctionService';

export interface SolverConfig {
  name: string;
  address: string;
  minBidValue: bigint;
  maxConcurrentIntents: number;
  defaultSlippageBps: number;
  defaultFeeBps: number;
}

export interface SolverBidProposal {
  outputAmounts: Record<string, bigint>;
  totalOutputValue: bigint;
  route: RouteLeg[];
  feesBps: number;
  slippageBps: number;
  priceImpactBps: number;
}

export interface SolverContext {
  intentId: string;
  vaultContractId: string;
  inputPositions: Array<{ token: string; amount: bigint; protocol: string }>;
  targetConstraints: Array<{
    token: string;
    protocol: string;
    targetMinBps: number;
    targetMaxBps: number;
  }>;
  allowedTokens: string[];
  allowedProtocols: string[];
  maxSlippageBps: number;
  maxFeesBps: number;
  maxPriceImpactBps: number;
  minTotalOutputValue: bigint;
  totalInputValue: bigint;
  currentBalances: Record<string, bigint>;
}

/**
 * Base solver interface that all solvers must implement.
 */
export interface Solver {
  readonly config: SolverConfig;

  /**
   * Evaluate whether this solver can handle the given intent.
   */
  canHandle(context: SolverContext): boolean;

  /**
   * Generate a bid proposal for the intent.
   * This is called during the commit phase to generate the hash.
   */
  proposeBid(context: SolverContext): Promise<SolverBidProposal>;

  /**
   * Execute the winning bid on-chain.
   * Returns the transaction hash of the settlement.
   */
  executeBid(
    context: SolverContext,
    bid: SolverBidProposal
  ): Promise<string>;
}
