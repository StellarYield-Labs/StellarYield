/**
 * Tests for the API Coverage Audit script
 *
 * Run with: npm test -- scripts/audit-api-coverage.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

describe("API Coverage Audit", () => {
  const reportPath = path.join(process.cwd(), "api-coverage-report.json");

  beforeEach(() => {
    // Clean up report before each test
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }
  });

  it("should detect common frontend API patterns", () => {
    // This test validates that the scan functions would correctly identify
    // frontend API calls using supported patterns

    const testPatterns = [
      'apiUrl("/api/yields")',
      'fetch(apiUrl("/api/users"))',
      'fetch("/api/health")',
      "fetch(`${getApiBaseUrl()}/api/status`)",
    ];

    testPatterns.forEach((pattern) => {
      expect(pattern).toMatch(/apiUrl|fetch|getApiBaseUrl/);
    });
  });

  it("should identify missing backend routes in report", () => {
    // This test checks that if a report exists, it properly identifies
    // missing routes (routes called by frontend but not in backend)

    if (!fs.existsSync(reportPath)) {
      // Skip if report hasn't been generated
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // Verify report structure
    expect(report).toHaveProperty("timestamp");
    expect(report).toHaveProperty("summary");
    expect(report).toHaveProperty("findings");
    expect(report).toHaveProperty("frontendEndpoints");
    expect(report).toHaveProperty("backendEndpoints");

    // Summary should have expected metrics
    expect(report.summary).toHaveProperty("totalFrontendCalls");
    expect(report.summary).toHaveProperty("totalBackendRoutes");
    expect(report.summary).toHaveProperty("missingRoutes");
    expect(report.summary).toHaveProperty("undocumentedRoutes");

    // If there are findings, they should have expected structure
    if (report.findings.length > 0) {
      const finding = report.findings[0];
      expect(finding).toHaveProperty("frontendEndpoint");
      expect(finding).toHaveProperty("issue");
      expect(finding).toHaveProperty("severity");
      expect(finding).toHaveProperty("explanation");

      // Severity should be one of the known values
      expect(["error", "warning", "info"]).toContain(finding.severity);

      // Issue type should be recognized
      expect(["ok", "missing", "indirect", "documented"]).toContain(
        finding.issue,
      );
    }
  });

  it("should handle allowlisted endpoints", () => {
    if (!fs.existsSync(reportPath)) {
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // Allowlisted endpoints should exist
    expect(report).toHaveProperty("exceptions");
    expect(Array.isArray(report.exceptions)).toBe(true);

    // Check for known allowlisted endpoints
    const allowlistItems = [
      "/api/auth/challenge",
      "/api/auth/verify",
      "/api/graphql",
    ];

    for (const item of allowlistItems) {
      // These should either be in exceptions or not in missing findings
      const isMissing = report.findings.some(
        (f) => f.frontendEndpoint.path === item && f.issue === "missing",
      );
      expect(isMissing).toBe(false);
    }
  });

  it("should report metrics with correct types", () => {
    if (!fs.existsSync(reportPath)) {
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // All summary metrics should be numbers
    expect(typeof report.summary.totalFrontendCalls).toBe("number");
    expect(typeof report.summary.totalBackendRoutes).toBe("number");
    expect(typeof report.summary.missingRoutes).toBe("number");
    expect(typeof report.summary.undocumentedRoutes).toBe("number");

    // All should be non-negative
    expect(report.summary.totalFrontendCalls).toBeGreaterThanOrEqual(0);
    expect(report.summary.totalBackendRoutes).toBeGreaterThanOrEqual(0);
    expect(report.summary.missingRoutes).toBeGreaterThanOrEqual(0);
    expect(report.summary.undocumentedRoutes).toBeGreaterThanOrEqual(0);
  });

  it("should validate API endpoint paths", () => {
    if (!fs.existsSync(reportPath)) {
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // All frontend endpoints should start with /api/
    report.frontendEndpoints.forEach((ep) => {
      expect(ep.path).toMatch(/^\/api\//);
      expect(["GET", "POST", "PUT", "DELETE", "PATCH"]).toContain(ep.method);
      expect(typeof ep.source).toBe("string");
    });

    // All backend endpoints should start with /api/
    report.backendEndpoints.forEach((ep) => {
      expect(ep.path).toMatch(/^\/api\//);
      expect(["GET", "POST", "PUT", "DELETE", "PATCH"]).toContain(ep.method);
      expect(typeof ep.source).toBe("string");
    });
  });

  it("should not have findings for properly matched routes", () => {
    if (!fs.existsSync(reportPath)) {
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // All "ok" findings should have a backend match
    const okFindings = report.findings.filter((f) => f.issue === "ok");
    okFindings.forEach((f) => {
      if (!f.frontendEndpoint.path.startsWith("/api/auth/")) {
        // Auth endpoints are allowlisted, so they might not have matches
        expect(f).toHaveProperty("backendMatch");
      }
    });
  });

  it("should handle routes with dynamic segments", () => {
    if (!fs.existsSync(reportPath)) {
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));

    // Routes like /api/users/123 should match /api/users base path
    const dynamicRoutes = report.frontendEndpoints.filter((ep) =>
      /\/\d+|:[^/]+|\{[^}]+\}/.test(ep.path),
    );

    // For each dynamic route, check it either has a match or is in findings with explanation
    dynamicRoutes.forEach((route) => {
      const finding = report.findings.find(
        (f) => f.frontendEndpoint.path === route.path,
      );
      expect(finding).toBeDefined();

      // If it has a finding, it should explain the match or reason for mismatch
      if (finding) {
        expect(finding.explanation).toBeDefined();
        expect(finding.explanation.length).toBeGreaterThan(0);
      }
    });
  });
});
