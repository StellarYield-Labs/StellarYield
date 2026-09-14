import NodeCache from "node-cache";
import { freezeService } from "./freezeService";
import {
  AdapterObservation,
  createDefaultProtocolAdapterRegistry,
  ProtocolAdapter,
  ProtocolCapability,
} from "./protocolAdapters";

// ── Types ───────────────────────────────────────────────────────────────

export interface ProtocolVersion {
  protocolName: string;
  version: string;
  contractAddress?: string;
  apiVersion?: string;
  lastUpdated: string;
  checksum?: string;
}

export interface CompatibilityRequirement {
  component: string;
  requiredVersion: string;
  minVersion: string;
  maxVersion?: string;
  criticalFeatures: string[];
  breakingChanges: string[];
}

export interface CompatibilityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  component: string;
  issue: string;
  impact: string;
  recommendation: string;
  affectedStrategies: string[];
}

export interface CompatibilityStatus {
  protocolName: string;
  currentVersion: string;
  latestVersion: string;
  status: 'compatible' | 'degraded' | 'incompatible';
  issues: CompatibilityIssue[];
  lastChecked: string;
  recommendations: string[];
  autoUpdateAvailable: boolean;
  safeUnwindAvailable?: boolean;
  adapterObservation?: AdapterObservation;
}

export interface CompatibilityReport {
  overallStatus: 'compatible' | 'degraded' | 'incompatible';
  protocols: CompatibilityStatus[];
  criticalIssues: CompatibilityIssue[];
  generatedAt: string;
  nextCheckDue: string;
}

export interface CompatibilityConfig {
  checkIntervalMinutes: number;
  criticalFailureThreshold: number;
  autoDisableIncompatible: boolean;
  notifyOnDegraded: boolean;
  cacheResultsMinutes: number;
}

// ── Configuration ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: CompatibilityConfig = {
  checkIntervalMinutes: 60,
  criticalFailureThreshold: 1,
  autoDisableIncompatible: true,
  notifyOnDegraded: true,
  cacheResultsMinutes: 30,
};

const cache = new NodeCache({
  stdTTL: DEFAULT_CONFIG.cacheResultsMinutes * 60,
  checkperiod: 60,
  useClones: false,
});

// ── Compatibility Engine ────────────────────────────────────────────────

export class ProtocolCompatibilityEngine {
  private config: CompatibilityConfig;
  private requirements: Map<string, CompatibilityRequirement[]>;
  private adapters: Map<string, ProtocolAdapter>;

  constructor(config: Partial<CompatibilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.requirements = new Map();
    this.adapters = createDefaultProtocolAdapterRegistry();
    this.initializeRequirements();
  }

  /**
   * Initialize compatibility requirements for known protocols
   */
  private initializeRequirements(): void {
    // Blend Protocol Requirements
    this.requirements.set('Blend', [
      {
        component: 'core_contract',
        requiredVersion: '2.1.0',
        minVersion: '2.0.0',
        criticalFeatures: ['deposit', 'withdraw', 'get_apy'],
        breakingChanges: ['fee_structure_change', 'withdrawal_delay'],
      },
      {
        component: 'api',
        requiredVersion: 'v1.3',
        minVersion: 'v1.0',
        criticalFeatures: ['yield_data', 'vault_info'],
        breakingChanges: ['endpoint_deprecation', 'response_format_change'],
      },
    ]);

    // Soroswap Requirements
    this.requirements.set('Soroswap', [
      {
        component: 'router_contract',
        requiredVersion: '1.4.2',
        minVersion: '1.3.0',
        criticalFeatures: ['swap_exact_tokens', 'get_amount_out'],
        breakingChanges: ['fee_calculation_change', 'slippage_formula_update'],
      },
      {
        component: 'pool_contract',
        requiredVersion: '1.2.1',
        minVersion: '1.1.0',
        criticalFeatures: ['add_liquidity', 'remove_liquidity'],
        breakingChanges: ['reward_distribution_change'],
      },
    ]);

    // DeFindex Requirements
    this.requirements.set('DeFindex', [
      {
        component: 'index_contract',
        requiredVersion: '3.0.1',
        minVersion: '2.5.0',
        maxVersion: '3.1.0',
        criticalFeatures: ['mint', 'redeem', 'rebalance'],
        breakingChanges: ['index_composition_change', 'fee_structure_overhaul'],
      },
    ]);
  }

