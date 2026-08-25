import type { RequestOptions } from "../../lib/requestCancellation";
import { fetchJson } from "../../lib/requestCancellation";

export interface SimulationAllocation {
  protocol: string;
  amount: number;
  percentage: number;
}

export interface SimulationFee {
  type: string;
  amount: number;
}

export interface SimulationResult {
  isSimulationOnly: true;
  allocations: SimulationAllocation[];
  expectedShares: number;
  fees: SimulationFee[];
  postDepositExposure: {
    expectedApy: number;
  };
  routing: {
    path: string[];
    expectedOutput: number;
  };
  warnings: string[];
}

export interface SimulationRequestParams {
  strategyId: string;
  amount: number;
  token: string;
}

export async function fetchDepositSimulation(
  params: SimulationRequestParams,
  options?: RequestOptions,
): Promise<SimulationResult> {
  return fetchJson<SimulationResult>("/api/simulator/deposit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    ...options,
  });
}
