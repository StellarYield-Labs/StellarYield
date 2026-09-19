// server/src/__tests__/fixtures/reconciliationFixtures.ts
// Canonical reconciliation response fixtures for contract testing.

export interface ReconcileRow {
  asset: string;
  expected: number;
  observed: number | null;
  delta: number | null;
  deltaPct: number | null;
  severity: 'matched' | 'small' | 'material' | 'critical' | 'unavailable';
}

export interface ActivityEvent {
  id: string;
  walletAddress: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  source: string;
  amountUsd?: number;
  assetSymbol?: string;
  severity?: string;
  relatedVaultId?: string;
}

// --- Reconciliation scenarios ---

export const MATCHED_POSITION: { positions: { asset: string; expected: number }[]; balances: { provider: string; asset: string; balance: number }[] } = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [{ provider: 'Blend', asset: 'USDC', balance: 1000 }],
};

export const SMALL_DRIFT_POSITION = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [{ provider: 'Blend', asset: 'USDC', balance: 970 }],
};

export const MATERIAL_DRIFT_POSITION = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [{ provider: 'Blend', asset: 'USDC', balance: 940 }],
};

export const CRITICAL_DRIFT_POSITION = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [{ provider: 'Blend', asset: 'USDC', balance: 800 }],
};

export const UNAVAILABLE_POSITION = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [] as { provider: string; asset: string; balance: number }[],
};

export const MULTI_ASSET_POSITION = {
  positions: [
    { asset: 'USDC', expected: 1000 },
    { asset: 'XLM', expected: 5000 },
    { asset: 'yBTC', expected: 0.5 },
  ],
  balances: [
    { provider: 'Blend', asset: 'USDC', balance: 990 },
    { provider: 'Soroswap', asset: 'XLM', balance: 5200 },
    { provider: 'Blend', asset: 'yBTC', balance: 0.5 },
  ],
};

export const DUPLICATE_EVENT_POSITION = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [
    { provider: 'Blend', asset: 'USDC', balance: 600 },
    { provider: 'Blend', asset: 'USDC', balance: 400 },
  ],
};

export const FEE_ONLY_SCENARIO = {
  positions: [{ asset: 'USDC', expected: 1000 }],
  balances: [{ provider: 'Blend', asset: 'USDC', balance: 997 }],
};

// --- Activity timeline scenarios ---

export const EMPTY_TIMELINE: ActivityEvent[] = [];

export const SINGLE_DEPOSIT_EVENT: ActivityEvent[] = [
  {
    id: 'evt-1',
    walletAddress: 'GTESTWALLET',
    type: 'deposit',
    title: 'Deposited USDC into Blend Stable',
    description: 'Capital routed into Blend Stable for yield capture.',
    timestamp: '2026-05-26T08:15:00.000Z',
    source: 'portfolio',
    amountUsd: 5000,
    assetSymbol: 'USDC',
  },
];

export const MULTI_TYPE_EVENTS: ActivityEvent[] = [
  {
    id: 'evt-1',
    walletAddress: 'GTESTWALLET',
    type: 'deposit',
    title: 'Deposited USDC',
    description: 'Capital routed into Blend.',
    timestamp: '2026-05-26T08:15:00.000Z',
    source: 'portfolio',
    amountUsd: 5000,
    assetSymbol: 'USDC',
  },
  {
    id: 'evt-2',
    walletAddress: 'GTESTWALLET',
    type: 'withdrawal',
    title: 'Withdrew XLM',
    description: 'Redeemed from Soroswap pool.',
    timestamp: '2026-05-26T10:30:00.000Z',
    source: 'portfolio',
    amountUsd: 1200,
    assetSymbol: 'XLM',
  },
  {
    id: 'evt-3',
    walletAddress: 'GTESTWALLET',
    type: 'reward',
    title: 'Reward accrued',
    description: 'YIELD rewards refreshed.',
    timestamp: '2026-05-26T12:00:00.000Z',
    source: 'rewards',
    amountUsd: 84.5,
    assetSymbol: 'YIELD',
  },
];

export const TIMESTAMP_ORDERED_EVENTS: ActivityEvent[] = [
  {
    id: 'evt-newest',
    walletAddress: 'GTESTWALLET',
    type: 'deposit',
    title: 'Latest deposit',
    description: 'Most recent event.',
    timestamp: '2026-05-26T12:00:00.000Z',
    source: 'portfolio',
  },
  {
    id: 'evt-middle',
    walletAddress: 'GTESTWALLET',
    type: 'reward',
    title: 'Middle reward',
    description: 'Middle event.',
    timestamp: '2026-05-26T08:00:00.000Z',
    source: 'rewards',
  },
  {
    id: 'evt-oldest',
    walletAddress: 'GTESTWALLET',
    type: 'withdrawal',
    title: 'Oldest withdrawal',
    description: 'Oldest event.',
    timestamp: '2026-05-25T20:00:00.000Z',
    source: 'portfolio',
  },
];

export const CRITICAL_SEVERITY_EVENT: ActivityEvent[] = [
  {
    id: 'evt-alert',
    walletAddress: 'GTESTWALLET',
    type: 'alert',
    title: 'Yield freshness lag',
    description: 'Staleness exceeded 12 hours.',
    timestamp: '2026-05-26T06:00:00.000Z',
    source: 'monitoring',
    severity: 'critical',
  },
];

// --- Error response shapes ---

export const INVALID_TYPE_ERROR_RESPONSE = {
  error: 'Unknown activity types: invalid_type',
};

export const INVALID_MULTIPLE_TYPES_ERROR_RESPONSE = {
  error: 'Unknown activity types: bad1, bad2',
};
