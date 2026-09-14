import {
  BaseProtocolAdapter,
  BlendProtocolAdapter,
  BLEND_MANIFEST,
  ProtocolIntegrationManifest,
  ProtocolProbeClient,
  SoroswapProtocolAdapter,
} from '../protocolAdapters';
import { ProtocolCompatibilityEngine } from '../protocolCompatibilityService';

class FixtureProbeClient implements ProtocolProbeClient {
  constructor(
    private readonly overrides: Partial<Awaited<ReturnType<ProtocolProbeClient['observe']>>> = {},
  ) {}

  async observe(manifest: ProtocolIntegrationManifest) {
    const contract = manifest.contracts[0];
    return {
      contractId: contract.contractId,
      specHash: contract.expectedSpecHash,
      wasmHash: contract.expectedWasmHash,
      ledger: 123,
      availableMethods: contract.supportedMethods,
      source: 'fixture' as const,
      ...this.overrides,
    };
  }
}

describe('protocol adapters', () => {
  it('marks a manifest mismatch incompatible and preserves safe unwind separately', async () => {
    const adapter = new BlendProtocolAdapter(
      new FixtureProbeClient({ specHash: 'unexpected-spec-hash' }),
    );

    const observation = await adapter.attest();

    expect(observation.state).toBe('incompatible');
    expect(observation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SPEC_HASH_MISMATCH', retryable: false }),
      ]),
    );
    expect(observation.safeUnwindAvailable).toBe(true);
  });

  it('builds quotes with atomic integer values only', async () => {
    const adapter = new SoroswapProtocolAdapter();

    const quote = await adapter.quote({
      inputAsset: 'USDC',
      outputAsset: 'XLM',
      amountAtomic: 1_000_000n,
      minimumOutputAtomic: 900_000n,
      stateLedger: 100,
      expiresAtLedger: 110,
      route: ['USDC', 'XLM'],
    });

    expect(quote.expectedOutputAtomic).toBe(997_000n);
    expect(quote.amountAtomic).toBe(1_000_000n);
    expect(quote.assumptions).toContain('integer atomic units only');
  });

  it('lets the compatibility engine consume a third adapter without protocol conditionals', async () => {
    const testManifest: ProtocolIntegrationManifest = {
      ...BLEND_MANIFEST,
      protocolName: 'TestOnly',
      contracts: [{
        ...BLEND_MANIFEST.contracts[0],
        contractId: 'CTESTONLY0000000000000000000000000000000000000001',
      }],
    };
    class TestOnlyAdapter extends BaseProtocolAdapter {
      constructor() {
        super(testManifest, new FixtureProbeClient());
      }
    }

    const engine = new ProtocolCompatibilityEngine({ autoDisableIncompatible: false });
    engine.registerAdapter(new TestOnlyAdapter());

    const status = await engine.checkProtocol('TestOnly');

    expect(status.protocolName).toBe('TestOnly');
    expect(status.status).toBe('compatible');
    expect(status.safeUnwindAvailable).toBe(true);
  });
});
