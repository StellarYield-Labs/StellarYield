import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { vi } from 'vitest';
import YieldCalculator, { MetricCard } from '../YieldCalculator';
import {
  calculateCompoundProjection,
  calculateProjectionMetrics,
  formatCurrency,
} from '../compoundMath';

const DECIMAL_AMOUNT_FIXTURE = {
  initialPrincipal: 1234.56,
  initialMonthlyContribution: 100.25,
  initialApy: 8.5,
  initialYears: 1,
} as const;

const INTEGER_AMOUNT_FIXTURE = {
  initialPrincipal: 10000,
  initialMonthlyContribution: 500,
  initialApy: 8.5,
  initialYears: 5,
} as const;

// Mock Recharts to avoid rendering issues in tests
vi.mock('recharts', () => ({
  AreaChart: ({ children }: { children: React.ReactNode }) => <div data-testid="area-chart">{children}</div>,
  Area: () => <div data-testid="area" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: ({ content }: { content: React.ReactNode }) => <div data-testid="tooltip">{content}</div>,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive-container">{children}</div>,
  Legend: () => <div data-testid="legend" />,
}));

describe('YieldCalculator Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the calculator with default values', () => {
    render(<YieldCalculator />);
    
    expect(screen.getByText('Yield Calculator')).toBeInTheDocument();
    expect(screen.getByText('Project your wealth with compound interest')).toBeInTheDocument();
    expect(screen.getByText('$10,000')).toBeInTheDocument(); // Default principal
    expect(screen.getByText('$500')).toBeInTheDocument(); // Default monthly contribution
    expect(screen.getByText('8.5%')).toBeInTheDocument(); // Default APY
    expect(screen.getByText('5y')).toBeInTheDocument(); // Default years
  });

  it('should update when principal slider changes', async () => {
    render(<YieldCalculator />);
    
    const principalSlider = screen.getByDisplayValue('10000');
    fireEvent.change(principalSlider, { target: { value: '25000' } });
    
    await waitFor(() => {
      expect(screen.getByText('$25,000')).toBeInTheDocument();
    });
  });

  it('should update when monthly contribution slider changes', async () => {
    render(<YieldCalculator />);
    
    const contributionSlider = screen.getByDisplayValue('500');
    fireEvent.change(contributionSlider, { target: { value: '1000' } });
    
    await waitFor(() => {
      expect(screen.getByText('$1,000')).toBeInTheDocument();
    });
  });

  it('should update when APY slider changes', async () => {
    render(<YieldCalculator />);
    
    const apySlider = screen.getByDisplayValue('8.5');
    fireEvent.change(apySlider, { target: { value: '12.5' } });
    
    await waitFor(() => {
      expect(screen.getByText('12.5%')).toBeInTheDocument();
    });
  });

  it('should update when years slider changes', async () => {
    render(<YieldCalculator />);
    
    const yearsSlider = screen.getByDisplayValue('5');
    fireEvent.change(yearsSlider, { target: { value: '10' } });
    
    await waitFor(() => {
      expect(screen.getByText('10y')).toBeInTheDocument();
    });
  });

  it('should display metrics cards', () => {
    render(<YieldCalculator />);
    
    expect(screen.getByText('Final Value')).toBeInTheDocument();
    expect(screen.getByText('Total Contributed')).toBeInTheDocument();
    expect(screen.getByText('Interest Earned')).toBeInTheDocument();
    expect(screen.getByText('Total Return')).toBeInTheDocument();
  });

  it('should show timeframe selector', () => {
    render(<YieldCalculator />);
    
    expect(screen.getByText('Timeframe:')).toBeInTheDocument();
    expect(screen.getByText('1 Year')).toBeInTheDocument();
    expect(screen.getByText('5 Years')).toBeInTheDocument();
    expect(screen.getByText('10 Years')).toBeInTheDocument();
  });

  it('should switch timeframes when clicked', async () => {
    render(<YieldCalculator />);
    
    const oneYearButton = screen.getByText('1 Year');
    fireEvent.click(oneYearButton);
    
    await waitFor(() => {
      expect(oneYearButton).toHaveClass('bg-indigo-500');
    });
  });

  it('should render chart components', () => {
    render(<YieldCalculator />);
    
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('x-axis')).toBeInTheDocument();
    expect(screen.getByTestId('y-axis')).toBeInTheDocument();
    expect(screen.getByTestId('cartesian-grid')).toBeInTheDocument();
    expect(screen.getByTestId('legend')).toBeInTheDocument();
  });

  it('should show tooltip on hover', () => {
    const { container } = render(<YieldCalculator />);
    
    // Find the info icon within the APY section
    const infoIcon = container.querySelector('div[class*="relative"] svg');
    if (infoIcon) {
      fireEvent.mouseEnter(infoIcon);
      expect(screen.getByText(/Annual Percentage Yield with daily compounding/)).toBeInTheDocument();
    }
  });

  it('should display annualized return information', () => {
    render(<YieldCalculator />);
    
    expect(screen.getByText('Annualized Return')).toBeInTheDocument();
    expect(screen.getByText('Equivalent annual return rate over the entire period')).toBeInTheDocument();
  });

  it('should update timeframe automatically when years change', async () => {
    render(<YieldCalculator />);
    
    const yearsSlider = screen.getByDisplayValue('5');
    fireEvent.change(yearsSlider, { target: { value: '15' } });
    
    await waitFor(() => {
      const tenYearsButton = screen.getByText('10 Years');
      expect(tenYearsButton).toHaveClass('bg-indigo-500');
    });
  });

  it('should handle edge case values', () => {
    render(<YieldCalculator />);
    
    // Set minimum values
    const principalSlider = screen.getByDisplayValue('10000');
    const contributionSlider = screen.getByDisplayValue('500');
    const apySlider = screen.getByDisplayValue('8.5');
    const yearsSlider = screen.getByDisplayValue('5');
    
    fireEvent.change(principalSlider, { target: { value: '0' } });
    fireEvent.change(contributionSlider, { target: { value: '0' } });
    fireEvent.change(apySlider, { target: { value: '0' } });
    fireEvent.change(yearsSlider, { target: { value: '1' } });
    
    // Check that sliders have been updated (multiple elements with value 0 is expected)
    const zeroValueSliders = screen.getAllByDisplayValue('0');
    expect(zeroValueSliders.length).toBeGreaterThan(0);
    
    // Check APY and years
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.getByText('1y')).toBeInTheDocument();
  });

  it('should handle large values', async () => {
    render(<YieldCalculator />);
    
    const principalSlider = screen.getByDisplayValue('10000');
    const contributionSlider = screen.getByDisplayValue('500');
    
    fireEvent.change(principalSlider, { target: { value: '100000' } });
    fireEvent.change(contributionSlider, { target: { value: '5000' } });
    
    await waitFor(() => {
      expect(screen.getByText('$100,000')).toBeInTheDocument();
      expect(screen.getByText('$5,000')).toBeInTheDocument();
    });
  });

  it('should show error state for invalid initial deposit', () => {
    render(<YieldCalculator initialPrincipal={-1000} />);
    
    expect(screen.getByText('Please correct the following errors:')).toBeInTheDocument();
    expect(screen.getByText('Initial deposit cannot be negative')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Final Value')).not.toBeInTheDocument();
  });

  it('should show error state for invalid duration (less than 1 year) with no NaN displayed', () => {
    render(<YieldCalculator initialYears={0} />);
    
    expect(screen.getByText('Please correct the following errors:')).toBeInTheDocument();
    expect(screen.getByText('Time horizon must be at least 1 year')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Final Value')).not.toBeInTheDocument();
  });

  it('should show error state for negative duration with no NaN displayed', () => {
    render(<YieldCalculator initialYears={-5} />);
    
    expect(screen.getByText('Please correct the following errors:')).toBeInTheDocument();
    expect(screen.getByText('Time horizon must be at least 1 year')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Final Value')).not.toBeInTheDocument();
  });

  it('should show error state for invalid duration exceeding maximum limit with no NaN displayed', () => {
    render(<YieldCalculator initialYears={55} />);
    
    expect(screen.getByText('Please correct the following errors:')).toBeInTheDocument();
    expect(screen.getByText('Time horizon exceeds maximum limit')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Final Value')).not.toBeInTheDocument();
  });

  it('should show error state when duration is NaN with no NaN displayed', () => {
    render(<YieldCalculator initialYears={NaN} />);
    
    expect(screen.getByText('Please correct the following errors:')).toBeInTheDocument();
    expect(screen.getByText('Time horizon must be at least 1 year')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Final Value')).not.toBeInTheDocument();
  });

  it('should have proper accessibility attributes', () => {
    render(<YieldCalculator />);
    
    // Check for proper labels and ARIA attributes
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(4); // 4 input sliders
    
    // Check for proper button roles
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('should be responsive to different screen sizes', () => {
    // Mock different screen sizes
    global.innerWidth = 500;
    global.dispatchEvent(new Event('resize'));
    
    render(<YieldCalculator />);
    
    // Component should render without issues on small screens
    expect(screen.getByText('Yield Calculator')).toBeInTheDocument();
    
    // Reset to default
    global.innerWidth = 1024;
    global.dispatchEvent(new Event('resize'));
  });

  it('formats decimal deposit amounts and projected yield consistently', () => {
    const config = {
      principal: DECIMAL_AMOUNT_FIXTURE.initialPrincipal,
      monthlyContribution: DECIMAL_AMOUNT_FIXTURE.initialMonthlyContribution,
      apy: DECIMAL_AMOUNT_FIXTURE.initialApy,
      years: DECIMAL_AMOUNT_FIXTURE.initialYears,
    };
    const metrics = calculateProjectionMetrics(calculateCompoundProjection(config));
    const formattedDeposit = formatCurrency(config.principal);
    const formattedProjectedYield = formatCurrency(metrics.finalValue);

    render(<YieldCalculator {...DECIMAL_AMOUNT_FIXTURE} />);

    expect(formattedDeposit).toBe('$1,234.56');
    expect(screen.getByText(formattedDeposit)).toBeInTheDocument();
    expect(formattedProjectedYield).toBe('$2,595.36');
    expect(screen.getByTestId('projected-yield')).toHaveTextContent('$2,595.36');
  });

  it('keeps integer amount formatting unchanged', () => {
    render(<YieldCalculator {...INTEGER_AMOUNT_FIXTURE} />);

    expect(formatCurrency(INTEGER_AMOUNT_FIXTURE.initialPrincipal)).toBe('$10,000');
    expect(formatCurrency(INTEGER_AMOUNT_FIXTURE.initialMonthlyContribution)).toBe('$500');
    expect(screen.getByText('$10,000')).toBeInTheDocument();
    expect(screen.getByText('$500')).toBeInTheDocument();
  });
});

describe('MetricCard Component', () => {
  it('should render metric card with correct content', () => {
    render(<MetricCard label="Test Label" value="$1,000" color="text-green-400" />);
    
    expect(screen.getByText('Test Label')).toBeInTheDocument();
    expect(screen.getByText('$1,000')).toBeInTheDocument();
    
    const card = screen.getByText('Test Label').closest('div');
    expect(card).toHaveClass('bg-slate-800/50', 'rounded-lg', 'p-4');
    
    const value = screen.getByText('$1,000');
    expect(value).toHaveClass('text-xl', 'font-bold', 'text-green-400');
  });

  it('should apply different colors correctly', () => {
    render(<MetricCard label="APY" value="8.5%" color="text-blue-400" />);
    
    const value = screen.getByText('8.5%');
    expect(value).toHaveClass('text-blue-400');
  });
});
