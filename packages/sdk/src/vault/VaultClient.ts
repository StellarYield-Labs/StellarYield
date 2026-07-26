import { Buffer } from "buffer";
import {
  Account,
  Address,
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  XdrLargeInt,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ContractVersionMismatchError,
  MigrationInProgressError,
  parseContractError,
  SpecMismatchError,
  SorobanSdkError,
  StorageVersionMismatchError,
} from "../errors";
import { YIELD_VAULT_SPEC_HASH } from "../generated/yield_vault";
import { PreparedTransaction } from "../lifecycle";
import type {
  DepositParams,
  EmergencyWithdrawParams,
  HarvestParams,
  MigrationStatus,
  RebalanceParams,
  UpgradeProposal,
  VaultConfig,
  VaultInfo,
  WithdrawParams,
} from "../types";

export class VaultClient {
  private config: VaultConfig;
  private server: SorobanRpc.Server;

  constructor(config: VaultConfig) {
    if (config.specHashPin && config.specHashPin !== YIELD_VAULT_SPEC_HASH) {
      throw new SpecMismatchError(YIELD_VAULT_SPEC_HASH, config.specHashPin);
    }
    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
  }

  // ── Version compatibility checks ─────────────────────────────────────

  async checkContractVersion(): Promise<void> {
    if (!this.config.contractVersionPin) return;
    const actual = await this.queryReadOnly<string>("contract_version");
    if (actual !== this.config.contractVersionPin) {
      throw new ContractVersionMismatchError(
        "yield_vault",
        this.config.contractVersionPin,
        actual,
      );
    }
  }

  async checkStorageVersion(): Promise<void> {
    if (!this.config.storageVersionPin) return;
    const raw = await this.queryReadOnly<number>("storage_version");
    const actual = Number(raw);
    if (actual !== this.config.storageVersionPin) {
      throw new StorageVersionMismatchError(
        "yield_vault",
        this.config.storageVersionPin,
        actual,
      );
    }
  }

  async checkIsMigrating(): Promise<void> {
    const migrating = await this.queryReadOnly<boolean>("is_migrating");
    if (migrating) {
      throw new MigrationInProgressError("yield_vault");
    }
  }

  async checkAllVersions(): Promise<void> {
    await this.checkContractVersion();
    await this.checkStorageVersion();
  }

  // ── Upgrade & migration queries ──────────────────────────────────────

  async getContractVersion(): Promise<string> {
    return this.queryReadOnly<string>("contract_version");
  }

  async getStorageVersion(): Promise<number> {
    const raw = await this.queryReadOnly<number>("storage_version");
    return Number(raw);
  }

  async getMigrationStatus(): Promise<MigrationStatus | null> {
    const raw = await this.queryReadOnly<any>("migration_status");
    if (!raw) return null;
    return {
      fromVersion: Number(raw.from_version),
      toVersion: Number(raw.to_version),
      cursor: raw.cursor.toString(),
      totalApplied: Number(raw.total_applied),
      complete: raw.complete,
    } as MigrationStatus;
  }

  async isMigrating(): Promise<boolean> {
    return this.queryReadOnly<boolean>("is_migrating");
  }

  // ── Upgrade actions (governance-gated) ────────────────────────────────

  async prepareUpgrade(
    governance: string,
    targetWasmHash: string,
    migrationPlanDigest: string,
    migrationId: string,
    timelockSeconds: string,
  ): Promise<PreparedTransaction<string>> {
    const wasmHashBytes = Buffer.from(targetWasmHash, "hex");
    const planDigestBytes = Buffer.from(migrationPlanDigest, "hex");
    return this.prepareStateCall(
      "upgrade",
      [
        Address.fromString(governance).toScVal(),
        xdr.ScVal.scvBytes(wasmHashBytes),
        xdr.ScVal.scvBytes(planDigestBytes),
        xdr.ScVal.scvString(migrationId),
        new XdrLargeInt("u64", timelockSeconds).toScVal(),
      ],
      governance,
      (val) => val.toString(),
    );
  }

