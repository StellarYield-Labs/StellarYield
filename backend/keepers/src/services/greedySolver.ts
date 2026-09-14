/**
 * Greedy Solver
 * 
 * A simple, fast solver that takes the most direct route available.
 * Prioritizes speed over optimal execution.
 * 
 * Strategy:
 * - Finds the shortest path from input tokens to output tokens
 * - Takes the first available route that meets minimum output requirements
 * - Uses conservative slippage estimates
 * 
 * Use case: Low-value rebalances where speed matters more than price optimization
 */

import { Solver, SolverConfig, SolverBidProposal, SolverContext } from './solverInterface';
import { RouteLeg } from '../../server/src/services/rebalanceAuctionService';

export class GreedySolver implements Solver {
  readonly config: SolverConfig = {
    name: 'GreedySolver',
    address: process.env.GREEDY_SOLVER_ADDRESS || 'GREEDY_SOLVER_1',
    minBidValue: BigInt(1000), // $1K minimum
    maxConcurrentIntents: 5,
    defaultSlippageBps: 100, // 1%
    defaultFeeBps: 30, // 0.3%
  };

  canHandle(context: SolverContext): boolean {
    // Greedy solver can handle any intent within its value range
    return context.totalInputValue >= this.config.minBidValue;
  }

  async proposeBid(context: SolverContext): Promise<SolverBidProposal> {
    const route: RouteLeg[] = [];
    const outputAmounts: Record<string, bigint> = {};

    // Simple greedy strategy: for each input position, find the best
    // direct swap to a target token
    for (const position of context.inputPositions) {
      const targetToken = this.findBestTarget(position.token, context);
      if (!targetToken) continue;

      // Estimate output with conservative slippage
      const estimatedOutput = this.estimateOutput(
        position.token,
        targetToken,
        position.amount,
        context
      );

      route.push({
        fromToken: position.token,
        toToken: targetToken,
        fromProtocol: position.protocol,
        toProtocol: this.findProtocolForToken(targetToken, context),
        amountIn: position.amount,
        minAmountOut: estimatedOutput,
      });

      // Add to output amounts
      const current = outputAmounts[targetToken] || BigInt(0);
      outputAmounts[targetToken] = current + estimatedOutput;
    }

    const totalOutputValue = Object.values(outputAmounts).reduce(
      (sum, amount) => sum + amount,
      BigInt(0)
    );

    // Calculate slippage and price impact
    const slippageBps = this.calculateSlippage(totalOutputValue, context);
    const priceImpactBps = this.calculatePriceImpact(route, context);

    return {
      outputAmounts,
      totalOutputValue,
      route,
      feesBps: this.config.defaultFeeBps,
      slippageBps: Math.min(slippageBps, context.maxSlippageBps),
      priceImpactBps: Math.min(priceImpactBps, context.maxPriceImpactBps),
    };
  }

  async executeBid(
    context: SolverContext,
    bid: SolverBidProposal
  ): Promise<string> {
    // In production, this would submit the transaction to the chain
    // For now, return a mock transaction hash
    const timestamp = Date.now();
    const hash = `GREEDY_${timestamp}_${context.intentId.slice(0, 8)}`;
    return hash;
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private findBestTarget(
    sourceToken: string,
    context: SolverContext
  ): string | null {
    // Find the target token that gives the best output
    // For greedy solver, just pick the first allowed token
    const allowedTokens = context.allowedTokens.filter(
      (t) => t !== sourceToken
    );
    return allowedTokens[0] || null;
  }

  private findProtocolForToken(
    token: string,
    context: SolverContext
  ): string {
    // Find a protocol that supports this token
    return context.allowedProtocols[0] || 'UNKNOWN';
  }

  private estimateOutput(
    fromToken: string,
    toToken: string,
    amountIn: bigint,
    context: SolverContext
  ): bigint {
    // Simple 1:1 estimation with slippage buffer
    // In production, this would query actual DEX prices
    const slippageBuffer = BigInt(this.config.defaultSlippageBps);
    const estimated = amountIn - (amountIn * slippageBuffer) / BigInt(10000);
    return estimated > BigInt(0) ? estimated : BigInt(1);
  }

  private calculateSlippage(
    totalOutput: bigint,
    context: SolverContext
  ): number {
    if (context.minTotalOutputValue <= BigInt(0)) return 0;
    if (totalOutput >= context.minTotalOutputValue) return 0;

    const slippageAmount = context.minTotalOutputValue - totalOutput;
    return Number((slippageAmount * BigInt(10000)) / context.minTotalOutputValue);
  }

  private calculatePriceImpact(
    route: RouteLeg[],
    context: SolverContext
  ): number {
    // Simplified price impact calculation
    // In production, this would compare against oracle prices
    return Math.min(route.length * 10, context.maxPriceImpactBps); // 10bps per hop
  }
}
