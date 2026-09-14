import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { WalletRejectedError } from "./errors";

export interface SignerAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(
    unsignedXdr: string,
    options: { networkPassphrase: string }
  ): Promise<string>;
}

export class ServerKeypairSigner implements SignerAdapter {
  private keypair: Keypair;

  constructor(secretKey: string) {
    this.keypair = Keypair.fromSecret(secretKey);
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(
    unsignedXdr: string,
    options: { networkPassphrase: string }
  ): Promise<string> {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, options.networkPassphrase);
    tx.sign(this.keypair);
    return tx.toXDR();
  }
}

export class FreighterSigner implements SignerAdapter {
  private freighterApi?: {
    getPublicKey(): Promise<string>;
    signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string>;
  };

  constructor(customApi?: any) {
    this.freighterApi = customApi || (typeof window !== "undefined" ? (window as any).freighter : undefined);
  }

  async getPublicKey(): Promise<string> {
    if (!this.freighterApi && typeof window !== "undefined") {
      this.freighterApi = (window as any).freighter;
    }
    if (!this.freighterApi) {
      throw new WalletRejectedError("Freighter wallet extension is not available in window context.");
    }
    try {
      return await this.freighterApi.getPublicKey();
    } catch (err: any) {
      throw new WalletRejectedError(err?.message || "User denied public key request.");
    }
  }

  async signTransaction(
    unsignedXdr: string,
    options: { networkPassphrase: string }
  ): Promise<string> {
    if (!this.freighterApi && typeof window !== "undefined") {
      this.freighterApi = (window as any).freighter;
    }
    if (!this.freighterApi) {
      throw new WalletRejectedError("Freighter wallet extension is not available in window context.");
    }
    try {
      const signed = await this.freighterApi.signTransaction(unsignedXdr, {
        networkPassphrase: options.networkPassphrase,
      });
      if (!signed) {
        throw new WalletRejectedError("User rejected transaction signature.");
      }
      return signed;
    } catch (err: any) {
      if (err instanceof WalletRejectedError) throw err;
      throw new WalletRejectedError(err?.message || "Failed to sign with Freighter.");
    }
  }
}

export class CustomSigner implements SignerAdapter {
  constructor(
    private publicKeyFn: () => Promise<string>,
    private signFn: (xdr: string, opts: { networkPassphrase: string }) => Promise<string>
  ) {}

  async getPublicKey(): Promise<string> {
    return this.publicKeyFn();
  }

  async signTransaction(
    unsignedXdr: string,
    options: { networkPassphrase: string }
  ): Promise<string> {
    return this.signFn(unsignedXdr, options);
  }
}

export class OfflineSigner {
  static exportUnsignedXdr(unsignedXdr: string): string {
    return unsignedXdr;
  }

  static importSignedXdr(signedXdr: string): string {
    return signedXdr;
  }
}
