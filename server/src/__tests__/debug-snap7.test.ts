/* eslint-disable @typescript-eslint/no-unused-vars, no-redeclare, no-useless-escape */
import { STRATEGY_EVENT_TYPE, VERSION_CHANGE_TYPE } from '../queues/types';
import { StrategySnapshotVersioningService } from '../services/strategySnapshotVersioningService';
import request from 'supertest';
import express from 'express';
import strategiesRouter from '../routes/strategies';

jest.mock('@prisma/client', () => {
  const instance = {
    strategySnapshot: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    strategyVersionReference: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    strategyVersionHistory: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const MockPrismaClient = jest.fn(() => instance);
  (MockPrismaClient as any).__mockInstance = instance;
  return { PrismaClient: MockPrismaClient };
});

describe('StrategySnapshotVersioningService', () => {
  let service: StrategySnapshotVersioningService;
  let mockPrisma: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StrategySnapshotVersioningService();
    const { PrismaClient } = require('@prisma/client');
    mockPrisma = (PrismaClient as any).__mockInstance;
  });

  describe('Snapshot Creation', () => {
    it('should create first version of a strategy', async () => {
      const strategyId = 'strategy-1';
      const keyWeights = { BTC: 0.4, ETH: 0.3, USDC: 0.3 };
      const riskParams = { volatility: 0.25, sharpeRatio: 1.5 };
      const constraints = { minAllocation: 0.05, maxAllocation: 0.5 };

      mockPrisma.strategySnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.strategySnapshot.create.mockResolvedValue({
        id: 'snap-1',
        strategyId,
        version: 1,
        name: 'Conservative Strategy',
      });

      const result = await service.createSnapshot(
        strategyId,
        'Conservative Strategy',
        keyWeights,
        riskParams,
        constraints,
      );

      expect(result).toBeDefined();
      expect(result.version).toBe(1);
    });
  });
});
