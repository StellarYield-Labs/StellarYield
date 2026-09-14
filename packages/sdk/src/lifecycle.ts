import {
  rpc as SorobanRpc,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  InvalidXdrError,
  parseContractError,
  SorobanSdkError,
  StaleSimulationError,
  SubmissionTimeoutError,
  WrongNetworkError,
} from "./errors";
import { SignerAdapter } from "./signers";

export type TransactionStatus =
  | "CREATED"
  | "SIMULATED"
  | "AUTHORIZED"
  | "SIGNED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED";

export interface PreparedTxData<T> {
  contractId: string;
  methodName: string;
  unsignedXdr: string;
  footprint: string;
  minResourceFee: string;
  validUntilLedger: number;
  contractSpecHash: string;
  networkPassphrase: string;
  simulationResult?: T;
  authEntries?: string[];
  server: SorobanRpc.Server;
  parseResultFn?: (nativeScVal: any) => T;
}

export interface WaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PreparedTransaction<T = any> {
  public readonly status: TransactionStatus = "SIMULATED";
  public readonly contractId: string;
  public readonly methodName: string;
  public readonly unsignedXdr: string;
  public readonly footprint: string;
  public readonly minResourceFee: string;
  public readonly validUntilLedger: number;
  public readonly contractSpecHash: string;
  public readonly networkPassphrase: string;
  public readonly simulationResult?: T;
  public readonly authEntries: string[];

  private server: SorobanRpc.Server;
  private parseResultFn?: (nativeScVal: any) => T;

  constructor(data: PreparedTxData<T>) {
    this.contractId = data.contractId;
    this.methodName = data.methodName;
    this.unsignedXdr = data.unsignedXdr;
    this.footprint = data.footprint;
    this.minResourceFee = data.minResourceFee;
    this.validUntilLedger = data.validUntilLedger;
    this.contractSpecHash = data.contractSpecHash;
    this.networkPassphrase = data.networkPassphrase;
    this.simulationResult = data.simulationResult;
    this.authEntries = data.authEntries || [];
    this.server = data.server;
    this.parseResultFn = data.parseResultFn;
  }

  toXDR(): string {
    return this.unsignedXdr;
  }

  toJSON() {
    return {
      status: this.status,
      contractId: this.contractId,
      methodName: this.methodName,
      unsignedXdr: this.unsignedXdr,
      footprint: this.footprint,
      minResourceFee: this.minResourceFee,
      validUntilLedger: this.validUntilLedger,
      contractSpecHash: this.contractSpecHash,
      networkPassphrase: this.networkPassphrase,
      authEntriesCount: this.authEntries.length,
    };
  }

  async sign(signer: SignerAdapter): Promise<SignedTransaction<T>> {
    const signerPubKey = await signer.getPublicKey();
    const signedXdr = await signer.signTransaction(this.unsignedXdr, {
      networkPassphrase: this.networkPassphrase,
    });

    return new SignedTransaction<T>({
      contractId: this.contractId,
      methodName: this.methodName,
      signedXdr,
      validUntilLedger: this.validUntilLedger,
      contractSpecHash: this.contractSpecHash,
      networkPassphrase: this.networkPassphrase,
      signerPublicKey: signerPubKey,
      server: this.server,
      parseResultFn: this.parseResultFn,
    });
  }
}

export interface SignedTxData<T> {
  contractId: string;
  methodName: string;
  signedXdr: string;
  validUntilLedger: number;
  contractSpecHash: string;
  networkPassphrase: string;
  signerPublicKey?: string;
  server: SorobanRpc.Server;
  parseResultFn?: (nativeScVal: any) => T;
}

export class SignedTransaction<T = any> {
  public readonly status: TransactionStatus = "SIGNED";
  public readonly contractId: string;
  public readonly methodName: string;
  public readonly signedXdr: string;
  public readonly validUntilLedger: number;
  public readonly contractSpecHash: string;
  public readonly networkPassphrase: string;
  public readonly signerPublicKey?: string;

  private server: SorobanRpc.Server;
  private parseResultFn?: (nativeScVal: any) => T;

  constructor(data: SignedTxData<T>) {
    this.contractId = data.contractId;
    this.methodName = data.methodName;
    this.signedXdr = data.signedXdr;
    this.validUntilLedger = data.validUntilLedger;
    this.contractSpecHash = data.contractSpecHash;
    this.networkPassphrase = data.networkPassphrase;
    this.signerPublicKey = data.signerPublicKey;
    this.server = data.server;
    this.parseResultFn = data.parseResultFn;
  }

  toXDR(): string {
    return this.signedXdr;
  }

