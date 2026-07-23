export interface ProtocolAdapterPayload {
  protocolName: string;
  vaultId: string;
  apy?: number;
  tvlUsd?: number;
  fetchedAt: string;
  [key: string]: unknown;
}

export interface ComplianceCheckResult {
  success: boolean;
  staleData: boolean;
  partialData: boolean;
  providerFailure: boolean;
  adapterName: string;
  payload?: ProtocolAdapterPayload;
  details: string[];
  normalizedError?: string;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function validateProtocolAdapterPayload(
  payload: unknown,
): { valid: boolean; errors: string[]; stale: boolean; partial?: boolean } {
  const errors: string[] = [];
  let stale = false;
  let partial = false;

  if (!payload || typeof payload !== 'object') {
    errors.push('Payload is null or not an object');
    return { valid: false, errors, stale, partial };
  }

  const p = payload as Record<string, unknown>;

  if (!p.protocolName || (typeof p.protocolName === 'string' && p.protocolName.trim() === '')) {
    errors.push('Missing or empty protocolName');
  }

  if (p.apy !== undefined && (typeof p.apy !== 'number' || !isFinite(p.apy as number))) {
    errors.push('apy must be a finite number');
  }

  if (p.tvlUsd !== undefined && (typeof p.tvlUsd !== 'number' || !isFinite(p.tvlUsd as number))) {
    errors.push('tvlUsd must be a finite number');
  }

  if (p.fetchedAt) {
    const ts = new Date(p.fetchedAt as string).getTime();
    if (isNaN(ts)) {
      stale = true;
      errors.push('fetchedAt is not a valid date');
    } else if (Date.now() - ts > STALE_THRESHOLD_MS) {
      stale = true;
      errors.push('fetchedAt is stale');
    }
  }

  if (p.apy === undefined || p.tvlUsd === undefined) {
    partial = true;
  }

  if (errors.length === 0 && !stale) {
    return { valid: true, errors: [], stale: false, partial };
  }

  return { valid: errors.length === 0, errors, stale, partial };
}

export function checkAdapterStale(timestamp: string, thresholdMs: number = STALE_THRESHOLD_MS): boolean {
  const ts = new Date(timestamp).getTime();
  if (isNaN(ts)) return true;
  return Date.now() - ts > thresholdMs;
}

export function normalizeAdapterError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

async function defaultSuccessfulAdapter(): Promise<ProtocolAdapterPayload> {
  return {
    protocolName: 'default',
    vaultId: 'default-vault',
    apy: 5.0,
    tvlUsd: 1_000_000,
    fetchedAt: new Date().toISOString(),
  };
}

export async function runProtocolAdapterComplianceChecks(
  adapterName: string,
  adapter: () => Promise<unknown> = defaultSuccessfulAdapter,
): Promise<ComplianceCheckResult> {
  const details: string[] = [];
  let staleData = false;
  let partialData = false;
  let providerFailure = false;

  let payload: ProtocolAdapterPayload | undefined;

  try {
    const result = await adapter();
    payload = result as ProtocolAdapterPayload;

    const validation = validateProtocolAdapterPayload(payload);
    staleData = validation.stale;
    partialData = validation.partial || false;

    if (validation.errors.length > 0) {
      details.push(...validation.errors);
    }
    if (partialData) {
      details.push('Payload is missing some required fields');
    }
  } catch (err) {
    providerFailure = true;
    const normalizedError = normalizeAdapterError(err);
    details.push(normalizedError);
    return {
      success: false,
      staleData: false,
      partialData: false,
      providerFailure: true,
      adapterName,
      details,
      normalizedError,
    };
  }

  const success = !staleData && !partialData && !providerFailure && details.length === 0;

  return {
    success,
    staleData,
    partialData,
    providerFailure,
    adapterName,
    payload,
    details,
  };
}
