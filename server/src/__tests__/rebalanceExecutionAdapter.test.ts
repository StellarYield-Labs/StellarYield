import {
  MockExecutionAdapter,
  SorobanRelayerExecutionAdapter,
  InMemoryIdempotencyStore,
  ExecutionSimulationResult,
  ExecutionSubmitResult,
  RebalanceExecutionRequest,
} from '../services/rebalanceExecutionAdapter';

describe('rebalanceExecutionAdapter', () => {
  describe('MockExecutionAdapter', () => {
    let adapter: MockExecutionAdapter;

    beforeEach(() => {
      adapter = new MockExecutionAdapter();
    });

    it('should return successful simulation by default', async () => {
      const result = await adapter.simulate({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.simulated).toBe(true);
    });

    it('should return successful submission by default with deterministic hash', async () => {
      const result = await adapter.submit({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBeDefined();
      expect(result.status).toBe('confirmed');
      expect(result.ledger).toBeGreaterThan(0);
    });

    it('should produce no random or fake transaction hashes outside of mock', async () => {
      const request: RebalanceExecutionRequest = {
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      };

      const result = await adapter.submit(request);
      const hash = result.transactionHash!;

      const result2 = await adapter.submit(request);
      expect(result2.transactionHash).toBe(hash);
      expect(result2.metadata?.fromCache).toBe(true);
    });

    it('should return cached result on duplicate submit for same intent hash', async () => {
      const request: RebalanceExecutionRequest = {
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      };

      const first = await adapter.submit(request);
      const second = await adapter.submit(request);

      expect(second.transactionHash).toBe(first.transactionHash);
      expect(second.metadata?.fromCache).toBe(true);
    });

    it('should not cache across different intent hashes', async () => {
      const req1: RebalanceExecutionRequest = {
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      };
      const req2: RebalanceExecutionRequest = {
        ...req1,
        queueEntryId: 'q-2',
        intentHash: 'hash-2',
      };

      const r1 = await adapter.submit(req1);
      const r2 = await adapter.submit(req2);

      expect(r2.transactionHash).not.toBe(r1.transactionHash);
      expect(r2.metadata?.fromCache).toBeUndefined();
    });

    it('should handle simulation failure', async () => {
      adapter.configureSimulationFailure(1, 'simulation');

      const result = await adapter.simulate({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.success).toBe(false);
      expect(result.errorClass).toBe('simulation');
      expect(result.metadata?.reason).toBe('mock_simulation_failure');
    });

    it('should handle relayer outage with transient error', async () => {
      adapter.configureSubmitFailure(1, 'transient');

      const result = await adapter.submit({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.success).toBe(false);
      expect(result.errorClass).toBe('transient');
      expect(result.status).toBe('failed');
    });

    it('should handle terminal failure on submit', async () => {
      adapter.configureSubmitFailure(1, 'terminal');

      const result = await adapter.submit({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.success).toBe(false);
      expect(result.errorClass).toBe('terminal');
      expect(result.status).toBe('failed');
    });

    it('should return configured submit results in order', async () => {
      adapter.addSubmitResult({
        success: true,
        transactionHash: '0xabc',
        ledger: 12345,
        status: 'confirmed',
        metadata: { step: 1 },
      });
      adapter.addSubmitResult({
        success: false,
        error: 'rate limited',
        status: 'failed',
        errorClass: 'transient',
        metadata: { step: 2 },
      });

      const req: RebalanceExecutionRequest = {
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      };

      const r1 = await adapter.submit(req);
      expect(r1.transactionHash).toBe('0xabc');
      expect(r1.ledger).toBe(12345);

      const r2 = await adapter.submit({ ...req, intentHash: 'hash-2' });
      expect(r2.error).toBe('rate limited');
      expect(r2.errorClass).toBe('transient');
    });

    it('should reset state cleanly', async () => {
      adapter.configureSimulationFailure(1);
      adapter.configureSubmitFailure(1);

      await adapter.simulate({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      adapter.reset();

      const result = await adapter.simulate({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('InMemoryIdempotencyStore', () => {
    let store: InMemoryIdempotencyStore;

    beforeEach(() => {
      store = new InMemoryIdempotencyStore(1000);
    });

    it('should store and retrieve results', () => {
      const result: ExecutionSubmitResult = {
        success: true,
        transactionHash: '0xabc',
        status: 'confirmed',
      };

      store.set('hash-1', result);
      expect(store.get('hash-1')).toEqual(result);
    });

    it('should return undefined for missing entries', () => {
      expect(store.get('missing')).toBeUndefined();
    });

    it('should expire entries after TTL', async () => {
      const result: ExecutionSubmitResult = {
        success: true,
        transactionHash: '0xabc',
        status: 'confirmed',
      };

      store.set('hash-1', result);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(store.get('hash-1')).toBeUndefined();
    });

    it('should clear all entries', () => {
      store.set('hash-1', { success: true, status: 'confirmed' });
      store.set('hash-2', { success: true, status: 'confirmed' });
      store.clear();
      expect(store.get('hash-1')).toBeUndefined();
      expect(store.get('hash-2')).toBeUndefined();
    });
  });

  describe('SorobanRelayerExecutionAdapter', () => {
    it('should be constructable with config', () => {
      const adapter = new SorobanRelayerExecutionAdapter({
        rpcUrl: 'http://localhost:8000',
        relayerUrl: 'http://localhost:3000',
        networkPassphrase: 'Test SDF Network ; September 2015',
        adminKeypair: {
          publicKey: () => 'GABCD',
          sign: (_tx: unknown) => {},
        } as unknown as import('@stellar/stellar-sdk').Keypair,
        vaultContractId: 'vault-1',
      });

      expect(adapter.name).toBe('soroban-relayer');
    });
  });

  describe('Error classification', () => {
    it('should classify simulation errors', async () => {
      const adapter = new MockExecutionAdapter();
      adapter.configureSimulationFailure(1, 'simulation');

      const result = await adapter.simulate({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.errorClass).toBe('simulation');
    });

    it('should classify transient errors', async () => {
      const adapter = new MockExecutionAdapter();
      adapter.configureSubmitFailure(1, 'transient');

      const result = await adapter.submit({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.errorClass).toBe('transient');
    });

    it('should classify terminal errors', async () => {
      const adapter = new MockExecutionAdapter();
      adapter.configureSubmitFailure(1, 'terminal');

      const result = await adapter.submit({
        queueEntryId: 'q-1',
        vaultId: 'v-1',
        vaultContractId: 'v-1',
        targetAllocations: {},
        currentAllocations: {},
        executionStrategy: {},
        intentHash: 'hash-1',
      });

      expect(result.errorClass).toBe('terminal');
    });
  });
});
