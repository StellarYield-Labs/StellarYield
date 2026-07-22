import { VaultError } from "./generated/yield_vault";

export class SorobanSdkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorobanSdkError";
  }
}

export class WrongNetworkError extends SorobanSdkError {
  public expectedNetwork: string;
  public actualNetwork: string;

  constructor(expectedNetwork: string, actualNetwork: string) {
    super(`Network passphrase mismatch. Expected '${expectedNetwork}', got '${actualNetwork}'.`);
    this.name = "WrongNetworkError";
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
  }
}

export class SpecMismatchError extends SorobanSdkError {
  public expectedHash: string;
  public actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(`Contract spec mismatch. SDK pinned hash '${expectedHash}' does not match contract hash '${actualHash}'.`);
    this.name = "SpecMismatchError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class StaleSimulationError extends SorobanSdkError {
  public validUntilLedger: number;
  public currentLedger: number;

  constructor(validUntilLedger: number, currentLedger: number) {
    super(`Simulation expired. Valid until ledger ${validUntilLedger}, current ledger is ${currentLedger}.`);
    this.name = "StaleSimulationError";
    this.validUntilLedger = validUntilLedger;
    this.currentLedger = currentLedger;
  }
}

export class SubmissionTimeoutError extends SorobanSdkError {
  public txHash: string;
  public timeoutMs: number;

  constructor(txHash: string, timeoutMs: number) {
    super(`Transaction submission timed out after ${timeoutMs}ms. TxHash: ${txHash}`);
    this.name = "SubmissionTimeoutError";
    this.txHash = txHash;
    this.timeoutMs = timeoutMs;
  }
}

export class WalletRejectedError extends SorobanSdkError {
  constructor(reason?: string) {
    super(`Wallet rejected signing request${reason ? `: ${reason}` : ""}`);
    this.name = "WalletRejectedError";
  }
}

export class InvalidXdrError extends SorobanSdkError {
  public rawXdr: string;

  constructor(message: string, rawXdr: string) {
    super(`Invalid XDR: ${message}`);
    this.name = "InvalidXdrError";
    this.rawXdr = rawXdr;
  }
}

export class MissingAuthError extends SorobanSdkError {
  constructor(message: string = "Transaction simulation missing required address authorization entries.") {
    super(message);
    this.name = "MissingAuthError";
  }
}

export class ContractExecutionError extends SorobanSdkError {
  public code: number;
  public errorName: string;
  public rawResultXdr?: string;
  public rawRpcResponse?: unknown;

  constructor(code: number, errorName: string, rawResultXdr?: string, rawRpcResponse?: unknown) {
    super(`Contract execution reverted with VaultError code ${code} (${errorName})`);
    this.name = "ContractExecutionError";
    this.code = code;
    this.errorName = errorName;
    this.rawResultXdr = rawResultXdr;
    this.rawRpcResponse = rawRpcResponse;
  }
}

export function parseContractError(code: number, rawResultXdr?: string, rawRpcResponse?: unknown): ContractExecutionError {
  const errorInfo = (VaultError as Record<number, { message: string }>)[code];
  const errorName = errorInfo ? errorInfo.message : `UnknownError_${code}`;
  return new ContractExecutionError(code, errorName, rawResultXdr, rawRpcResponse);
}
