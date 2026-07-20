import {
  validateServerEnv,
} from "../config/env";
import {
  validateAuditSigningKey,
  verifyAuditSignature,
  verifyAuditTrailIntegrity,
  type AuditLogEntry,
} from "../middleware/audit";
import crypto from "crypto";

jest.mock("fs/promises", () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockRejectedValue(new Error("ENOENT")),
  appendFile: jest.fn().mockResolvedValue(undefined),
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_AUDIT_KEY = process.env.AUDIT_SIGNING_KEY;

beforeEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.AUDIT_SIGNING_KEY = ORIGINAL_AUDIT_KEY;
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.AUDIT_SIGNING_KEY = ORIGINAL_AUDIT_KEY;
  (console.warn as jest.Mock).mockRestore();
  (console.error as jest.Mock).mockRestore();
});

describe("env validation for audit signing key", () => {
  it("errors in production when AUDIT_SIGNING_KEY is missing", () => {
    delete process.env.AUDIT_SIGNING_KEY;
    process.env.NODE_ENV = "production";

    const result = validateServerEnv(process.env);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("AUDIT_SIGNING_KEY"),
      ]),
    );
  });

  it("errors in production when AUDIT_SIGNING_KEY is the forbidden default", () => {
    process.env.AUDIT_SIGNING_KEY = "default-key";
    process.env.NODE_ENV = "production";

    const result = validateServerEnv(process.env);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("AUDIT_SIGNING_KEY"),
      ]),
    );
  });

  it("passes in production when AUDIT_SIGNING_KEY is set to a real secret", () => {
    process.env.AUDIT_SIGNING_KEY = "real-secret-key-123";
    process.env.NODE_ENV = "production";

    const result = validateServerEnv(process.env);

    expect(result.errors).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("AUDIT_SIGNING_KEY"),
      ]),
    );
  });

  it("warns in development when AUDIT_SIGNING_KEY is missing", () => {
    delete process.env.AUDIT_SIGNING_KEY;
    process.env.NODE_ENV = "development";

    const result = validateServerEnv(process.env);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("AUDIT_SIGNING_KEY"),
      ]),
    );
  });

  it("warns in development when AUDIT_SIGNING_KEY is the forbidden default", () => {
    process.env.AUDIT_SIGNING_KEY = "default-key";
    process.env.NODE_ENV = "development";

    const result = validateServerEnv(process.env);

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("AUDIT_SIGNING_KEY"),
      ]),
    );
  });
});

describe("validateAuditSigningKey", () => {
  it("throws in production when key is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AUDIT_SIGNING_KEY;

    expect(() => validateAuditSigningKey()).toThrow(
      /AUDIT_SIGNING_KEY is not configured/,
    );
  });

  it("throws in production when key is the forbidden default", () => {
    process.env.NODE_ENV = "production";
    process.env.AUDIT_SIGNING_KEY = "default-key";

    expect(() => validateAuditSigningKey()).toThrow(
      /forbidden default value/,
    );
  });

  it("does not throw in production when key is set", () => {
    process.env.NODE_ENV = "production";
    process.env.AUDIT_SIGNING_KEY = "secure-production-key";

    expect(() => validateAuditSigningKey()).not.toThrow();
  });

  it("does not throw in development even when key is missing", () => {
    process.env.NODE_ENV = "development";
    delete process.env.AUDIT_SIGNING_KEY;

    expect(() => validateAuditSigningKey()).not.toThrow();
  });
});

function buildValidEntry(
  overrides: Partial<Omit<AuditLogEntry, "hash" | "signature">> = {},
): AuditLogEntry {
  const key = process.env.AUDIT_SIGNING_KEY || "test-key";
  const previousHash = crypto
    .createHash("sha256")
    .update("GENESIS")
    .digest("hex");

  const entryData: Omit<AuditLogEntry, "hash" | "signature"> = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    userId: "user-1",
    userEmail: "user@example.com",
    action: "LOGIN",
    resource: "auth",
    resourceId: "res-1",
    method: "POST",
    endpoint: "/api/login",
    status: 200,
    changes: { ip: "127.0.0.1" },
    ipAddress: "127.0.0.1",
    userAgent: "test",
    previousHash,
    sequenceNumber: 0,
    ...overrides,
  };

  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: entryData.id,
        timestamp: entryData.timestamp,
        userId: entryData.userId,
        action: entryData.action,
        resource: entryData.resource,
        method: entryData.method,
        endpoint: entryData.endpoint,
        status: entryData.status,
        changes: entryData.changes,
        ipAddress: entryData.ipAddress,
        previousHash: entryData.previousHash,
        sequenceNumber: entryData.sequenceNumber,
      }),
    )
    .digest("hex");

  const signature = crypto
    .createHmac("sha256", key)
    .update(hash)
    .digest("hex");

  return { ...entryData, hash, signature };
}

