/* eslint-disable @typescript-eslint/no-unused-vars, no-redeclare, no-useless-escape */
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
import request from 'supertest';
import express from 'express';
import strategiesRouter from '../routes/strategies';

describe('debug2', () => {
  it('should be a constructor', () => {
    console.log('typeof:', typeof StrategySnapshotVersioningService);
    console.log('strategiesRouter type:', typeof strategiesRouter);
    const service = new (StrategySnapshotVersioningService as any)();
    expect(service).toBeDefined();
  });
});
