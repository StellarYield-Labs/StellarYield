import { STRATEGY_EVENT_TYPE, VERSION_CHANGE_TYPE } from '../queues/types';
import { StrategySnapshotVersioningService } from '../services/strategySnapshotVersioningService';
import request from 'supertest';
import express from 'express';
import strategiesRouter from '../routes/strategies';

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

describe('debug', () => {
  it('check', () => {
    console.log('SSVS:', typeof StrategySnapshotVersioningService);
    console.log('SSVS === undefined:', StrategySnapshotVersioningService === undefined);
    console.log('SSVS === null:', StrategySnapshotVersioningService === null);
    expect(typeof StrategySnapshotVersioningService).toBe('function');
  });
});
