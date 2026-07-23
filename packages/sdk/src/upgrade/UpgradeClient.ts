import { Contract, rpc, Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import type {
  UpgradeConfig,
  ContractVersionInfo,
  ScheduleUpgradeParams,
  MigrateParams,
  MigrationStatusInfo,
  IncompatibleContractError,
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

    const [cvResult, svResult] = await Promise.all([
      this.server.simulateTransaction(contract.call("contract_version")),
      this.server.simulateTransaction(contract.call("storage_version")),
    ]);

    return {
      contractVersion: Number(scValToNative(cvResult.result!.retval)),
      storageVersion: Number(scValToNative(svResult.result!.retval)),
    };
  }

  async scheduleUpgrade(params: ScheduleUpgradeParams): Promise<void> {
    const contract = new Contract(this.config.contractId);
    const governance = Address.fromString(params.governance);

    await this.server.simulateTransaction(
      contract.call(
        "schedule_upgrade",
        governance.toScVal(),
        nativeToScVal(params.wasmHash, { type: "bytes" }),
        nativeToScVal(params.expectedCurrentHash, { type: "bytes" }),
        nativeToScVal(params.migrationId, { type: "u32" }),
      ),
    );
  }

  async cancelUpgrade(governance: string): Promise<void> {
    const contract = new Contract(this.config.contractId);
    const governanceAddr = Address.fromString(governance);

    await this.server.simulateTransaction(
      contract.call("cancel_upgrade", governanceAddr.toScVal()),
    );
  }

  async executeUpgrade(governance: string): Promise<void> {
    const contract = new Contract(this.config.contractId);
    const governanceAddr = Address.fromString(governance);

    await this.server.simulateTransaction(
      contract.call("execute_upgrade", governanceAddr.toScVal()),
    );
  }

  async migrate(params: MigrateParams): Promise<string | null> {
    const contract = new Contract(this.config.contractId);
    const governance = Address.fromString(params.governance);
    const cursorVal = params.cursor
      ? nativeToScVal(params.cursor, { type: "bytes" })
      : nativeToScVal(null, { type: "symbol" });

    const result = await this.server.simulateTransaction(
      contract.call(
        "migrate",
        governance.toScVal(),
        nativeToScVal(params.fromVersion, { type: "u32" }),
        nativeToScVal(params.toVersion, { type: "u32" }),
        cursorVal,
        nativeToScVal(params.limit, { type: "u32" }),
      ),
    );

    const raw = scValToNative(result.result!.retval);
    if (raw === null || raw === undefined) return null;
    return raw.toString();
  }

  async migrationStatus(): Promise<MigrationStatusInfo> {
    const contract = new Contract(this.config.contractId);

    const result = await this.server.simulateTransaction(
      contract.call("migration_status"),
    );

    const raw: any = scValToNative(result.result!.retval);
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
