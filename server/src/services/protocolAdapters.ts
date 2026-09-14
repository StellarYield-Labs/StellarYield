export type ProtocolCapability =
  | 'deposit'
  | 'withdraw'
  | 'swap'
  | 'claim'
  | 'unwind'
  | 'quote'
  | 'simulate'
  | 'health';

export type AdapterObservationState = 'healthy' | 'degraded' | 'unavailable' | 'changed' | 'incompatible';

export interface TokenMetadata {
  assetCode: string;
  contractId: string;
  decimals: number;
}

export interface ProtocolIntegrationManifest {
  protocolName: string;
  version: string;
  network: string;
  contracts: Array<{
    role: string;
    contractId: string;
    expectedSpecHash: string;
    expectedWasmHash: string;
    supportedMethods: string[];
    expectedEventSchemas: string[];
  }>;
  tokens: TokenMetadata[];
  requiredCapabilities: ProtocolCapability[];
  safeUnwindMethods: string[];
}

export interface AdapterObservation {
  protocolName: string;
  version: string;
  network: string;
  contractId: string;
  observedSpecHash: string;
  observedWasmHash: string;
  state: AdapterObservationState;
  ledger: number;
  source: 'rpc' | 'fixture' | 'local';
  checkedAt: string;
  capabilities: Record<ProtocolCapability, AdapterObservationState>;
  safeUnwindAvailable: boolean;
  provenance: {
    manifestVersion: string;
    expectedSpecHash: string;
    expectedWasmHash: string;
  };
  errors: Array<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
}

export interface QuoteRequest {
  inputAsset: string;
  outputAsset: string;
  amountAtomic: bigint;
  minimumOutputAtomic: bigint;
  stateLedger: number;
  expiresAtLedger: number;
  route: string[];
}

export interface AdapterQuote {
  protocolName: string;
  inputAsset: string;
  outputAsset: string;
  amountAtomic: bigint;
  minimumOutputAtomic: bigint;
  expectedOutputAtomic: bigint;
  stateLedger: number;
  expiresAtLedger: number;
  route: string[];
  assumptions: string[];
}

export interface ProtocolAdapter {
  readonly manifest: ProtocolIntegrationManifest;
  attest(): Promise<AdapterObservation>;
  quote(request: QuoteRequest): Promise<AdapterQuote>;
  classifyError(error: unknown): { code: string; retryable: boolean; terminal: boolean };
}

export interface ProtocolProbeClient {
  observe(manifest: ProtocolIntegrationManifest): Promise<{
    contractId: string;
    specHash: string;
    wasmHash: string;
    ledger: number;
    availableMethods: string[];
    source: AdapterObservation['source'];
  }>;
}

class ManifestFixtureProbeClient implements ProtocolProbeClient {
  async observe(manifest: ProtocolIntegrationManifest) {
    const primaryContract = manifest.contracts[0];
    return {
      contractId: primaryContract.contractId,
      specHash: primaryContract.expectedSpecHash,
      wasmHash: primaryContract.expectedWasmHash,
      ledger: 0,
      availableMethods: primaryContract.supportedMethods,
      source: 'fixture' as const,
    };
  }
}

export abstract class BaseProtocolAdapter implements ProtocolAdapter {
  constructor(
    readonly manifest: ProtocolIntegrationManifest,
    private readonly probeClient: ProtocolProbeClient = new ManifestFixtureProbeClient(),
  ) {}

