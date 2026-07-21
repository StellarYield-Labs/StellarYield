import crypto from "crypto";

/**
 * Canonical, versioned schema for every privileged action that can be
 * proposed through the unified governance control plane (Issue #81).
 *
 * The hash produced by `hashGovernanceAction` MUST match the hash computed
 * on-chain by the `optimistic_governance` contract for the same logical
 * action (see contracts/optimistic_governance/src/action.rs and
 * governance-test-vectors.json). Any change to this schema requires a
 * matching version bump (`GOVERNANCE_ACTION_SCHEMA_VERSION`) and updated
 * test vectors, otherwise client/server/contract hashes will diverge.
 */
export const GOVERNANCE_ACTION_SCHEMA_VERSION = 1;

/**
 * The allowlisted set of (contract, function) operations that the
 * governance control plane is permitted to propose. This must be kept in
 * lockstep with the on-chain allowlist registered in the
 * optimistic_governance contract - the contract is the final authority,
 * this list only lets the server/client reject obviously invalid proposals
 * early and build a consistent argument schema.
 */
export const ALLOWED_GOVERNANCE_METHODS = [
  "vault_pause",
  "vault_resume",
  "fee_config_update",
  "risk_parameter_update",
  "strategy_config_update",
  "protocol_freeze",
  "protocol_recovery",
] as const;

export type GovernanceMethod = (typeof ALLOWED_GOVERNANCE_METHODS)[number];

export type GovernanceArgValue = string | number | boolean;

export interface GovernanceActionArg {
  name: string;
  type: "address" | "u32" | "u64" | "i128" | "symbol" | "bool" | "string";
  value: GovernanceArgValue;
}

/**
 * The canonical action payload. Field order in the interface is documentation
 * only - `canonicalizeAction` below defines the actual byte-for-byte
 * ordering used for hashing, independent of key insertion order.
 */
export interface GovernanceAction {
  schemaVersion: number;
  network: "TESTNET" | "MAINNET" | "FUTURENET";
  targetContractId: string;
  method: GovernanceMethod;
  args: GovernanceActionArg[];
  expectedCurrentState: Record<string, GovernanceArgValue>;
  proposer: string;
  creationLedger: number;
  executionWindowSeconds: number;
  rationale: string;
}

export class GovernanceActionValidationError extends Error {}

function assertArgShape(arg: GovernanceActionArg): void {
  if (!arg.name || typeof arg.name !== "string") {
    throw new GovernanceActionValidationError("Argument name must be a non-empty string");
  }
  const allowedTypes = ["address", "u32", "u64", "i128", "symbol", "bool", "string"];
  if (!allowedTypes.includes(arg.type)) {
    throw new GovernanceActionValidationError(`Unsupported argument type: ${arg.type}`);
  }
}

/**
 * Validate that an action is well-formed and its method is on the allowlist.
 * This is a cheap, early rejection layer - the on-chain allowlist is the
 * final authority and must independently reject anything this misses.
 */
export function validateGovernanceAction(action: GovernanceAction): void {
  if (action.schemaVersion !== GOVERNANCE_ACTION_SCHEMA_VERSION) {
    throw new GovernanceActionValidationError(
      `Unsupported schema version: ${action.schemaVersion}`,
    );
  }
  if (!ALLOWED_GOVERNANCE_METHODS.includes(action.method)) {
    throw new GovernanceActionValidationError(
      `Method "${action.method}" is not in the governance allowlist`,
    );
  }
  if (!action.targetContractId || typeof action.targetContractId !== "string") {
    throw new GovernanceActionValidationError("targetContractId is required");
  }
  if (!action.proposer || typeof action.proposer !== "string") {
    throw new GovernanceActionValidationError("proposer is required");
  }
  if (!Array.isArray(action.args)) {
    throw new GovernanceActionValidationError("args must be an array");
  }
  action.args.forEach(assertArgShape);
  if (!Number.isInteger(action.creationLedger) || action.creationLedger < 0) {
    throw new GovernanceActionValidationError("creationLedger must be a non-negative integer");
  }
  if (
    !Number.isInteger(action.executionWindowSeconds) ||
    action.executionWindowSeconds <= 0
  ) {
    throw new GovernanceActionValidationError(
      "executionWindowSeconds must be a positive integer",
    );
  }
  if (!action.rationale || typeof action.rationale !== "string") {
    throw new GovernanceActionValidationError("rationale is required");
  }
}

/**
 * Produce a deterministic byte-for-byte encoding of a GovernanceAction.
 * Uses explicit field ordering (not JSON.stringify(obj), which is
 * insertion-order dependent) so hashes are stable across languages.
 * This exact wire order is mirrored in
 * contracts/optimistic_governance/src/action.rs::encode_action.
 */
export function canonicalizeAction(action: GovernanceAction): string {
  const argsEncoded = action.args
    .map((a) => `${a.name}:${a.type}:${String(a.value)}`)
    .join("|");

  const stateKeys = Object.keys(action.expectedCurrentState).sort();
  const stateEncoded = stateKeys
    .map((k) => `${k}=${String(action.expectedCurrentState[k])}`)
    .join("|");

  return [
    `v${action.schemaVersion}`,
    action.network,
    action.targetContractId,
    action.method,
    argsEncoded,
    stateEncoded,
    action.proposer,
    String(action.creationLedger),
    String(action.executionWindowSeconds),
    action.rationale,
  ].join("\n");
}

/**
 * Hash the exact action payload. This hash is the single source of truth
 * shared by the client preview, server proposal record, signatures, the
 * on-chain proposal, and the execution event (Issue #81 requirement).
 */
export function hashGovernanceAction(action: GovernanceAction): string {
  validateGovernanceAction(action);
  const canonical = canonicalizeAction(action);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
