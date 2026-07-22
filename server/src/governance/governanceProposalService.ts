import * as StellarSdk from "@stellar/stellar-sdk";
import { PrismaClient } from "@prisma/client";
import {
  hashGovernanceAction,
  validateGovernanceAction,
  GovernanceActionValidationError,
  type GovernanceAction,
} from "./actionSchema";

const prisma = new PrismaClient();

/**
 * How stale a simulation is allowed to be (in ledgers) before it must be
 * re-run before a proposal can move to APPROVED/EXECUTABLE. Configurable via
 * env so operators can tighten/loosen the bound without a code change.
 */
const MAX_SIMULATION_LEDGER_AGE = parseInt(
  process.env.GOVERNANCE_MAX_SIMULATION_LEDGER_AGE ?? "50",
  10,
);

const RPC_URL = process.env.RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

export interface CreateProposalInput {
  action: GovernanceAction;
  strategyVersionId?: string;
  riskForecastId?: string;
  auditLogId?: string;
}

export interface SimulationEvidence {
  ledger: number;
  expiry: Date;
  footprint: Record<string, unknown>;
  result: Record<string, unknown>;
  diagnosticEvents: unknown[];
  expectedStateDiff: Record<string, unknown>;
  resourceFee: string;
  riskWarnings: string[];
}

export class ProposalNotFoundError extends Error {}
export class SimulationStaleError extends Error {}

/**
 * Create a governance proposal record. This does NOT submit anything
 * on-chain - it only persists the canonical action and its hash so the
 * proposal can be reviewed, simulated, and eventually turned into a
 * transaction for the client to sign and the optimistic_governance
 * contract to accept. Admin routes call this instead of pretending a
 * mutation already succeeded.
 */
export async function createProposal(input: CreateProposalInput) {
  validateGovernanceAction(input.action);
  const actionHash = hashGovernanceAction(input.action);

  const existing = await prisma.governanceProposal.findUnique({
    where: { actionHash },
  });
  if (existing) {
    return existing;
  }

  return prisma.governanceProposal.create({
    data: {
      actionHash,
      schemaVersion: input.action.schemaVersion,
      network: input.action.network,
      targetContractId: input.action.targetContractId,
      method: input.action.method,
      argsJson: input.action.args as unknown as object,
      expectedStateJson: input.action.expectedCurrentState as unknown as object,
      proposer: input.action.proposer,
      creationLedger: input.action.creationLedger,
      executionWindowSecs: input.action.executionWindowSeconds,
      rationale: input.action.rationale,
      strategyVersionId: input.strategyVersionId,
      riskForecastId: input.riskForecastId,
      auditLogId: input.auditLogId,
      status: "PENDING",
    },
  });
}

export async function getProposal(id: string) {
  const proposal = await prisma.governanceProposal.findUnique({
    where: { id },
    include: { simulations: { orderBy: { createdAt: "desc" }, take: 1 }, events: true },
  });
  if (!proposal) {
    throw new ProposalNotFoundError(`Proposal ${id} not found`);
  }
  return proposal;
}

