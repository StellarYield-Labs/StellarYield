import { describe, expect, it, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  ContractExecutionError,
  CustomSigner,
  FreighterSigner,
  parseContractError,
  PreparedTransaction,
  ServerKeypairSigner,
  SpecMismatchError,
  StaleSimulationError,
  SubmissionTimeoutError,
  VaultClient,
  YIELD_VAULT_SPEC_HASH,
} from "../src";

describe("SDK Error Hierarchy & Error Parsing", () => {
  it("should decode known VaultError codes accurately", () => {
    const err1 = parseContractError(1);
    expect(err1).toBeInstanceOf(ContractExecutionError);
    expect(err1.code).toBe(1);
    expect(err1.errorName).toBe("NotInitialized");

    const err4 = parseContractError(4);
    expect(err4.errorName).toBe("InsufficientShares");

    const err2001 = parseContractError(2001);
    expect(err2001.errorName).toBe("InvalidDonationBps");
  });

  it("should handle unknown error codes gracefully", () => {
    const unknownErr = parseContractError(9999);
    expect(unknownErr.errorName).toBe("UnknownError_9999");
  });

  it("should construct SpecMismatchError properly", () => {
    const err = new SpecMismatchError("expected_hash", "actual_hash");
    expect(err.message).toContain("expected_hash");
    expect(err.message).toContain("actual_hash");
  });

  it("should throw SpecMismatchError when initializing VaultClient with wrong hash", () => {
    expect(() => {
      new VaultClient({
        contractId: "CC123",
        networkPassphrase: Networks.TESTNET,
        rpcUrl: "http://localhost:8000",
        specHashPin: "wrong_hash_123",
      });
    }).toThrow(SpecMismatchError);
  });
});

describe("Signer Adapters", () => {
  const kp = Keypair.random();

  it("ServerKeypairSigner should sign correctly", async () => {
    const signer = new ServerKeypairSigner(kp.secret());
    const pubKey = await signer.getPublicKey();
    expect(pubKey).toBe(kp.publicKey());
  });

  it("FreighterSigner should delegate to window.freighter", async () => {
    const mockFreighter = {
      getPublicKey: vi.fn().mockResolvedValue("G_FREIGHTER_PUBKEY"),
      signTransaction: vi.fn().mockResolvedValue("SIGNED_XDR_MOCK"),
    };

    const signer = new FreighterSigner(mockFreighter);
    const pubKey = await signer.getPublicKey();
    expect(pubKey).toBe("G_FREIGHTER_PUBKEY");

    const signed = await signer.signTransaction("UNSIGNED_XDR", {
      networkPassphrase: Networks.TESTNET,
    });
    expect(signed).toBe("SIGNED_XDR_MOCK");
    expect(mockFreighter.signTransaction).toHaveBeenCalledWith("UNSIGNED_XDR", {
      networkPassphrase: Networks.TESTNET,
    });
  });

  it("CustomSigner should delegate to custom callbacks", async () => {
    const signer = new CustomSigner(
      async () => "CUSTOM_PUB",
      async (xdr) => `SIGNED_${xdr}`
    );

    expect(await signer.getPublicKey()).toBe("CUSTOM_PUB");
    expect(await signer.signTransaction("TX", { networkPassphrase: "NET" })).toBe("SIGNED_TX");
  });
});

describe("PreparedTransaction State Machine", () => {
  it("should serialize to JSON with correct metadata", () => {
    const prep = new PreparedTransaction({
      contractId: "C123",
      methodName: "deposit",
      unsignedXdr: "AAAA...",
      footprint: "FOOTPRINT...",
      minResourceFee: "100",
      validUntilLedger: 500,
      contractSpecHash: YIELD_VAULT_SPEC_HASH,
      networkPassphrase: Networks.TESTNET,
      authEntries: ["AUTH1"],
      server: {} as any,
    });

    const json = prep.toJSON();
    expect(json.status).toBe("SIMULATED");
    expect(json.contractId).toBe("C123");
    expect(json.methodName).toBe("deposit");
    expect(json.authEntriesCount).toBe(1);
    expect(prep.toXDR()).toBe("AAAA...");
  });
});
