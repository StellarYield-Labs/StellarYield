import { describe, it, expect } from "@jest/globals";
import {
  canonicalizeSignerSet,
  canonicalizeThresholdPayload,
  computeThresholdPreviewHashes,
  normalizeSigners,
  validateThresholdUpdate,
} from "./thresholdPreviewHash";

const SIGNER_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SIGNER_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SIGNER_C = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const CONTRACT_ID = "CCONTRACT1234567890123456789012345678901234567890123456789012";
const PROPOSER = SIGNER_A;

describe("thresholdPreviewHash service", () => {
  it("normalizes signer ordering deterministically", () => {
    expect(normalizeSigners([SIGNER_C, SIGNER_A])).toEqual([SIGNER_A, SIGNER_C]);
  });

  it("rejects duplicate signers and invalid thresholds", () => {
    expect(
      validateThresholdUpdate({ signers: [SIGNER_A, SIGNER_A], threshold: 1 }),
    ).toEqual([
      expect.objectContaining({ field: "signers" }),
    ]);
    expect(
      validateThresholdUpdate({ signers: [SIGNER_A, SIGNER_B], threshold: 5 }),
    ).toEqual([
      expect.objectContaining({ field: "threshold" }),
    ]);
  });

  it("returns stable hashes for equivalent signer sets", () => {
    const first = computeThresholdPreviewHashes({
      contractId: CONTRACT_ID,
      signers: [SIGNER_B, SIGNER_A],
      threshold: 2,
      proposer: PROPOSER,
    });
    const second = computeThresholdPreviewHashes({
      contractId: CONTRACT_ID,
      signers: [SIGNER_A, SIGNER_B],
      threshold: 2,
      proposer: PROPOSER,
    });

    expect(first).toEqual(second);
  });

  it("changes payload hash when threshold changes", () => {
    const baseline = computeThresholdPreviewHashes({
      contractId: CONTRACT_ID,
      signers: [SIGNER_A, SIGNER_B, SIGNER_C],
      threshold: 2,
      proposer: PROPOSER,
    });
    const changed = computeThresholdPreviewHashes({
      contractId: CONTRACT_ID,
      signers: [SIGNER_A, SIGNER_B, SIGNER_C],
      threshold: 3,
      proposer: PROPOSER,
    });

    expect(changed.signerSetHash).toBe(baseline.signerSetHash);
    expect(changed.payloadHash).not.toBe(baseline.payloadHash);
  });

  it("uses canonical wire format", () => {
    expect(canonicalizeSignerSet([SIGNER_B, SIGNER_A])).toContain(SIGNER_A);
    expect(
      canonicalizeThresholdPayload({
        contractId: CONTRACT_ID,
        signers: [SIGNER_A],
        threshold: 1,
        proposer: PROPOSER,
      }),
    ).toContain("update_threshold");
  });
});