export async function listProposals(filter: { status?: string; proposer?: string } = {}) {
  return prisma.governanceProposal.findMany({
    where: {
      status: filter.status,
      proposer: filter.proposer,
    },
    orderBy: { createdAt: "desc" },
    include: { simulations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
}

/**
 * Run a Soroban simulation for the proposal's target invocation and persist
 * the resulting footprint, diagnostic events, resource fee, and risk
 * warnings as evidence. Falls back to a conservative synthetic result if the
 * RPC endpoint is unreachable (e.g. local/dev environments), clearly flagged
 * via a risk warning so it's never mistaken for a real simulation.
 */
export async function simulateProposal(proposalId: string) {
  const proposal = await prisma.governanceProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) {
    throw new ProposalNotFoundError(`Proposal ${proposalId} not found`);
  }

  const evidence = await runSimulation(proposal);

  await prisma.governanceSimulation.create({
    data: {
      proposalId,
      simulatedAtLedger: evidence.ledger,
      simulationExpiry: evidence.expiry,
      footprintJson: evidence.footprint as unknown as object,
      resultJson: evidence.result as unknown as object,
      diagnosticEventsJson: evidence.diagnosticEvents as unknown as object,
      expectedStateDiffJson: evidence.expectedStateDiff as unknown as object,
      resourceFee: evidence.resourceFee,
      riskWarnings: evidence.riskWarnings,
    },
  });

  return evidence;
}

async function runSimulation(proposal: {
  targetContractId: string;
  method: string;
  argsJson: unknown;
  proposer: string;
}): Promise<SimulationEvidence> {
  const server = new StellarSdk.rpc.Server(RPC_URL);

  try {
    const latestLedger = await server.getLatestLedger();
    const contract = new StellarSdk.Contract(proposal.targetContractId);
    const args = Array.isArray(proposal.argsJson) ? proposal.argsJson : [];
    const scArgs = args.map((arg: unknown) => argToScVal(arg));

    const source = await server.getAccount(proposal.proposer);
    const op = contract.call(proposal.method, ...scArgs);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      return {
        ledger: latestLedger.sequence,
        expiry: simulationExpiry(latestLedger.sequence),
        footprint: {},
        result: { error: simulated.error },
        diagnosticEvents: simulated.events ?? [],
        expectedStateDiff: {},
        resourceFee: "0",
        riskWarnings: [`Simulation failed: ${simulated.error}`],
      };
    }

    const footprint = simulated.transactionData?.getFootprint
      ? {
          readOnly: simulated.transactionData
            .getFootprint()
            .readOnly()
            .map((k) => k.toXDR("base64")),
          readWrite: simulated.transactionData
            .getFootprint()
            .readWrite()
            .map((k) => k.toXDR("base64")),
        }
      : {};

    return {
      ledger: latestLedger.sequence,
      expiry: simulationExpiry(latestLedger.sequence),
      footprint,
      result: { retval: simulated.result?.retval ? simulated.result.retval.toXDR("base64") : null },
      diagnosticEvents: simulated.events ?? [],
      expectedStateDiff: {},
      resourceFee: simulated.minResourceFee ?? "0",
      riskWarnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ledger: 0,
      expiry: new Date(Date.now() + 60_000),
      footprint: {},
      result: { error: message },
      diagnosticEvents: [],
      expectedStateDiff: {},
      resourceFee: "0",
      riskWarnings: [
        "Simulation could not reach Soroban RPC - this is not a real simulation result and must be re-run before approval.",
      ],
    };
  }
}

function argToScVal(arg: unknown): StellarSdk.xdr.ScVal {
  if (arg && typeof arg === "object" && "type" in (arg as Record<string, unknown>)) {
    const typed = arg as { type: string; value: string | number | boolean };
    switch (typed.type) {
      case "address":
        return new StellarSdk.Address(String(typed.value)).toScVal();
      case "u32":
        return StellarSdk.nativeToScVal(Number(typed.value), { type: "u32" });
      case "u64":
        return StellarSdk.nativeToScVal(BigInt(typed.value), { type: "u64" });
      case "i128":
        return StellarSdk.nativeToScVal(BigInt(typed.value), { type: "i128" });
      case "bool":
        return StellarSdk.nativeToScVal(Boolean(typed.value));
      case "symbol":
        return StellarSdk.nativeToScVal(String(typed.value), { type: "symbol" });
      default:
        return StellarSdk.nativeToScVal(String(typed.value));
    }
  }
  return StellarSdk.nativeToScVal(arg);
}

function simulationExpiry(ledger: number): Date {
  // Soroban ledgers close roughly every ~5s; bound the wall-clock validity
  // window using the configured max ledger age as an approximation.
  return new Date(Date.now() + MAX_SIMULATION_LEDGER_AGE * 5_000);
}

/**
 * A stale simulation cannot be presented as current without a warning and
 * execution gate (issue #81 invariant). Callers must check this before
 * allowing a proposal to move to APPROVED/EXECUTABLE.
 */
export async function isSimulationStale(proposalId: string): Promise<boolean> {
  const latest = await prisma.governanceSimulation.findFirst({
    where: { proposalId },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) return true;
  if (latest.simulationExpiry.getTime() < Date.now()) return true;

  try {
    const server = new StellarSdk.rpc.Server(RPC_URL);
    const latestLedger = await server.getLatestLedger();
    if (latestLedger.sequence - latest.simulatedAtLedger > MAX_SIMULATION_LEDGER_AGE) {
      return true;
    }
  } catch {
    // If we cannot reach the RPC to confirm freshness, treat as stale -
    // fail closed rather than allowing an unverifiable simulation through.
    return true;
  }

  return false;
}

export async function cancelProposal(proposalId: string, actor: string, reason: string) {
  const proposal = await prisma.governanceProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) {
    throw new ProposalNotFoundError(`Proposal ${proposalId} not found`);
  }
  if (["EXECUTED", "CONFIRMED"].includes(proposal.status)) {
    throw new GovernanceActionValidationError(
      `Cannot cancel a proposal in status ${proposal.status}`,
    );
  }

  return prisma.governanceProposal.update({
    where: { id: proposalId },
    data: { status: "CANCELLED", failureReason: `Cancelled by ${actor}: ${reason}` },
  });
}

export { prisma as governanceProposalPrisma };
