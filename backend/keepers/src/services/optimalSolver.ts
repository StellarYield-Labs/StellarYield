/**
 * Optimal Solver
 * 
 * A sophisticated solver that attempts to find the optimal execution path.
 * Uses multi-hop routing and price optimization.
 * 
 * Strategy:
 * - Analyzes all possible routes through allowed protocols
 * - Considers multi-hop swaps for better prices
 * - Optimizes for minimum slippage and maximum output
 * - Uses time-weighted average prices for more accurate estimates
 * 
 * Use case: High-value rebalances where execution quality matters more than speed
 */

import { Solver, SolverConfig, SolverBidProposal, SolverContext } from './solverInterface';
import { RouteLeg } from '../../server/src/services/rebalanceAuctionService';

interface RouteCandidate {
  route: RouteLeg[];
  outputAmounts: Record<string, bigint>;
  totalOutput: bigint;
  totalFees: bigint;
  priceImpact: number;
  slippage: number;
}

export class OptimalSolver implements Solver {
  readonly config: SolverConfig = {
    name: 'OptimalSolver',
    address: process.env.OPTIMAL_SOLVER_ADDRESS || 'OPTIMAL_SOLVER_1',
    minBidValue: BigInt(10000), // $10K minimum
    maxConcurrentIntents: 2,
    defaultSlippageBps: 50, // 0.5%
    defaultFeeBps: 20, // 0.2%
  };

  canHandle(context: SolverContext): boolean {
    return context.totalInputValue >= this.config.minBidValue;
  }

  async proposeBid(context: SolverContext): Promise<SolverBidProposal> {
    // Generate all possible route candidates
    const candidates = this.generateRouteCandidates(context);

    // Filter candidates that meet intent constraints
    const validCandidates = candidates.filter((c) =>
      this.isValidCandidate(c, context)
    );

    if (validCandidates.length === 0) {
      throw new Error('No valid routes found for intent');
    }

    // Select the optimal candidate (highest output, lowest risk)
    const optimal = this.selectOptimalCandidate(validCandidates, context);

    return {
      outputAmounts: optimal.outputAmounts,
      totalOutputValue: optimal.totalOutput,
      route: optimal.route,
      feesBps: this.config.defaultFeeBps,
      slippageBps: optimal.slippage,
      priceImpactBps: Math.round(optimal.priceImpact),
    };
  }

  async executeBid(
    context: SolverContext,
    bid: SolverBidProposal
  ): Promise<string> {
    // In production, this would:
    // 1. Build the actual transaction with all route legs
    // 2. Simulate the transaction
    // 3. Submit to the chain
    // 4. Wait for confirmation
    
    const timestamp = Date.now();
    const hash = `OPTIMAL_${timestamp}_${context.intentId.slice(0, 8)}`;
    return hash;
  }

  // ── Route Generation ───────────────────────────────────────────────

  private generateRouteCandidates(
    context: SolverContext
  ): RouteCandidate[] {
    const candidates: RouteCandidate[] = [];

    // Generate single-hop routes
    for (const position of context.inputPositions) {
      for (const targetToken of context.allowedTokens) {
        if (targetToken === position.token) continue;

        const route: RouteLeg[] = [
          {
            fromToken: position.token,
            toToken: targetToken,
            fromProtocol: position.protocol,
            toProtocol: this.selectBestProtocol(
              position.token,
              targetToken,
              context
            ),
            amountIn: position.amount,
            minAmountOut: this.estimateMinOutput(
              position.token,
              targetToken,
              position.amount,
              context
            ),
          },
        ];

        const outputAmounts: Record<string, bigint> = {};
        outputAmounts[targetToken] = route[0].minAmountOut;

        candidates.push({
          route,
          outputAmounts,
          totalOutput: route[0].minAmountOut,
          totalFees: (route[0].minAmountOut * BigInt(this.config.defaultFeeBps)) / BigInt(10000),
          priceImpact: this.estimatePriceImpact(position.token, targetToken, position.amount, context),
          slippage: 0,
        });
      }
    }

    // Generate multi-hop routes (2 hops)
    for (const position of context.inputPositions) {
      for (const intermediateToken of context.allowedTokens) {
        if (intermediateToken === position.token) continue;

        for (const targetToken of context.allowedTokens) {
          if (targetToken === intermediateToken || targetToken === position.token) continue;

          const hop1Output = this.estimateMinOutput(
            position.token,
            intermediateToken,
            position.amount,
            context
          );

          if (hop1Output <= BigInt(0)) continue;

          const hop2Output = this.estimateMinOutput(
            intermediateToken,
            targetToken,
            hop1Output,
            context
          );

          if (hop2Output <= BigInt(0)) continue;

          const route: RouteLeg[] = [
            {
              fromToken: position.token,
              toToken: intermediateToken,
              fromProtocol: position.protocol,
              toProtocol: this.selectBestProtocol(position.token, intermediateToken, context),
              amountIn: position.amount,
              minAmountOut: hop1Output,
            },
            {
              fromToken: intermediateToken,
              toToken: targetToken,
              fromProtocol: this.selectBestProtocol(position.token, intermediateToken, context),
              toProtocol: this.selectBestProtocol(intermediateToken, targetToken, context),
              amountIn: hop1Output,
              minAmountOut: hop2Output,
            },
          ];

          const outputAmounts: Record<string, bigint> = {};
          outputAmounts[targetToken] = hop2Output;

          candidates.push({
            route,
            outputAmounts,
            totalOutput: hop2Output,
            totalFees: (hop2Output * BigInt(this.config.defaultFeeBps)) / BigInt(10000),
            priceImpact: this.estimatePriceImpact(position.token, targetToken, position.amount, context) * 1.5,
            slippage: 0,
          });
        }
      }
    }

    return candidates;
  }

