# Reconciliation Response Contract

This document describes the canonical response shapes for portfolio reconciliation and activity timeline endpoints. Use these fixtures as the source of truth when adding new reconciliation scenarios or tests.

## Portfolio Reconciliation

### ReconcileRow Shape

Each reconciliation response contains an array of `ReconcileRow` objects:

```typescript
interface ReconcileRow {
  asset: string;           // Asset identifier (e.g. "USDC", "XLM")
  expected: number;        // Expected balance from the vault position
  observed: number | null; // Sum of provider balances (null if unavailable)
  delta: number | null;    // observed - expected (null if unavailable)
  deltaPct: number | null; // delta / |expected| (null if unavailable or zero-expected edge case)
  severity: 'matched' | 'small' | 'material' | 'critical' | 'unavailable';
}
```

### Severity Thresholds

| Severity | Condition | Description |
|----------|-----------|-------------|
| `matched` | `|deltaPct| < 1%` | Positions agree within tolerance |
| `small` | `|deltaPct| < 5%` | Minor drift, usually fees or timing |
| `material` | `|deltaPct| < 15%` | Significant discrepancy, investigate |
| `critical` | `|deltaPct| >= 15%` | Major mismatch, requires attention |
| `unavailable` | No provider balance found | Provider data unavailable |

### Fixture Locations

- `server/src/__tests__/fixtures/reconciliationFixtures.ts` — All canonical scenarios

### Adding a New Reconciliation Case

1. Add a fixture to `reconciliationFixtures.ts`:
   ```typescript
   export const MY_NEW_SCENARIO = {
     positions: [{ asset: 'USDC', expected: 1000 }],
     balances: [{ provider: 'NewProvider', asset: 'USDC', balance: 950 }],
   };
   ```

2. Add a server test in `server/src/services/__tests__/portfolioReconcileService.contract.test.ts`:
   ```typescript
   describe('my new scenario', () => {
     it('returns expected severity', () => {
       const rows = reconcilePortfolio(MY_NEW_SCENARIO.positions, MY_NEW_SCENARIO.balances);
       expect(rows[0].severity).toBe('material');
     });
   });
   ```

3. If the scenario affects the UI, add a client test in `client/src/components/portfolio/PortfolioReconcile.test.tsx`.

## Activity Timeline

### Event Shape

```typescript
interface AccountActivityEvent {
  id: string;
  walletAddress: string;
  type: 'deposit' | 'withdrawal' | 'reward' | 'recommendation' | 'alert' | 'rebalance';
  title: string;
  description: string;
  timestamp: string;  // ISO 8601
  source: string;
  amountUsd?: number;
  assetSymbol?: string;
  severity?: string;
  relatedVaultId?: string;
}
```

### API Contract

- **Endpoint:** `GET /api/portfolio/activity/:walletAddress`
- **Query:** `?types=deposit,withdrawal` (optional, comma-separated)
- **Response:** `{ walletAddress: string, timeline: AccountActivityEvent[] }`
- **Error:** `{ error: string }` with status 400 for invalid types

### Adding a New Activity Type

1. Add the type to `VALID_TYPES` in `server/src/routes/activityTimeline.ts`
2. Add the type to `AccountActivityEventType` in `server/src/services/accountActivityTimelineService.ts`
3. Add fixture events to `reconciliationFixtures.ts`
4. Add server route test in `server/src/routes/__tests__/activityTimeline.contract.test.ts`
5. Add client rendering test in `client/src/components/portfolio/UnifiedActivityTimeline.test.tsx`
