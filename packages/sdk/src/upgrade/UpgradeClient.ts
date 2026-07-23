import {
  Contract,
  rpc,
  Address,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  Networks,
  Account,
  BASE_FEE,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  UpgradeConfig,
  ContractVersionInfo,
  ScheduleUpgradeParams,
  MigrateParams,
  MigrationStatusInfo,
} from "../types";

export class UpgradeClient {
  private config: UpgradeConfig;
  private server: rpc.Server;

  constructor(config: UpgradeConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
  }

  private async buildInvokeTx(op: xdr.Operation) {
    const source = new Account(
      this.config.simulationAccount ??
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "0",
    );

    return new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase:
        this.config.networkPassphrase ?? Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
  }

  private getSimResult(sim: any) {
    if ("error" in sim && sim.error) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    if (!("result" in sim) || !sim.result) {
      throw new Error("Simulation returned no result");
    }
    return sim.result;
  }

  async checkAndThrow(
    minSpecVersion: number,
    minStorageVersion: number,
  ): Promise<ContractVersionInfo> {
    const info = await this.getVersions();

    if (
      info.contractVersion < minSpecVersion ||
      info.storageVersion < minStorageVersion
    ) {
      const { IncompatibleContractError } = await import("../types");
      throw new IncompatibleContractError(
        info.contractVersion,
        info.storageVersion,
        minSpecVersion,
        minStorageVersion,
      );
    }

    return info;
  }

  async getVersions(): Promise<ContractVersionInfo> {
    const contract = new Contract(this.config.contractId);

    const [cvSim, svSim] = await Promise.all([
      this.server.simulateTransaction(
        await this.buildInvokeTx(contract.call("contract_version")),
      ),
      this.server.simulateTransaction(
        await this.buildInvokeTx(contract.call("storage_version")),
      ),
    ]);

    const cv = this.getSimResult(cvSim);
    const sv = this.getSimResult(svSim);

    return {
      contractVersion: Number(scValToNative(cv.retval)),
      storageVersion: Number(scValToNative(sv.retval)),
    };
  }

  async scheduleUpgrade(params: ScheduleUpgradeParams): Promise<void> {
    const contract = new Contract(this.config.contractId);
    const governance = Address.fromString(params.governance);

    const tx = await this.buildInvokeTx(
      contract.call(
        "schedule_upgrade",
        governance.toScVal(),
        nativeToScVal(params.wasmHash, { type: "bytes" }),
        nativeToScVal(params.expectedCurrentHash, { type: "bytes" }),
        nativeToScVal(params.migrationId, { type: "u32" }),
      ),
    );

    await this.server.simulateTransaction(tx);
  }

  async cancelUpgrade(governance: string): Promise<void> {
    const contract = new Contract(this.config.contractId);
    const governanceAddr = Address.fromString(governance);

    const tx = await this.buildInvokeTx(
      contract.call("cancel_upgrade", governanceAddr.toScVal()),
    );

    await this.server.simulateTransaction(tx);
  }

  async executeUpgrade(governance: string): Promise<void> {
    const contract = new Contract(this.config.contractId);
    const governanceAddr = Address.fromString(governance);

    const tx = await this.buildInvokeTx(
      contract.call("execute_upgrade", governanceAddr.toScVal()),
    );

    await this.server.simulateTransaction(tx);
  }

  async migrate(params: MigrateParams): Promise<string | null> {
    const contract = new Contract(this.config.contractId);
    const governance = Address.fromString(params.governance);
    const cursorVal = params.cursor
      ? nativeToScVal(params.cursor, { type: "bytes" })
      : nativeToScVal(null, { type: "symbol" });

    const tx = await this.buildInvokeTx(
      contract.call(
        "migrate",
        governance.toScVal(),
        nativeToScVal(params.fromVersion, { type: "u32" }),
        nativeToScVal(params.toVersion, { type: "u32" }),
        cursorVal,
        nativeToScVal(params.limit, { type: "u32" }),
      ),
    );

    const sim = await this.server.simulateTransaction(tx);
    const result = this.getSimResult(sim);
    const raw = scValToNative(result.retval);
    if (raw === null || raw === undefined) return null;
    return raw.toString();
  }

  async migrationStatus(): Promise<MigrationStatusInfo> {
    const contract = new Contract(this.config.contractId);

    const tx = await this.buildInvokeTx(
      contract.call("migration_status"),
    );

    const sim = await this.server.simulateTransaction(tx);
    const result = this.getSimResult(sim);
    const raw: any = scValToNative(result.retval);
    return {
      isActive: raw.is_active,
      fromVersion: raw.from_version,
      toVersion: raw.to_version,
      progress: raw.progress,
      totalBatches: raw.total_batches,
      cursor: raw.cursor ? raw.cursor.toString() : null,
    };
  }
}
