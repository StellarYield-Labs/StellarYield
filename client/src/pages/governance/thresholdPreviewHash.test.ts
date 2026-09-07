import { describe, it, expect } from "vitest";
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

describe("thresholdPreviewHash", () => {
  describe("normalizeSigners", () => {
    it("sorts signers deterministically regardless of input order", () => {
      expect(normalizeSigners([SIGNER_C, SIGNER_A, SIGNER_B])).toEqual([
        SIGNER_A,
        SIGNER_B,
        SIGNER_C,
      ]);
      expect(normalizeSigners([SIGNER_B, SIGNER_A, SIGNER_C])).toEqual([
        SIGNER_A,
        SIGNER_B,
        SIGNER_C,
      ]);
    });

    it("trims whitespace and ignores empty lines", () => {
      expect(normalizeSigners([` ${SIGNER_A} `, "", `  ${SIGNER_B}`])).toEqual([
        SIGNER_A,
        SIGNER_B,
      ]);
    });
  });

  describe("validateThresholdUpdate", () => {
    it("rejects duplicate signers", () => {
      const errors = validateThresholdUpdate({
        signers: [SIGNER_A, SIGNER_A],
        threshold: 1,
      });
      expect(errors.some((error) => error.message.includes("Duplicate"))).toBe(true);
    });

    it("rejects invalid thresholds", () => {
      expect(
        validateThresholdUpdate({ signers: [SIGNER_A, SIGNER_B], threshold: 0 }),
      ).toEqual([
        expect.objectContaining({ field: "threshold" }),
      ]);

      expect(
        validateThresholdUpdate({ signers: [SIGNER_A, SIGNER_B], threshold: 3 }),
      ).toEqual([
        expect.objectContaining({ field: "threshold" }),
      ]);
    });

    it("accepts valid signer sets and thresholds", () => {
      expect(
        validateThresholdUpdate({ signers: [SIGNER_A, SIGNER_B], threshold: 2 }),
      ).toEqual([]);
    });
  });

  describe("preview hash stability", () => {
    it("keeps signer-set hash stable for equivalent signer sets", async () => {
      const first = await computeThresholdPreviewHashes({
        contractId: CONTRACT_ID,
        signers: [SIGNER_B, SIGNER_A],
        threshold: 2,
        proposer: PROPOSER,
      });
      const second = await computeThresholdPreviewHashes({
        contractId: CONTRACT_ID,
        signers: [SIGNER_A, SIGNER_B],
        threshold: 2,
        proposer: PROPOSER,
      });

      expect(first.signerSetHash).toBe(second.signerSetHash);
      expect(first.payloadHash).toBe(second.payloadHash);
    });

    it("changes preview hashes when signers change", async () => {
      const baseline = await computeThresholdPreviewHashes({
        contractId: CONTRACT_ID,
        signers: [SIGNER_A, SIGNER_B],
        threshold: 2,
        proposer: PROPOSER,
      });
      const changed = await computeThresholdPreviewHashes({
        contractId: CONTRACT_ID,
        signers: [SIGNER_A, SIGNER_B, SIGNER_C],
        threshold: 2,
        proposer: PROPOSER,
      });

      expect(changed.signerSetHash).not.toBe(baseline.signerSetHash);
      expect(changed.payloadHash).not.toBe(baseline.payloadHash);
    });

    it("changes preview hashes when threshold changes", async () => {
      const baseline = await computeThresholdPreviewHashes({
        contractId: CONTRACT_ID,
        signers: [SIGNER_A, SIGNER_B, SIGNER_C],
        threshold: 2,
        proposer: PROPOSER,
      });
      const changed = await computeThresholdPreviewHashes({
        contractId: CONTRACT_ID,
        signers: [SIGNER_A, SIGNER_B, SIGNER_C],
        threshold: 3,
        proposer: PROPOSER,
      });

      expect(changed.signerSetHash).toBe(baseline.signerSetHash);
      expect(changed.payloadHash).not.toBe(baseline.payloadHash);
    });
  });

  describe("canonical encoding", () => {
    it("uses deterministic canonical strings", () => {
      expect(canonicalizeSignerSet([SIGNER_B, SIGNER_A])).toBe(
        ["v1", SIGNER_A, SIGNER_B].join("\n"),
      );
      expect(
        canonicalizeThresholdPayload({
          contractId: CONTRACT_ID,
          signers: [SIGNER_B, SIGNER_A],
          threshold: 2,
          proposer: PROPOSER,
        }),
      ).toBe(
        [
          "v1",
          CONTRACT_ID,
          "update_threshold",
          "2",
          [SIGNER_A, SIGNER_B].join("|"),
          PROPOSER,
        ].join("\n"),
      );
    });
  });
});
