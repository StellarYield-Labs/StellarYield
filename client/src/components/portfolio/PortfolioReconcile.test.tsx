import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PortfolioReconcile, type ReconcileRow } from './PortfolioReconcile';

const MATCHED_ROWS: ReconcileRow[] = [
  { asset: 'USDC', expected: 1000, observed: 1000, delta: 0, severity: 'ok' },
];

const UNMATCHED_ROWS: ReconcileRow[] = [
  { asset: 'USDC', expected: 1000, observed: 940, delta: -60, severity: 'warning' },
];

const CRITICAL_ROWS: ReconcileRow[] = [
  { asset: 'USDC', expected: 1000, observed: 800, delta: -200, severity: 'critical' },
];

const MIXED_ROWS: ReconcileRow[] = [
  { asset: 'USDC', expected: 1000, observed: 1000, delta: 0, severity: 'ok' },
  { asset: 'XLM', expected: 5000, observed: 4800, delta: -200, severity: 'warning' },
  { asset: 'yBTC', expected: 0.5, observed: null, delta: null, severity: 'critical' },
];

const UNAVAILABLE_ROWS: ReconcileRow[] = [
  { asset: 'USDC', expected: 1000, observed: null, delta: null, severity: 'critical' },
];

describe('PortfolioReconcile', () => {
  describe('rendering matched rows', () => {
    it('renders asset, expected, observed, delta, and severity', () => {
      render(<PortfolioReconcile rows={MATCHED_ROWS} />);
      expect(screen.getByText('USDC')).toBeTruthy();
      expect(screen.getAllByText('1000').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('0')).toBeTruthy();
      expect(screen.getByText('ok')).toBeTruthy();
    });

    it('renders table headers', () => {
      render(<PortfolioReconcile rows={MATCHED_ROWS} />);
      expect(screen.getByText('Asset')).toBeTruthy();
      expect(screen.getByText('Expected')).toBeTruthy();
      expect(screen.getByText('Observed')).toBeTruthy();
      expect(screen.getByText('Delta')).toBeTruthy();
      expect(screen.getByText('Severity')).toBeTruthy();
    });
  });

  describe('rendering unmatched rows', () => {
    it('displays warning severity', () => {
      render(<PortfolioReconcile rows={UNMATCHED_ROWS} />);
      expect(screen.getByText('warning')).toBeTruthy();
      expect(screen.getByText('-60')).toBeTruthy();
    });

    it('applies severity CSS class', () => {
      render(<PortfolioReconcile rows={UNMATCHED_ROWS} />);
      const row = screen.getByText('USDC').closest('tr');
      expect(row?.className).toContain('sev-warning');
    });
  });

  describe('rendering critical rows', () => {
    it('displays critical severity', () => {
      render(<PortfolioReconcile rows={CRITICAL_ROWS} />);
      expect(screen.getByText('critical')).toBeTruthy();
    });

    it('applies critical CSS class', () => {
      render(<PortfolioReconcile rows={CRITICAL_ROWS} />);
      const row = screen.getByText('USDC').closest('tr');
      expect(row?.className).toContain('sev-critical');
    });
  });

  describe('null values (unavailable)', () => {
    it('renders em dash for null observed', () => {
      render(<PortfolioReconcile rows={UNAVAILABLE_ROWS} />);
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    });

    it('renders em dash for null delta', () => {
      render(<PortfolioReconcile rows={UNAVAILABLE_ROWS} />);
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBe(2);
    });
  });

  describe('mixed rows', () => {
    it('renders all rows', () => {
      render(<PortfolioReconcile rows={MIXED_ROWS} />);
      expect(screen.getByText('USDC')).toBeTruthy();
      expect(screen.getByText('XLM')).toBeTruthy();
      expect(screen.getByText('yBTC')).toBeTruthy();
    });

    it('renders correct number of body rows', () => {
      render(<PortfolioReconcile rows={MIXED_ROWS} />);
      const bodyRows = document.querySelectorAll('tbody tr');
      expect(bodyRows.length).toBe(3);
    });
  });

  describe('empty state', () => {
    it('renders table with no body rows when rows is empty', () => {
      render(<PortfolioReconcile rows={[]} />);
      const bodyRows = document.querySelectorAll('tbody tr');
      expect(bodyRows.length).toBe(0);
      expect(screen.getByText('Asset')).toBeTruthy();
    });
  });
});