  async submit(): Promise<SubmittedTransaction<T>> {
    // Validate envelope structure before submitting
    let tx;
    try {
      tx = TransactionBuilder.fromXDR(this.signedXdr, this.networkPassphrase);
    } catch (err: any) {
      throw new InvalidXdrError(err?.message || "Failed to parse signed XDR", this.signedXdr);
    }

    const latestLedger = await this.server.getLatestLedger();
    if (latestLedger.sequence > this.validUntilLedger) {
      throw new StaleSimulationError(this.validUntilLedger, latestLedger.sequence);
    }

    const sendResp = await this.server.sendTransaction(tx as any);
    if (sendResp.status === "ERROR" || !sendResp.hash) {
      const errCode = (sendResp as any).errorResultXdr;
      throw parseContractError(999, errCode, sendResp);
    }

    return new SubmittedTransaction<T>({
      txHash: sendResp.hash,
      validUntilLedger: this.validUntilLedger,
      contractSpecHash: this.contractSpecHash,
      networkPassphrase: this.networkPassphrase,
      server: this.server,
      parseResultFn: this.parseResultFn,
    });
  }
}

export interface SubmittedTxData<T> {
  txHash: string;
  validUntilLedger: number;
  contractSpecHash: string;
  networkPassphrase: string;
  server: SorobanRpc.Server;
  parseResultFn?: (nativeScVal: any) => T;
}

export class SubmittedTransaction<T = any> {
  public readonly status: TransactionStatus = "SUBMITTED";
  public readonly txHash: string;
  public readonly validUntilLedger: number;
  public readonly contractSpecHash: string;
  public readonly networkPassphrase: string;

  private server: SorobanRpc.Server;
  private parseResultFn?: (nativeScVal: any) => T;

  constructor(data: SubmittedTxData<T>) {
    this.txHash = data.txHash;
    this.validUntilLedger = data.validUntilLedger;
    this.contractSpecHash = data.contractSpecHash;
    this.networkPassphrase = data.networkPassphrase;
    this.server = data.server;
    this.parseResultFn = data.parseResultFn;
  }

  toHash(): string {
    return this.txHash;
  }

  static fromHash<T = any>(
    txHash: string,
    server: SorobanRpc.Server,
    meta: {
      validUntilLedger?: number;
      contractSpecHash?: string;
      networkPassphrase?: string;
      parseResultFn?: (nativeScVal: any) => T;
    }
  ): SubmittedTransaction<T> {
    return new SubmittedTransaction<T>({
      txHash,
      validUntilLedger: meta.validUntilLedger ?? Number.MAX_SAFE_INTEGER,
      contractSpecHash: meta.contractSpecHash ?? "",
      networkPassphrase: meta.networkPassphrase ?? "",
      server,
      parseResultFn: meta.parseResultFn,
    });
  }

  async wait(options: WaitOptions = {}): Promise<ConfirmedTransaction<T>> {
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (options.signal?.aborted) {
        throw new SorobanSdkError("Transaction confirmation polling aborted.");
      }

      const txStatus = await this.server.getTransaction(this.txHash);

      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        let parsedResult: any = undefined;
        let rawResultXdr: string | undefined = undefined;

        if (txStatus.resultMetaXdr) {
          rawResultXdr = txStatus.resultMetaXdr.toXDR("base64");
        }

        if (txStatus.returnValue) {
          const nativeVal = scValToNative(txStatus.returnValue);
          parsedResult = this.parseResultFn ? this.parseResultFn(nativeVal) : nativeVal;
        }

        return new ConfirmedTransaction<T>({
          txHash: this.txHash,
          ledgerSequence: txStatus.ledger,
          result: parsedResult as T,
          rawResultXdr,
        });
      }

      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        const rawMetaXdr = txStatus.resultMetaXdr ? txStatus.resultMetaXdr.toXDR("base64") : undefined;
        throw parseContractError(999, rawMetaXdr, txStatus);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new SubmissionTimeoutError(this.txHash, timeoutMs);
  }
}

export interface ConfirmedTxData<T> {
  txHash: string;
  ledgerSequence: number;
  result: T;
  rawResultXdr?: string;
}

export class ConfirmedTransaction<T = any> {
  public readonly status: TransactionStatus = "CONFIRMED";
  public readonly txHash: string;
  public readonly ledgerSequence: number;
  public readonly result: T;
  public readonly rawResultXdr?: string;

  constructor(data: ConfirmedTxData<T>) {
    this.txHash = data.txHash;
    this.ledgerSequence = data.ledgerSequence;
    this.result = data.result;
    this.rawResultXdr = data.rawResultXdr;
  }
}
