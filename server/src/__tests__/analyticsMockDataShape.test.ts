import {
  AnalyticsMockDataGenerator,
  REQUIRED_ANALYTICS_FIELDS,
  validateRequiredFields,
} from './fixtures/analyticsMockData';

describe('Analytics Mock Data Shape Validation', () => {
  describe('Attribution Report Shape', () => {
    it('contains all required top-level fields', () => {
      const report = AnalyticsMockDataGenerator.createAttributionReport('G_TEST_WALLET');
      const validation = validateRequiredFields(
        report,
        REQUIRED_ANALYTICS_FIELDS.attributionReport
      );

      expect(validation.valid).toBe(true);
      expect(validation.missingFields).toEqual([]);
    });

    it('contains required breakdown item fields', () => {
      const report = AnalyticsMockDataGenerator.createAttributionReport('G_TEST_WALLET');
      expect(report.attributionBreakdown.length).toBeGreaterThan(0);

      for (const item of report.attributionBreakdown) {
        const validation = validateRequiredFields(
          item,
          REQUIRED_ANALYTICS_FIELDS.attributionBreakdown
        );
        expect(validation.valid).toBe(true);
      }
    });

    it('fails validation when a required field is removed', () => {
      const report = AnalyticsMockDataGenerator.createAttributionReport('G_TEST_WALLET');
      const { walletAddress, ...incompleteReport } = report as any;

      const validation = validateRequiredFields(
        incompleteReport,
        REQUIRED_ANALYTICS_FIELDS.attributionReport
      );

      expect(validation.valid).toBe(false);
      expect(validation.missingFields).toContain('walletAddress');
    });

    it('does not fail when optional field rewardSourceMix is omitted', () => {
      const report = AnalyticsMockDataGenerator.createEmptyAttributionReport('G_TEST_WALLET');
      delete (report as any).rewardSourceMix;

      const validation = validateRequiredFields(
        report,
        REQUIRED_ANALYTICS_FIELDS.attributionReport
      );

      expect(validation.valid).toBe(true);
    });
  });

  describe('Compatibility Report Shape', () => {
    it('contains all required top-level fields', () => {
      const report = AnalyticsMockDataGenerator.createCompatibilityReport();
      const validation = validateRequiredFields(
        report,
        REQUIRED_ANALYTICS_FIELDS.compatibilityReport
      );

      expect(validation.valid).toBe(true);
      expect(validation.missingFields).toEqual([]);
    });

    it('contains required protocol item fields', () => {
      const report = AnalyticsMockDataGenerator.createCompatibilityReport();
      expect(report.protocols.length).toBeGreaterThan(0);

      for (const item of report.protocols) {
        const validation = validateRequiredFields(
          item,
          REQUIRED_ANALYTICS_FIELDS.compatibilityProtocol
        );
        expect(validation.valid).toBe(true);
      }
    });

    it('contains required issue item fields', () => {
      const report = AnalyticsMockDataGenerator.createCompatibilityReport();
      expect(report.issues.length).toBeGreaterThan(0);

      for (const item of report.issues) {
        const validation = validateRequiredFields(
          item,
          REQUIRED_ANALYTICS_FIELDS.compatibilityIssue
        );
        expect(validation.valid).toBe(true);
      }
    });

    it('fails validation when a required field is removed', () => {
      const report = AnalyticsMockDataGenerator.createCompatibilityReport();
      const { overallStatus, ...incompleteReport } = report as any;

      const validation = validateRequiredFields(
        incompleteReport,
        REQUIRED_ANALYTICS_FIELDS.compatibilityReport
      );

      expect(validation.valid).toBe(false);
      expect(validation.missingFields).toContain('overallStatus');
    });
  });

  describe('Health Score Shape', () => {
    it('contains all required health score fields and nested metrics', () => {
      const score = AnalyticsMockDataGenerator.createHealthScore('strat_01');
      const scoreValidation = validateRequiredFields(
        score,
        REQUIRED_ANALYTICS_FIELDS.healthScore
      );

      expect(scoreValidation.valid).toBe(true);

      const metricsValidation = validateRequiredFields(
        score.metrics,
        REQUIRED_ANALYTICS_FIELDS.healthScoreMetrics
      );

      expect(metricsValidation.valid).toBe(true);
    });

    it('fails fast if strategyId is missing', () => {
      const score = AnalyticsMockDataGenerator.createHealthScore('strat_01');
      delete (score as any).strategyId;

      const validation = validateRequiredFields(
        score,
        REQUIRED_ANALYTICS_FIELDS.healthScore
      );

      expect(validation.valid).toBe(false);
      expect(validation.missingFields).toContain('strategyId');
    });
  });

  describe('Reliability Score Shape', () => {
    it('contains all required fields and metrics', () => {
      const score = AnalyticsMockDataGenerator.createReliabilityScore('provider_01');
      const scoreValidation = validateRequiredFields(
        score,
        REQUIRED_ANALYTICS_FIELDS.reliabilityScore
      );

      expect(scoreValidation.valid).toBe(true);

      const metricsValidation = validateRequiredFields(
        score.metrics,
        REQUIRED_ANALYTICS_FIELDS.reliabilityScoreMetrics
      );

      expect(metricsValidation.valid).toBe(true);
    });

    it('fails fast if providerId is missing', () => {
      const score = AnalyticsMockDataGenerator.createReliabilityScore('provider_01');
      delete (score as any).providerId;

      const validation = validateRequiredFields(
        score,
        REQUIRED_ANALYTICS_FIELDS.reliabilityScore
      );

      expect(validation.valid).toBe(false);
      expect(validation.missingFields).toContain('providerId');
    });
  });

  describe('State Transition Graph Shape', () => {
    it('contains all required fields', () => {
      const graph = AnalyticsMockDataGenerator.createStateTransitionGraph('strat_01');
      const validation = validateRequiredFields(
        graph,
        REQUIRED_ANALYTICS_FIELDS.stateTransitionGraph
      );

      expect(validation.valid).toBe(true);
    });
  });

  describe('Recommendation Stability Report Shape', () => {
    it('contains all required fields', () => {
      const report = AnalyticsMockDataGenerator.createRecommendationStabilityReport();
      const validation = validateRequiredFields(
        report,
        REQUIRED_ANALYTICS_FIELDS.recommendationStabilityReport
      );

      expect(validation.valid).toBe(true);
    });
  });
});