describe("verifyAuditSignature", () => {
  it("returns true when signature matches the provided key", () => {
    process.env.AUDIT_SIGNING_KEY = "verifier-key";
    const entry = buildValidEntry();

    expect(verifyAuditSignature(entry, "verifier-key")).toBe(true);
  });

  it("returns false when signature does not match the provided key", () => {
    process.env.AUDIT_SIGNING_KEY = "signer-key";
    const entry = buildValidEntry();

    expect(verifyAuditSignature(entry, "wrong-key")).toBe(false);
  });

  it("returns false when signature is missing", () => {
    const { signature, ...entryWithoutSig } = buildValidEntry();

    expect(verifyAuditSignature(entryWithoutSig as AuditLogEntry, "any-key")).toBe(false);
  });

  it("returns false when hash is missing", () => {
    const { hash, ...entryWithoutHash } = buildValidEntry();

    expect(verifyAuditSignature(entryWithoutHash as AuditLogEntry, "any-key")).toBe(false);
  });
});

describe("verifyAuditTrailIntegrity", () => {
  it("returns valid for an unmodified chain", () => {
    process.env.NODE_ENV = "test";
    process.env.AUDIT_SIGNING_KEY = "test-chain-key";
    const genesis = crypto
      .createHash("sha256")
      .update("GENESIS")
      .digest("hex");

    const entry1 = buildValidEntry({ previousHash: genesis, sequenceNumber: 0 });
    const entry2 = buildValidEntry({
      previousHash: entry1.hash,
      sequenceNumber: 1,
    });
    const entry3 = buildValidEntry({
      previousHash: entry2.hash,
      sequenceNumber: 2,
    });

    const result = verifyAuditTrailIntegrity([entry1, entry2, entry3]);

    expect(result.isValid).toBe(true);
    expect(result.invalidEntries).toEqual([]);
    expect(result.deletedEntries).toEqual([]);
    expect(result.reorderedEntries).toEqual([]);
  });

  it("detects an altered event via hash mismatch", () => {
    process.env.NODE_ENV = "test";
    process.env.AUDIT_SIGNING_KEY = "test-tamper-key";
    const genesis = crypto
      .createHash("sha256")
      .update("GENESIS")
      .digest("hex");

    const entry1 = buildValidEntry({ previousHash: genesis, sequenceNumber: 0 });
    const entry2 = buildValidEntry({
      previousHash: entry1.hash,
      sequenceNumber: 1,
    });
    const tampered = { ...entry2, action: "DELETE" };

    const result = verifyAuditTrailIntegrity([entry1, tampered]);

    expect(result.isValid).toBe(false);
    expect(result.invalidEntries).toEqual([tampered.id]);
  });

  it("detects a deleted event via sequence gap", () => {
    process.env.NODE_ENV = "test";
    process.env.AUDIT_SIGNING_KEY = "test-delete-key";
    const genesis = crypto
      .createHash("sha256")
      .update("GENESIS")
      .digest("hex");

    const entry1 = buildValidEntry({ previousHash: genesis, sequenceNumber: 0 });
    const entry3 = buildValidEntry({
      previousHash: entry1.hash,
      sequenceNumber: 2,
    });

    const result = verifyAuditTrailIntegrity([entry1, entry3]);

    expect(result.isValid).toBe(false);
    expect(result.deletedEntries).toEqual([entry3.id]);
  });

  it("detects reordered events via sequence mismatch", () => {
    process.env.NODE_ENV = "test";
    process.env.AUDIT_SIGNING_KEY = "test-reorder-key";
    const genesis = crypto
      .createHash("sha256")
      .update("GENESIS")
      .digest("hex");

    const entry1 = buildValidEntry({ previousHash: genesis, sequenceNumber: 0 });
    const entry2 = buildValidEntry({
      previousHash: entry1.hash,
      sequenceNumber: 1,
    });

    const result = verifyAuditTrailIntegrity([entry2, entry1]);

    expect(result.isValid).toBe(false);
    expect(result.deletedEntries).toEqual([entry2.id]);
    expect(result.reorderedEntries).toEqual([entry1.id]);
  });

  it("detects a missing entry when sequence starts above zero", () => {
    process.env.NODE_ENV = "test";
    process.env.AUDIT_SIGNING_KEY = "test-missing-key";
    const genesis = crypto
      .createHash("sha256")
      .update("GENESIS")
      .digest("hex");

    const entry2 = buildValidEntry({ previousHash: genesis, sequenceNumber: 2 });

    const result = verifyAuditTrailIntegrity([entry2]);

    expect(result.isValid).toBe(false);
    expect(result.deletedEntries).toEqual([entry2.id]);
  });

  it("detects chain break via previousHash mismatch", () => {
    process.env.NODE_ENV = "test";
    process.env.AUDIT_SIGNING_KEY = "test-break-key";
    const genesis = crypto
      .createHash("sha256")
      .update("GENESIS")
      .digest("hex");

    const entry1 = buildValidEntry({ previousHash: genesis, sequenceNumber: 0 });
    const entry2 = buildValidEntry({
      previousHash: "0000000000000000000000000000000000000000000000000000000000000000",
      sequenceNumber: 1,
    });

    const result = verifyAuditTrailIntegrity([entry1, entry2]);

    expect(result.isValid).toBe(false);
    expect(result.invalidEntries).toEqual([entry2.id]);
  });
});
