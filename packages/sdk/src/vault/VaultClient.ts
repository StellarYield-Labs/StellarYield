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
import { parseContractError, SpecMismatchError, SorobanSdkError } from "../errors";
import { YIELD_VAULT_SPEC_HASH } from "../generated/yield_vault";
import { PreparedTransaction } from "../lifecycle";
import type {
  DepositParams,
  EmergencyWithdrawParams,
  HarvestParams,
  RebalanceParams,
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
