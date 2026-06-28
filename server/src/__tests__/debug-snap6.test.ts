jest.mock('@prisma/client', () => {
  const instance = {
    strategySnapshot: { create: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
    strategyVersionReference: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
    strategyVersionHistory: { create: jest.fn(), findMany: jest.fn() },
  };
  const MockPrismaClient = jest.fn(() => instance);
  (MockPrismaClient as any).__mockInstance = instance;
  return { PrismaClient: MockPrismaClient };
});

import { StrategySnapshotVersioningService, strategySnapshotVersioningService } from '../services/strategySnapshotVersioningService';

describe('debug6', () => {
  it('should have both exports', () => {
    console.log('typeof class:', typeof StrategySnapshotVersioningService);
    console.log('typeof singleton:', typeof strategySnapshotVersioningService);
    console.log('class is class:', /^class/.test(StrategySnapshotVersioningService.toString()));
    expect(typeof StrategySnapshotVersioningService).toBe('function');
    expect(typeof strategySnapshotVersioningService).toBe('object');
  });
});
