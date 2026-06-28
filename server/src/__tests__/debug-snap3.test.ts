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

import { StrategySnapshotVersioningService } from '../services/strategySnapshotVersioningService';

describe('debug3', () => {
  it('should be a constructor without as any', () => {
    const service: StrategySnapshotVersioningService = new StrategySnapshotVersioningService();
    expect(service).toBeDefined();
  });
});