  async prepareExecuteUpgrade(
    governance: string,
    proposalId: string,
  ): Promise<PreparedTransaction<void>> {
    return this.prepareStateCall(
      "execute_upgrade",
      [
        Address.fromString(governance).toScVal(),
        new XdrLargeInt("u64", proposalId).toScVal(),
      ],
      governance,
    );
  }

  async prepareFinalizeUpgrade(
    governance: string,
    proposalId: string,
  ): Promise<PreparedTransaction<void>> {
    return this.prepareStateCall(
      "finalize_upgrade",
      [
        new XdrLargeInt("u64", proposalId).toScVal(),
      ],
      governance,
    );
  }

  async prepareMigrate(
    governance: string,
    fromVersion: number,
    toVersion: number,
    cursor: string,
    limit: number,
  ): Promise<PreparedTransaction<any>> {
    return this.prepareStateCall(
      "migrate",
      [
        xdr.ScVal.scvU32(fromVersion),
        xdr.ScVal.scvU32(toVersion),
        new XdrLargeInt("u64", cursor).toScVal(),
        xdr.ScVal.scvU32(limit),
      ],
      governance,
    );
  }

  // ── Original methods ─────────────────────────────────────────────────

  public get deposit() {
    return {
      prepare: async (params: DepositParams): Promise<PreparedTransaction<string>> => {
        const fromAddress = Address.fromString(params.from);
        const amount = new XdrLargeInt("i128", params.amount);
        const minSharesOut = new XdrLargeInt("i128", params.minSharesOut ?? "0");

        return this.prepareStateCall(
          "deposit",
          [fromAddress.toScVal(), amount.toScVal(), minSharesOut.toScVal()],
          params.from,
          (val) => val.toString()
        );
      },
    };
  }

  public get withdraw() {
    return {
      prepare: async (params: WithdrawParams): Promise<PreparedTransaction<string>> => {
        const toAddress = Address.fromString(params.to);
        const shares = new XdrLargeInt("i128", params.shares);

        return this.prepareStateCall(
          "withdraw",
          [toAddress.toScVal(), shares.toScVal()],
          params.to,
          (val) => val.toString()
        );
      },
    };
  }

  public get harvest() {
    return {
      prepare: async (params: HarvestParams): Promise<PreparedTransaction<string>> => {
        const callerAddress = Address.fromString(params.caller);
        const minAmountOut = new XdrLargeInt("i128", params.minAmountOut);

        return this.prepareStateCall(
          "harvest",
          [callerAddress.toScVal(), minAmountOut.toScVal()],
          params.caller,
          (val) => val.toString()
        );
      },
    };
  }

  public get rebalance() {
    return {
      prepare: async (params: RebalanceParams): Promise<PreparedTransaction<void>> => {
        const callerAddress = Address.fromString(params.caller);
        const targetAddress = Address.fromString(params.target);
        const amount = new XdrLargeInt("i128", params.amount);

        return this.prepareStateCall(
          "rebalance",
          [callerAddress.toScVal(), targetAddress.toScVal(), amount.toScVal()],
          params.caller
        );
      },
    };
  }

  public get emergencyWithdraw() {
    return {
      prepare: async (params: EmergencyWithdrawParams): Promise<PreparedTransaction<string>> => {
        const toAddress = Address.fromString(params.to);
        const shares = new XdrLargeInt("i128", params.shares);

        return this.prepareStateCall(
          "emergency_withdraw",
          [toAddress.toScVal(), shares.toScVal()],
          params.to,
          (val) => val.toString()
        );
      },
    };
  }

  // --- Read-Only Query Methods ---

  async getShares(user: string): Promise<string> {
    const userAddress = Address.fromString(user);
    return this.queryReadOnly("get_shares", [userAddress.toScVal()], (val) => val.toString());
  }

  async totalShares(): Promise<string> {
    return this.queryReadOnly("total_shares", [], (val) => val.toString());
  }