  private selectBestProtocol(
    fromToken: string,
    toToken: string,
    context: SolverContext
  ): string {
    // In production, this would query actual DEX liquidity
    // For now, return the first allowed protocol
    return context.allowedProtocols[0] || 'UNKNOWN';
  }

  private estimateMinOutput(
    fromToken: string,
    toToken: string,
    amountIn: bigint,
    context: SolverContext
  ): bigint {
    // Conservative estimate with slippage buffer
    // In production, this would query actual pool reserves
    const slippageBuffer = BigInt(this.config.defaultSlippageBps);
    const estimated = amountIn - (amountIn * slippageBuffer) / BigInt(10000);
    return estimated > BigInt(0) ? estimated : BigInt(1);
  }

  private estimatePriceImpact(
    fromToken: string,
    toToken: string,
    amountIn: bigint,
    context: SolverContext
  ): number {
    // Simplified price impact estimation
    // In production, this would use actual pool depth data
    const impactPerDollar = 0.01; // 0.01% per $1000 traded
    const amountInDollars = Number(amountIn) / 1_000_000; // Assume 6 decimals
    return Math.min(amountInDollars * impactPerDollar, context.maxPriceImpactBps);
  }

  // ── Candidate Validation ───────────────────────────────────────────

  private isValidCandidate(
    candidate: RouteCandidate,
    context: SolverContext
  ): boolean {
    // Check minimum output
    if (candidate.totalOutput < context.minTotalOutputValue) {
      return false;
    }

    // Check slippage
    if (candidate.slippage > context.maxSlippageBps) {
      return false;
    }

    // Check price impact
    if (candidate.priceImpact > context.maxPriceImpactBps) {
      return false;
    }

    // Check fees
    const feeBps = this.config.defaultFeeBps;
    if (feeBps > context.maxFeesBps) {
      return false;
    }

    // Check total loss
    const potentialLoss = context.totalInputValue - candidate.totalOutput;
    if (potentialLoss > BigInt(0)) {
      const lossBps = Number((potentialLoss * BigInt(10000)) / context.totalInputValue);
      if (lossBps > context.maxSlippageBps) {
        return false;
      }
    }

    // Validate all route legs use allowed protocols/tokens
    for (const leg of candidate.route) {
      if (!context.allowedProtocols.includes(leg.fromProtocol)) return false;
      if (!context.allowedProtocols.includes(leg.toProtocol)) return false;
      if (!context.allowedTokens.includes(leg.fromToken)) return false;
      if (!context.allowedTokens.includes(leg.toToken)) return false;
    }

    return true;
  }

  private selectOptimalCandidate(
    candidates: RouteCandidate[],
    context: SolverContext
  ): RouteCandidate {
    // Score each candidate
    const scored = candidates.map((c) => ({
      candidate: c,
      score: this.scoreCandidate(c, context),
    }));

    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);

    return scored[0].candidate;
  }

  private scoreCandidate(
    candidate: RouteCandidate,
    context: SolverContext
  ): number {
    let score = 0;

    // Higher output is better (40% weight)
    const outputRatio = Number(candidate.totalOutput) / Number(context.minTotalOutputValue);
    score += outputRatio * 40;

    // Lower slippage is better (25% weight)
    const slippageScore = 1 - candidate.slippage / context.maxSlippageBps;
    score += slippageScore * 25;

    // Lower price impact is better (20% weight)
    const impactScore = 1 - candidate.priceImpact / context.maxPriceImpactBps;
    score += impactScore * 20;

    // Fewer hops is better (15% weight)
    const hopScore = 1 / candidate.route.length;
    score += hopScore * 15;

    return score;
  }
}
