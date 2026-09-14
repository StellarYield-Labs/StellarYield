import { reconcilePortfolio, type ReconcileRow } from '../portfolioReconcileService';
import {
  MATCHED_POSITION,
  SMALL_DRIFT_POSITION,
  MATERIAL_DRIFT_POSITION,
  CRITICAL_DRIFT_POSITION,
  UNAVAILABLE_POSITION,
  MULTI_ASSET_POSITION,
  DUPLICATE_EVENT_POSITION,
  FEE_ONLY_SCENARIO,
} from '../../__tests__/fixtures/reconciliationFixtures';

describe('reconcilePortfolio — contract tests', () => {
  describe('matched scenario', () => {
    it('returns matched severity with zero delta', () => {
      const rows = reconcilePortfolio(MATCHED_POSITION.positions, MATCHED_POSITION.balances);
      expect(rows).toHaveLength(1);
      expect(rows[0].severity).toBe('matched');
      expect(rows[0].delta).toBe(0);
      expect(rows[0].observed).toBe(1000);
    });
  });

  describe('small drift scenario (< 5%)', () => {
    it('returns small severity', () => {
      const rows = reconcilePortfolio(SMALL_DRIFT_POSITION.positions, SMALL_DRIFT_POSITION.balances);
      expect(rows[0].severity).toBe('small');
      expect(rows[0].delta).toBe(-30);
      expect(rows[0].observed).toBe(970);
    });
  });

  describe('material drift scenario (< 15%)', () => {
    it('returns material severity', () => {
      const rows = reconcilePortfolio(MATERIAL_DRIFT_POSITION.positions, MATERIAL_DRIFT_POSITION.balances);
      expect(rows[0].severity).toBe('material');
      expect(rows[0].delta).toBe(-60);
    });
  });

  describe('critical drift scenario (>= 15%)', () => {
    it('returns critical severity', () => {
      const rows = reconcilePortfolio(CRITICAL_DRIFT_POSITION.positions, CRITICAL_DRIFT_POSITION.balances);
      expect(rows[0].severity).toBe('critical');
      expect(rows[0].delta).toBe(-200);
      expect(rows[0].deltaPct).toBeCloseTo(-0.2, 5);
    });
  });

  describe('unavailable provider scenario', () => {
    it('returns unavailable severity with null observed and delta', () => {
      const rows = reconcilePortfolio(UNAVAILABLE_POSITION.positions, UNAVAILABLE_POSITION.balances);
      expect(rows[0].severity).toBe('unavailable');
      expect(rows[0].observed).toBeNull();
      expect(rows[0].delta).toBeNull();
      expect(rows[0].deltaPct).toBeNull();
    });
  });

  describe('multi-asset scenario', () => {
    it('returns one row per asset', () => {
      const rows = reconcilePortfolio(MULTI_ASSET_POSITION.positions, MULTI_ASSET_POSITION.balances);
      expect(rows).toHaveLength(3);

      const usdc = rows.find(r => r.asset === 'USDC');
      const xlm = rows.find(r => r.asset === 'XLM');
      const btc = rows.find(r => r.asset === 'yBTC');

      expect(usdc!.severity).toBe('small');
      expect(usdc!.delta).toBe(-10);

      expect(xlm!.severity).toBe('small');
      expect(xlm!.delta).toBe(200);

      expect(btc!.severity).toBe('matched');
      expect(btc!.delta).toBe(0);
    });
  });

  describe('duplicate events scenario', () => {
    it('sums duplicate provider balances for the same asset', () => {
      const rows = reconcilePortfolio(DUPLICATE_EVENT_POSITION.positions, DUPLICATE_EVENT_POSITION.balances);
      expect(rows).toHaveLength(1);
      expect(rows[0].observed).toBe(1000);
      expect(rows[0].severity).toBe('matched');
      expect(rows[0].delta).toBe(0);
    });
  });

  describe('fee-only scenario', () => {
    it('detects small fee-driven delta', () => {
      const rows = reconcilePortfolio(FEE_ONLY_SCENARIO.positions, FEE_ONLY_SCENARIO.balances);
      expect(rows[0].severity).toBe('matched');
      expect(rows[0].delta).toBe(-3);
      expect(rows[0].observed).toBe(997);
    });
  });

  describe('response shape contract', () => {
    it('each row has all required fields', () => {
      const rows = reconcilePortfolio(MATCHED_POSITION.positions, MATCHED_POSITION.balances);
      const row = rows[0];
      expect(row).toHaveProperty('asset');
      expect(row).toHaveProperty('expected');
      expect(row).toHaveProperty('observed');
      expect(row).toHaveProperty('delta');
      expect(row).toHaveProperty('deltaPct');
      expect(row).toHaveProperty('severity');
      expect(typeof row.asset).toBe('string');
      expect(typeof row.expected).toBe('number');
    });

    it('severity is one of the allowed values', () => {
      const rows = reconcilePortfolio(MULTI_ASSET_POSITION.positions, MULTI_ASSET_POSITION.balances);
      const allowed = ['matched', 'small', 'material', 'critical', 'unavailable'];
      for (const row of rows) {
        expect(allowed).toContain(row.severity);
      }
    });
  });

  describe('edge cases', () => {
    it('handles zero expected with zero observed', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'EMPTY', expected: 0 }],
        [{ provider: 'P1', asset: 'EMPTY', balance: 0 }]
      );
      expect(rows[0].severity).toBe('matched');
      expect(rows[0].delta).toBe(0);
    });

    it('handles zero expected with non-zero observed', () => {
      const rows = reconcilePortfolio(
        [{ asset: 'NEW', expected: 0 }],
        [{ provider: 'P1', asset: 'NEW', balance: 100 }]
      );
      expect(rows[0].observed).toBe(100);
      expect(rows[0].delta).toBe(100);
    });

    it('handles empty positions array', () => {
      const rows = reconcilePortfolio([], []);
      expect(rows).toEqual([]);
    });
  });
});
