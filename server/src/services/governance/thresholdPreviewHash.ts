import crypto from "crypto";

export const THRESHOLD_PREVIEW_SCHEMA_VERSION = 1;

export interface ThresholdUpdateProposal {
  contractId: string;
  signers: string[];
  threshold: number;
  proposer: string;
}

export interface ThresholdValidationError {
  field: string;
  message: string;
}

export interface ThresholdPreviewHashes {
  signerSetHash: string;
  payloadHash: string;
}

function isValidStellarAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    address.length === 56 &&
    address.startsWith("G") &&
    /^G[A-Z2-7]{55}$/.test(address)
  );
}

export function normalizeSigners(signers: string[]): string[] {
  return signers
    .map((signer) => signer.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function parseSignerInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((signer) => signer.trim())
    .filter(Boolean);
}

export function validateThresholdUpdate(
  input: Pick<ThresholdUpdateProposal, "signers" | "threshold">,
): ThresholdValidationError[] {
  const errors: ThresholdValidationError[] = [];
  const trimmed = input.signers.map((signer) => signer.trim()).filter(Boolean);

  if (trimmed.length === 0) {
    errors.push({
      field: "signers",
      message: "At least one signer address is required",
    });
  }

  const seen = new Set<string>();
  for (const signer of trimmed) {
    if (seen.has(signer)) {
      errors.push({
        field: "signers",
        message: "Duplicate signer addresses are not allowed",
      });
      break;
    }
    seen.add(signer);
  }

  for (const signer of trimmed) {
    if (!isValidStellarAddress(signer)) {
      errors.push({
        field: "signers",
        message: "All signer addresses must be valid Stellar addresses",
      });
      break;
    }
  }

  if (!Number.isInteger(input.threshold) || input.threshold < 1) {
    errors.push({
      field: "threshold",
      message: "Threshold must be at least 1",
    });
  } else if (trimmed.length > 0 && input.threshold > trimmed.length) {
    errors.push({
      field: "threshold",
      message: "Threshold cannot exceed the number of signers",
    });
  }

  return errors;
}

export function canonicalizeSignerSet(signers: string[]): string {
  const normalized = normalizeSigners(signers);
  return [`v${THRESHOLD_PREVIEW_SCHEMA_VERSION}`, ...normalized].join("\n");
}

export function canonicalizeThresholdPayload(
  proposal: ThresholdUpdateProposal,
): string {
  const normalized = normalizeSigners(proposal.signers);
  return [
    `v${THRESHOLD_PREVIEW_SCHEMA_VERSION}`,
    proposal.contractId.trim(),
    "update_threshold",
    String(proposal.threshold),
    normalized.join("|"),
    proposal.proposer.trim(),
  ].join("\n");
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeThresholdPreviewHashes(
  proposal: ThresholdUpdateProposal,
): ThresholdPreviewHashes {
  const validationErrors = validateThresholdUpdate(proposal);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors[0]?.message ?? "Invalid threshold update");
  }

  return {
    signerSetHash: sha256Hex(canonicalizeSignerSet(proposal.signers)),
    payloadHash: sha256Hex(canonicalizeThresholdPayload(proposal)),
  };
}
