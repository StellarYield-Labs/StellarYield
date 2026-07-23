import { validateServerEnv } from "../config/env";

describe("validateServerEnv", () => {
  it("warns for missing local development values without failing startup", () => {
    const result = validateServerEnv({ NODE_ENV: "development" });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DATABASE_URL"),
        expect.stringContaining("MONGODB_URI"),
        expect.stringContaining("RELAYER_SECRET_KEY"),
      ]),
    );
  });

  it("requires production values that protect routes and jobs", () => {
    const result = validateServerEnv({ NODE_ENV: "production" });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DATABASE_URL"),
        expect.stringContaining("MONGODB_URI"),
        expect.stringContaining("METRICS_TOKEN"),
        expect.stringContaining("RELAYER_SECRET_KEY"),
      ]),
    );
  });

  it("requires zap router simulation settings to be configured together", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      DEX_ROUTER_CONTRACT_ID: "CROUTER",
    });

    expect(result.errors).toContain(
      "DEX_ROUTER_CONTRACT_ID and ZAP_QUOTE_SIM_SOURCE_ACCOUNT must be configured together.",
    );
  });

  it("detects partial SMTP config when only SMTP_USER is set", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      SMTP_USER: "user@example.com",
    });

    expect(result.errors).toContain(
      "SMTP_USER and SMTP_PASSWORD must be configured together. Set both to enable email notifications, or leave both unset to skip email.",
    );
  });

  it("detects partial SMTP config when only SMTP_PASSWORD is set", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      SMTP_PASSWORD: "secret",
    });

    expect(result.errors).toContain(
      "SMTP_USER and SMTP_PASSWORD must be configured together. Set both to enable email notifications, or leave both unset to skip email.",
    );
  });

  it("accepts fully configured SMTP without SMTP validation errors", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user@example.com",
      SMTP_PASSWORD: "secret",
    });

    const smtpErrors = result.errors.filter((e) => e.includes("SMTP"));
    expect(smtpErrors).toEqual([]);
  });

  it("accepts fully absent SMTP without SMTP validation errors", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
    });

    const smtpErrors = result.errors.filter((e) => e.includes("SMTP"));
    expect(smtpErrors).toEqual([]);
  });

  it("warns when SMTP_USER and SMTP_PASSWORD are set but SMTP_HOST is missing in development", () => {
    const result = validateServerEnv({
      NODE_ENV: "development",
      SMTP_USER: "user@example.com",
      SMTP_PASSWORD: "secret",
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SMTP_HOST is missing"),
      ]),
    );
    expect(result.errors.filter((e) => e.includes("SMTP_HOST"))).toEqual([]);
  });

  it("requires SMTP_HOST in production when SMTP auth is configured", () => {
    const result = validateServerEnv({
      NODE_ENV: "production",
      SMTP_USER: "user@example.com",
      SMTP_PASSWORD: "secret",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SMTP_HOST is missing"),
      ]),
    );
  });
});