  async totalAssets(): Promise<string> {
    return this.queryReadOnly("total_assets", [], (val) => val.toString());
  }

  async convertToShares(assets: string): Promise<string> {
    const assetsVal = new XdrLargeInt("i128", assets);
    return this.queryReadOnly("convert_to_shares", [assetsVal.toScVal()], (val) => val.toString());
  }

  async convertToAssets(shares: string): Promise<string> {
    const sharesVal = new XdrLargeInt("i128", shares);
    return this.queryReadOnly("convert_to_assets", [sharesVal.toScVal()], (val) => val.toString());
  }

  async previewDeposit(assets: string): Promise<string> {
    const assetsVal = new XdrLargeInt("i128", assets);
    return this.queryReadOnly("preview_deposit", [assetsVal.toScVal()], (val) => val.toString());
  }

  async getFlashLoanFee(amount: string): Promise<string> {
    const amountVal = new XdrLargeInt("i128", amount);
    return this.queryReadOnly("get_flash_loan_fee", [amountVal.toScVal()], (val) => val.toString());
  }

  async getInfo(): Promise<VaultInfo> {
    const [shares, assets, token, admin] = await Promise.all([
      this.totalShares(),
      this.totalAssets(),
      this.queryReadOnly<string>("get_token"),
      this.queryReadOnly<string>("get_admin"),
    ]);

    return {
      totalShares: shares,
      totalAssets: assets,
      token,
      admin,
    };
  }

  private async prepareStateCall<T>(
    methodName: string,
    args: xdr.ScVal[],
    sourceAccount: string,
    parseResultFn?: (nativeScVal: any) => T
  ): Promise<PreparedTransaction<T>> {
    let account;
    try {
      account = await this.server.getAccount(sourceAccount);
    } catch (err: any) {
      // Fallback dummy account for offline/simulation testing if source account is uninitialized
      account = new Account(sourceAccount, "0");
    }

    const contract = new Contract(this.config.contractId);
    const op = contract.call(methodName, ...args);
    const rawTx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(op)
      .setTimeout(100)
      .build();

    const simRes = await this.server.simulateTransaction(rawTx);
    if (SorobanRpc.Api.isSimulationError(simRes)) {
      throw parseContractError(999, simRes.error, simRes);
    }

    const preparedTx = await this.server.prepareTransaction(rawTx);
    const unsignedXdr = preparedTx.toXDR();

    let simulationResult: T | undefined = undefined;
    if (simRes.result?.retval) {
      const nativeVal = scValToNative(simRes.result.retval);
      simulationResult = parseResultFn ? parseResultFn(nativeVal) : nativeVal;
    }

    const latestLedger = (simRes as any).latestLedger || 100000;

    return new PreparedTransaction<T>({
      contractId: this.config.contractId,
      methodName,
      unsignedXdr,
      footprint: preparedTx.toXDR(),
      minResourceFee: preparedTx.fee,
      validUntilLedger: latestLedger + 100,
      contractSpecHash: YIELD_VAULT_SPEC_HASH,
      networkPassphrase: this.config.networkPassphrase,
      simulationResult,
      authEntries: simRes.result?.auth ? simRes.result.auth.map((a: any) => a.toXDR("base64")) : [],
      server: this.server,
      parseResultFn,
    });
  }

  private async queryReadOnly<T>(
    methodName: string,
    args: xdr.ScVal[] = [],
    parseResultFn?: (val: any) => T
  ): Promise<T> {
    const dummyAccount = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
    const contract = new Contract(this.config.contractId);
    const tx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call(methodName, ...args))
      .setTimeout(100)
      .build();

    const simRes = await this.server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simRes)) {
      throw parseContractError(999, simRes.error, simRes);
    }

    if (!simRes.result?.retval) {
      throw new SorobanSdkError(`Simulation for method '${methodName}' returned no retval.`);
    }

    const native = scValToNative(simRes.result.retval);
    return parseResultFn ? parseResultFn(native) : (native as T);
  }
}