  /**
   * Run comprehensive compatibility check
   */
  async runCompatibilityCheck(): Promise<CompatibilityReport> {
    const cacheKey = 'compatibility:report';
    const cached = cache.get<CompatibilityReport>(cacheKey);
    
    if (cached) {
      return cached;
    }

    if (freezeService.isFrozen()) {
      throw new Error("Compatibility service is frozen");
    }

    try {
      const protocols = await this.checkAllProtocols();
      const criticalIssues = protocols
        .flatMap(p => p.issues)
        .filter(issue => issue.severity === 'critical');

      const overallStatus = this.determineOverallStatus(protocols, criticalIssues);

      const report: CompatibilityReport = {
        overallStatus,
        protocols,
        criticalIssues,
        generatedAt: new Date().toISOString(),
        nextCheckDue: new Date(Date.now() + this.config.checkIntervalMinutes * 60 * 1000).toISOString(),
      };

      cache.set(cacheKey, report);
      
      // Auto-disable incompatible protocols if configured
      if (this.config.autoDisableIncompatible) {
        await this.handleIncompatibleProtocols(protocols);
      }

      return report;
    } catch (error) {
      console.error("Compatibility check failed:", error);
      throw new Error(`Compatibility check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check compatibility for all known protocols
   */
  private async checkAllProtocols(): Promise<CompatibilityStatus[]> {
    const protocolNames = Array.from(this.adapters.keys());
    const checks = protocolNames.map(name => this.checkProtocol(name));
    
    return Promise.all(checks);
  }

  /**
   * Check compatibility for a specific protocol
   */
  async checkProtocol(protocolName: string): Promise<CompatibilityStatus> {
    const adapter = this.adapters.get(protocolName);
    if (!adapter) {
      throw new Error(`No production protocol adapter registered for ${protocolName}`);
    }

    try {
      const observation = await adapter.attest();
      const issues = this.issuesFromAdapterObservation(observation);
      const status = observation.state === 'healthy'
        ? this.determineProtocolStatus(issues)
        : observation.state === 'degraded'
          ? 'degraded'
          : 'incompatible';
      const recommendations = this.generateRecommendations(issues, status);

      return {
        protocolName,
        currentVersion: observation.version,
        latestVersion: adapter.manifest.version,
        status,
        issues,
        lastChecked: observation.checkedAt,
        recommendations,
        autoUpdateAvailable: false,
        safeUnwindAvailable: observation.safeUnwindAvailable,
        adapterObservation: observation,
      };
    } catch (error) {
      console.error('Failed to attest protocol adapter:', { protocolName });
      return {
        protocolName,
        currentVersion: 'unknown',
        latestVersion: 'unknown',
        status: 'incompatible' as const,
        issues: [{
          severity: 'critical' as const,
          component: 'unknown',
          issue: 'Failed to attest protocol adapter',
          impact: 'Cannot determine compatibility',
          recommendation: 'Check protocol adapter manifest, RPC connectivity, and contract deployment',
          affectedStrategies: [],
        }],
        lastChecked: new Date().toISOString(),
        recommendations: ['Check protocol adapter manifest, RPC connectivity, and contract deployment'],
        autoUpdateAvailable: false,
        safeUnwindAvailable: false,
      };
    }
  }

  private issuesFromAdapterObservation(observation: AdapterObservation): CompatibilityIssue[] {
    const issues: CompatibilityIssue[] = [];
    const requiredCapabilities = new Set(
      this.adapters.get(observation.protocolName)?.manifest.requiredCapabilities ?? [],
    );

    for (const error of observation.errors) {
      issues.push({
        severity: error.retryable ? 'high' : 'critical',
        component: observation.contractId,
        issue: error.code,
        impact: error.retryable
          ? error.message
          : `${error.message}; new allocations are blocked until the manifest is approved`,
        recommendation: error.retryable
          ? 'Retry the adapter probe after RPC recovers'
          : 'Review the deployed contract and approve a new manifest before enabling deposits',
        affectedStrategies: [`${observation.protocolName}_yield_strategy`],
      });
    }

    for (const [capability, state] of Object.entries(observation.capabilities) as Array<[ProtocolCapability, AdapterObservation['state']]>) {
      if (state === 'healthy') continue;
      if (!requiredCapabilities.has(capability) && capability !== 'unwind') continue;
      issues.push({
        severity: capability === 'unwind' ? 'high' : 'critical',
        component: capability,
        issue: `Capability ${capability} is ${state}`,
        impact: capability === 'unwind'
          ? 'Safe unwind may require operator review'
          : 'State-changing automation and deposit routing must fail closed',
        recommendation: 'Probe the deployed contract and compare supported methods with the approved manifest',
        affectedStrategies: [`${observation.protocolName}_yield_strategy`],
      });
    }

    if (!observation.safeUnwindAvailable) {
      issues.push({
        severity: 'high',
        component: 'safe_unwind',
        issue: 'Safe unwind capability unavailable',
        impact: 'Deposits remain blocked and exits may require manual runbook execution',
        recommendation: 'Verify unwind method support before re-enabling automation',
        affectedStrategies: [`${observation.protocolName}_yield_strategy`],
      });
    }

    return issues;
  }

  /**
   * Determine overall protocol status
   */
  private determineProtocolStatus(issues: CompatibilityIssue[]): 'compatible' | 'degraded' | 'incompatible' {
    const hasCritical = issues.some(issue => issue.severity === 'critical');
    const hasHigh = issues.some(issue => issue.severity === 'high');
    
    if (hasCritical) return 'incompatible';
    if (hasHigh) return 'degraded';
    return 'compatible';
  }

  /**
   * Determine overall system status
   */
  private determineOverallStatus(
    protocols: CompatibilityStatus[],
    criticalIssues: CompatibilityIssue[],
  ): 'compatible' | 'degraded' | 'incompatible' {
    if (criticalIssues.length >= this.config.criticalFailureThreshold) return 'incompatible';
    
    const hasIncompatible = protocols.some(p => p.status === 'incompatible');
    const hasDegraded = protocols.some(p => p.status === 'degraded');
    
    if (hasIncompatible) return 'incompatible';
    if (hasDegraded) return 'degraded';
    return 'compatible';
  }

  /**
   * Generate recommendations based on issues
   */
  private generateRecommendations(
    issues: CompatibilityIssue[],
    status: 'compatible' | 'degraded' | 'incompatible',
  ): string[] {
    const recommendations = new Set<string>();
    
    issues.forEach(issue => {
      recommendations.add(issue.recommendation);
    });

    if (status === 'incompatible') {
      recommendations.add('Consider disabling automated strategies for this protocol');
      recommendations.add('Schedule immediate maintenance window');
    } else if (status === 'degraded') {
      recommendations.add('Monitor strategy performance closely');
      recommendations.add('Plan upgrade at next opportunity');
    }

    return Array.from(recommendations);
  }

  /**
   * Handle incompatible protocols
   */
  private async handleIncompatibleProtocols(protocols: CompatibilityStatus[]): Promise<void> {
    const incompatible = protocols.filter(p => p.status === 'incompatible');
    
    for (const protocol of incompatible) {
      console.warn(`Auto-disabling incompatible protocol: ${protocol.protocolName}`);
      // In reality, this would call strategy management service
    }
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CompatibilityConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): CompatibilityConfig {
    return { ...this.config };
  }

  /**
   * Add protocol requirements
   */
  addProtocolRequirements(protocolName: string, requirements: CompatibilityRequirement[]): void {
    this.requirements.set(protocolName, requirements);
  }

  /**
   * Register or replace a production protocol adapter.
   * The compatibility orchestrator discovers protocols through this registry,
   * so adding a third adapter does not require protocol-name conditionals.
   */
  registerAdapter(adapter: ProtocolAdapter): void {
    this.adapters.set(adapter.manifest.protocolName, adapter);
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    cache.flushAll();
  }
}

// ── Export singleton instance ─────────────────────────────────────────────

export const protocolCompatibilityEngine = new ProtocolCompatibilityEngine();

// ── Helper functions ─────────────────────────────────────────────────────

/**
 * Format compatibility report for API response
 */
export function formatCompatibilityReport(report: CompatibilityReport): CompatibilityReport {
  return {
    ...report,
    protocols: report.protocols.map(protocol => ({
      ...protocol,
      issues: protocol.issues.map(issue => ({
        ...issue,
        affectedStrategies: [...issue.affectedStrategies],
      })),
    })),
    criticalIssues: report.criticalIssues.map(issue => ({
      ...issue,
      affectedStrategies: [...issue.affectedStrategies],
    })),
  };
}

/**
 * Check if protocol is safe for strategy execution
 */
export function isProtocolSafeForExecution(
  protocolName: string,
  report: CompatibilityReport,
): boolean {
  const protocol = report.protocols.find(p => p.protocolName === protocolName);
  
  if (!protocol) return false;
  
  return protocol.status === 'compatible' && 
         protocol.issues.filter(i => i.severity === 'critical').length === 0;
}
