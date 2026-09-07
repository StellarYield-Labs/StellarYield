export interface LiquidityBucket {
  immediate: number;
  pendingExits: number;
  delayedSettlement: number;
}

export interface RouteOption {
  id: string;
  type: 'immediate' | 'delayed' | 'partial';
  estimatedDelaySeconds: number;
  feeBasisPoints: number;
  netOutputAmount: number;
  isBlocked: boolean;
  blockingReason?: string;
}

export function routeWithdrawal(requestedAmount: number, bucket: LiquidityBucket): RouteOption[] {
  const options: RouteOption[] = [];

  if (requestedAmount <= bucket.immediate) {
    options.push({
      id: 'route-immediate',
      type: 'immediate',
      estimatedDelaySeconds: 0,
      feeBasisPoints: 10,
      netOutputAmount: requestedAmount * 0.999,
      isBlocked: false,
    });
  } else if (requestedAmount <= bucket.immediate + bucket.delayedSettlement) {
    options.push({
      id: 'route-delayed',
      type: 'delayed',
      estimatedDelaySeconds: 86400,
      feeBasisPoints: 5,
      netOutputAmount: requestedAmount * 0.9995,
      isBlocked: false,
    });
  } else {
    options.push({
      id: 'route-blocked',
      type: 'partial',
      estimatedDelaySeconds: 0,
      feeBasisPoints: 0,
      netOutputAmount: 0,
      isBlocked: true,
      blockingReason: 'Insufficient total vault liquidity across immediate and delayed settlement routes.',
    });
  }

  return options;
}