  async attest(): Promise<AdapterObservation> {
    const observed = await this.probeClient.observe(this.manifest);
    const primaryContract = this.manifest.contracts[0];
    const errors: AdapterObservation['errors'] = [];

    if (observed.contractId !== primaryContract.contractId) {
      errors.push({
        code: 'CONTRACT_ID_MISMATCH',
        message: `Observed ${observed.contractId}, expected ${primaryContract.contractId}`,
        retryable: false,
      });
    }
    if (observed.specHash !== primaryContract.expectedSpecHash) {
      errors.push({
        code: 'SPEC_HASH_MISMATCH',
        message: `Observed ${observed.specHash}, expected ${primaryContract.expectedSpecHash}`,
        retryable: false,
      });
    }
    if (observed.wasmHash !== primaryContract.expectedWasmHash) {
      errors.push({
        code: 'WASM_HASH_MISMATCH',
        message: `Observed ${observed.wasmHash}, expected ${primaryContract.expectedWasmHash}`,
        retryable: false,
      });
    }

    const capabilities = this.probeCapabilities(observed.availableMethods);
    const missingCriticalCapability = Object.entries(capabilities).some(
      ([capability, state]) =>
        this.manifest.requiredCapabilities.includes(capability as ProtocolCapability) &&
        state !== 'healthy',
    );
    const state: AdapterObservationState =
      errors.length > 0 || missingCriticalCapability ? 'incompatible' : 'healthy';

    return {
      protocolName: this.manifest.protocolName,
      version: this.manifest.version,
      network: this.manifest.network,
      contractId: observed.contractId,
      observedSpecHash: observed.specHash,
      observedWasmHash: observed.wasmHash,
      state,
      ledger: observed.ledger,
      source: observed.source,
      checkedAt: new Date().toISOString(),
      capabilities,
      safeUnwindAvailable: this.manifest.safeUnwindMethods.every((method) =>
        observed.availableMethods.includes(method),
      ),
      provenance: {
        manifestVersion: this.manifest.version,
        expectedSpecHash: primaryContract.expectedSpecHash,
        expectedWasmHash: primaryContract.expectedWasmHash,
      },
      errors,
    };
  }

  async quote(request: QuoteRequest): Promise<AdapterQuote> {
    this.assertSupportedAsset(request.inputAsset);
    this.assertSupportedAsset(request.outputAsset);
    if (request.amountAtomic <= 0n) {
      throw new Error('Quote amount must be positive atomic units');
    }
    if (request.minimumOutputAtomic < 0n) {
      throw new Error('Minimum output cannot be negative');
    }

    const expectedOutputAtomic = this.estimateOutputAtomic(request);
    if (expectedOutputAtomic < request.minimumOutputAtomic) {
      throw new Error('Quote output is below minimum output');
    }

    return {
      protocolName: this.manifest.protocolName,
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      amountAtomic: request.amountAtomic,
      minimumOutputAtomic: request.minimumOutputAtomic,
      expectedOutputAtomic,
      stateLedger: request.stateLedger,
      expiresAtLedger: request.expiresAtLedger,
      route: [...request.route],
      assumptions: [
        'integer atomic units only',
        `manifest:${this.manifest.protocolName}@${this.manifest.version}`,
      ],
    };
  }

  classifyError(error: unknown): { code: string; retryable: boolean; terminal: boolean } {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|temporar|rate/i.test(message)) {
      return { code: 'TRANSPORT_RETRYABLE', retryable: true, terminal: false };
    }
    if (/spec|wasm|contract|unsupported/i.test(message)) {
      return { code: 'COMPATIBILITY_TERMINAL', retryable: false, terminal: true };
    }
    return { code: 'UNKNOWN_ADAPTER_ERROR', retryable: false, terminal: true };
  }

  protected estimateOutputAtomic(request: QuoteRequest): bigint {
    return request.amountAtomic;
  }

  private probeCapabilities(availableMethods: string[]): Record<ProtocolCapability, AdapterObservationState> {
    const methodSet = new Set(availableMethods);
    return {
      deposit: methodSet.has('deposit') ? 'healthy' : 'unavailable',
      withdraw: methodSet.has('withdraw') ? 'healthy' : 'unavailable',
      swap: methodSet.has('swap') || methodSet.has('swap_exact_tokens') ? 'healthy' : 'unavailable',
      claim: methodSet.has('claim') ? 'healthy' : 'unavailable',
      unwind: this.manifest.safeUnwindMethods.some((method) => methodSet.has(method))
        ? 'healthy'
        : 'unavailable',
      quote: methodSet.has('quote') || methodSet.has('get_amount_out') ? 'healthy' : 'unavailable',
      simulate: methodSet.has('simulate') ? 'healthy' : 'unavailable',
      health: methodSet.has('health') || methodSet.has('get_apy') ? 'healthy' : 'unavailable',
    };
  }

  private assertSupportedAsset(assetCode: string): void {
    if (!this.manifest.tokens.some((token) => token.assetCode === assetCode)) {
      throw new Error(`Unsupported asset ${assetCode} for ${this.manifest.protocolName}`);
    }
  }
}

export const BLEND_MANIFEST: ProtocolIntegrationManifest = {
  protocolName: 'Blend',
  version: '2.1.0',
  network: 'testnet',
  contracts: [{
    role: 'pool',
    contractId: 'CBLENDTESTNETPOOL000000000000000000000000000000000001',
    expectedSpecHash: 'blend-spec-v2.1.0',
    expectedWasmHash: 'blend-wasm-v2.1.0',
    supportedMethods: ['deposit', 'withdraw', 'claim', 'get_apy', 'health', 'simulate'],
    expectedEventSchemas: ['deposit_v1', 'withdraw_v1', 'claim_v1'],
  }],
  tokens: [
    { assetCode: 'USDC', contractId: 'CUSDCBLENDTESTNET0000000000000000000000000000000001', decimals: 7 },
    { assetCode: 'XLM', contractId: 'CXLMTESTNET0000000000000000000000000000000000001', decimals: 7 },
  ],
  requiredCapabilities: ['deposit', 'withdraw', 'claim', 'health', 'simulate'],
  safeUnwindMethods: ['withdraw'],
};

export const SOROSWAP_MANIFEST: ProtocolIntegrationManifest = {
  protocolName: 'Soroswap',
  version: '1.4.2',
  network: 'testnet',
  contracts: [{
    role: 'router',
    contractId: 'CSOROSWAPTESTNETROUTER0000000000000000000000000000001',
    expectedSpecHash: 'soroswap-spec-v1.4.2',
    expectedWasmHash: 'soroswap-wasm-v1.4.2',
    supportedMethods: ['swap_exact_tokens', 'get_amount_out', 'withdraw', 'health', 'simulate'],
    expectedEventSchemas: ['swap_v1', 'liquidity_v1'],
  }],
  tokens: [
    { assetCode: 'USDC', contractId: 'CUSDCSOROSWAPTESTNET0000000000000000000000000000001', decimals: 7 },
    { assetCode: 'XLM', contractId: 'CXLMTESTNET0000000000000000000000000000000000001', decimals: 7 },
  ],
  requiredCapabilities: ['swap', 'quote', 'simulate', 'health'],
  safeUnwindMethods: ['withdraw'],
};

export class BlendProtocolAdapter extends BaseProtocolAdapter {
  constructor(probeClient?: ProtocolProbeClient) {
    super(BLEND_MANIFEST, probeClient);
  }
}

export class SoroswapProtocolAdapter extends BaseProtocolAdapter {
  constructor(probeClient?: ProtocolProbeClient) {
    super(SOROSWAP_MANIFEST, probeClient);
  }

  protected override estimateOutputAtomic(request: QuoteRequest): bigint {
    // Deterministic integer-only placeholder for router quote parity tests.
    // 30 bps conservative haircut; never uses floating point.
    return (request.amountAtomic * 9_970n) / 10_000n;
  }
}

export function createDefaultProtocolAdapterRegistry(): Map<string, ProtocolAdapter> {
  return new Map<string, ProtocolAdapter>([
    ['Blend', new BlendProtocolAdapter()],
    ['Soroswap', new SoroswapProtocolAdapter()],
  ]);
}
