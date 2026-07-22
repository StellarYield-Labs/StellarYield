#!/usr/bin/env node
/**
 * API Coverage Audit Script
 *
 * This script audits frontend API calls and compares them against backend routes
 * to identify missing endpoints, mismatches, and potential drift.
 *
 * Usage:
 *   npx tsx scripts/audit-api-coverage.ts
 *
 * The script scans:
 * - client/src for apiUrl(...), getApiBaseUrl(), and direct fetch("/api/...") calls
 * - server/src/app.ts and routes for registered backend endpoints
 * - Generates a JSON report of findings
 */

import fs from "fs";
import path from "path";

interface EndpointPattern {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  source: string;
  lineNumber?: number;
}

interface AuditFinding {
  frontendEndpoint: EndpointPattern;
  backendMatch: EndpointPattern | null;
  issue: "missing" | "indirect" | "documented" | "ok";
  severity: "error" | "warning" | "info";
  explanation: string;
}

interface AuditReport {
  timestamp: string;
  frontendEndpoints: EndpointPattern[];
  backendEndpoints: EndpointPattern[];
  findings: AuditFinding[];
  summary: {
    totalFrontendCalls: number;
    totalBackendRoutes: number;
    missingRoutes: number;
    undocumentedRoutes: number;
    indirectCalls: number;
  };
  exceptions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist for intentional exceptions / known mismatches
// ─────────────────────────────────────────────────────────────────────────────

const AUDIT_ALLOWLIST = [
  "/api/auth/challenge", // External identity provider — not registered in app.ts yet
  "/api/auth/verify", // External identity provider — not registered in app.ts yet
  "/api/graphql", // GraphQL endpoint — managed separately via yoga
  "/api/events", // Internal diagnostics — may be disabled in some environments
  "/api/backtest", // Frontend-only simulator endpoint — no backend route yet
  "/api/google-sheets", // Google Sheets integration — not yet implemented server-side
  "/api/rewards/claim", // Reward claiming — not yet implemented server-side
  "/api/rewards/proof", // Reward proof generation — not yet implemented server-side
];


// ─────────────────────────────────────────────────────────────────────────────
// Utility: Recursive file finder
// ─────────────────────────────────────────────────────────────────────────────

function findFiles(
  dir: string,
  extensions: string[],
  maxDepth: number = 10,
  currentDepth: number = 0,
): string[] {
  const files: string[] = [];

  if (currentDepth >= maxDepth) return files;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip node_modules, .git, etc.
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(
          ...findFiles(fullPath, extensions, maxDepth, currentDepth + 1),
        );
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dir}:`, error);
  }

  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner: Extract frontend API calls
// ─────────────────────────────────────────────────────────────────────────────

function scanFrontendApis(clientDir: string): EndpointPattern[] {
  const endpoints: EndpointPattern[] = [];
  const seenPaths = new Set<string>();

  // Regex patterns to match API calls
  const patterns = [
    // apiUrl("/api/path")
    /apiUrl\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    // fetch("/api/path")
    /fetch\s*\(\s*["'`](\/api\/[^"'`]+)["'`]/g,
    // fetch(apiUrl(...))
    /fetch\s*\(\s*apiUrl\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];

  console.log(`  Scanning ${clientDir}...`);

  const tsFiles = findFiles(clientDir, [".ts", ".tsx"]);
  console.log(`  Found ${tsFiles.length} TypeScript files`);

  for (const file of tsFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          let pathStr = match[1];
          if (!pathStr.startsWith("/api/")) continue;

          // Strip template literal expressions like ${endpoint} → use base path only
          pathStr = pathStr.replace(/\$\{[^}]+\}/g, "");

          // Normalize path: collapse double slashes, remove query params/fragments, strip trailing slashes
          let normalizedPath = pathStr.split("?")[0].split("#")[0];
          normalizedPath = normalizedPath.replace(/\/{2,}/g, "/");
          normalizedPath = normalizedPath.replace(/\/+$/, "") || normalizedPath;

          // Skip empty or root-only paths after stripping
          if (normalizedPath.length <= 5) continue; // "/api/" is length 5

          // Try to determine HTTP method from context
          const method = inferHttpMethod(content, match.index);

          // Use composite key of method + path to avoid collapsing different HTTP methods
          const compositeKey = `${method} ${normalizedPath}`;

          if (!seenPaths.has(compositeKey)) {
            seenPaths.add(compositeKey);

            endpoints.push({
              path: normalizedPath,
              method,
              source: file.replace(process.cwd(), "."),
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not scan ${file}:`, error);
    }
  }

  return Array.from(endpoints.values()).sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

function inferHttpMethod(
  content: string,
  matchIndex: number,
): "GET" | "POST" | "PUT" | "DELETE" | "PATCH" {
  // Look around match (before and after) for HTTP method hints
  const contextWindow = content.substring(
    Math.max(0, matchIndex - 100),
    Math.min(content.length, matchIndex + 250),
  );

  if (/method\s*:\s*["'`]?(POST|PUT|DELETE|PATCH)["'`]?/i.test(contextWindow)) {
    const methodMatch = contextWindow.match(
      /method\s*:\s*["'`]?(POST|PUT|DELETE|PATCH)["'`]?/i,
    );
    return (methodMatch?.[1]?.toUpperCase() as any) || "GET";
  }

  if (
    /["']method["']\s*,\s*["'](POST|PUT|DELETE|PATCH)["']/i.test(contextWindow)
  ) {
    const methodMatch = contextWindow.match(/["'](POST|PUT|DELETE|PATCH)["']/i);
    return (methodMatch?.[1]?.toUpperCase() as any) || "GET";
  }

  // Also look ahead for fetch options like: fetch(url, { method: "POST" })
  const afterMatch = content.substring(matchIndex, matchIndex + 300);

  if (/method\s*:\s*["'`]?(POST|PUT|DELETE|PATCH)["'`]?/i.test(afterMatch)) {
    const methodMatch = afterMatch.match(
      /method\s*:\s*["'`]?(POST|PUT|DELETE|PATCH)["'`]?/i,
    );
    return (methodMatch?.[1]?.toUpperCase() as any) || "GET";
  }

  if (
    /["']method["']\s*,\s*["'](POST|PUT|DELETE|PATCH)["']/i.test(afterMatch)
  ) {
    const methodMatch = afterMatch.match(/["'](POST|PUT|DELETE|PATCH)["']/i);
    return (methodMatch?.[1]?.toUpperCase() as any) || "GET";
  }

  // Default to GET if no method found
  return "GET";
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner: Extract backend routes
// ─────────────────────────────────────────────────────────────────────────────

function scanBackendRoutes(serverDir: string): EndpointPattern[] {
  const endpoints: EndpointPattern[] = [];
  const seenPaths = new Set<string>();

  console.log(`  Scanning ${serverDir}/src...`);

  // Patterns for app.ts route registrations
  const appTsPath = path.join(serverDir, "src", "app.ts");
  let appContent = "";

  try {
    appContent = fs.readFileSync(appTsPath, "utf-8");

    // app.use("/api/path", router)
    const routePattern =
      /app\.use\s*\(\s*["'`]([/\w-]+)["'`]\s*,\s*\w+Router\s*\)/g;
    let match;
    while ((match = routePattern.exec(appContent)) !== null) {
      const basePath = match[1];
      // For app.use, we don't know the specific method, so use a wildcard approach
      // Store both the path and mark it as a base path that handles all methods
      const compositeKey = `* ${basePath}`;
      if (!seenPaths.has(compositeKey)) {
        endpoints.push({
          path: basePath,
          method: "GET" as const, // app.use handles all methods, default to GET for matching
          source: appTsPath.replace(process.cwd(), "."),
        });
        seenPaths.add(compositeKey);
      }
    }

    // Direct route registrations: app.get/post/put/delete/patch("/api/path", ...)
    const directPattern =
      /app\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
    while ((match = directPattern.exec(appContent)) !== null) {
      const method = match[1].toUpperCase() as any;
      const routePath = match[2];
      const compositeKey = `${method} ${routePath}`;
      if (!seenPaths.has(compositeKey)) {
        endpoints.push({
          path: routePath,
          method,
          source: appTsPath.replace(process.cwd(), "."),
        });
        seenPaths.add(compositeKey);
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read app.ts:`, error);
  }

  // Scan route files for router.get/post/put/delete/patch
  const routesDir = path.join(serverDir, "src", "routes");
  try {
    const routeFiles = findFiles(routesDir, [".ts"]);

    for (const file of routeFiles) {
      // Skip test files
      if (file.endsWith(".test.ts")) continue;

      try {
        const content = fs.readFileSync(file, "utf-8");

        // router.get/post/put/delete/patch("/path", ...)
        const routerPattern =
          /router\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
        let match;
        while ((match = routerPattern.exec(content)) !== null) {
          const method = match[1].toUpperCase() as any;
          const routePath = match[2];

          // Resolve the full path by finding the mount point in app.ts
          const fullPath = resolveFullRoutePath(appContent, file, routePath);
          const compositeKey = `${method} ${fullPath}`;

          if (!seenPaths.has(compositeKey)) {
            endpoints.push({
              path: fullPath,
              method,
              source: file.replace(process.cwd(), "."),
            });
            seenPaths.add(compositeKey);
          }
        }
      } catch (error) {
        console.warn(`Warning: Could not scan ${file}:`, error);
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not scan routes directory:`, error);
  }

  return Array.from(endpoints.values()).sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
}

function resolveFullRoutePath(
  appContent: string,
  routeFile: string,
  routePath: string,
): string {
  // Extract router name from route file (e.g., "yields" from "yields.ts")
  const routerName = path.basename(routeFile, ".ts");
  const camelCaseRouter = routerName.replace(/-./g, (x) => x[1].toUpperCase());
  const pascalCaseRouter =
    camelCaseRouter.charAt(0).toUpperCase() + camelCaseRouter.slice(1);

  // Find the mount point in app.ts
  const patterns = [
    new RegExp(
      `app\\.use\\(["'\`]([/\\w-]+)["'\`]\\s*,\\s*${routerName}Router\\s*\\)`,
      "i",
    ),
    new RegExp(
      `app\\.use\\(["'\`]([/\\w-]+)["'\`]\\s*,\\s*${camelCaseRouter}Router\\s*\\)`,
      "i",
    ),
    new RegExp(
      `app\\.use\\(["'\`]([/\\w-]+)["'\`]\\s*,\\s*${pascalCaseRouter}Router\\s*\\)`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = appContent.match(pattern);
    if (match) {
      return `${match[1]}${routePath === "/" ? "" : routePath}`;
    }
  }

  // Fallback: assume /api/routerName
  return `/api/${routerName}${routePath === "/" ? "" : routePath}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparator: Match frontend calls to backend routes
// ─────────────────────────────────────────────────────────────────────────────

function auditCoverage(
  frontendEndpoints: EndpointPattern[],
  backendEndpoints: EndpointPattern[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const backendMap = new Map<string, EndpointPattern[]>();

  // Build a map of path -> [endpoints] for backend (to handle multiple methods)
  for (const endpoint of backendEndpoints) {
    if (!backendMap.has(endpoint.path)) {
      backendMap.set(endpoint.path, []);
    }
    backendMap.get(endpoint.path)!.push(endpoint);
  }

  for (const frontend of frontendEndpoints) {
    // Skip allowlisted endpoints
    if (AUDIT_ALLOWLIST.some((allow) => frontend.path.startsWith(allow))) {
      findings.push({
        frontendEndpoint: frontend,
        backendMatch: null,
        issue: "documented",
        severity: "info",
        explanation: "Intentionally allowlisted in audit configuration",
      });
      continue;
    }

    // Exact match with same method
    const backendAtPath = backendMap.get(frontend.path) || [];
    const exactMatch = backendAtPath.find((e) => e.method === frontend.method);

    if (exactMatch) {
      findings.push({
        frontendEndpoint: frontend,
        backendMatch: exactMatch,
        issue: "ok",
        severity: "info",
        explanation: "Route found and matches frontend call",
      });
      continue;
    }

    // Check for wildcard match (app.use routes that handle all methods)
    const wildcardMatch = backendAtPath.find(
      (e) =>
        e.method === "GET" &&
        backendEndpoints.some(
          (be) => be.path === e.path && be.method === "GET",
        ),
    );

    if (wildcardMatch) {
      findings.push({
        frontendEndpoint: frontend,
        backendMatch: wildcardMatch,
        issue: "ok",
        severity: "info",
        explanation: `Route found and handled by base path ${wildcardMatch.path}`,
      });
      continue;
    }

    // Prefix match with same method (e.g., /api/users/123 matches /api/users for GET)
    const prefixMatch = backendEndpoints.find(
      (e) =>
        e.method === frontend.method &&
        (frontend.path.startsWith(e.path + "/") || frontend.path === e.path),
    );

    if (prefixMatch) {
      findings.push({
        frontendEndpoint: frontend,
        backendMatch: prefixMatch,
        issue: "ok",
        severity: "info",
        explanation: `Route found under base path ${prefixMatch.path} (${prefixMatch.method})`,
      });
      continue;
    }

    // Parameterized route match: backend path like /api/presets/:id matches frontend /api/presets
    const paramMatch = backendEndpoints.find((e) => {
      if (e.method !== frontend.method) return false;
      // Strip :param segments from backend path and compare
      const backendBase = e.path.replace(/\/:[^/]+/g, "");
      return (
        frontend.path === backendBase ||
        frontend.path === e.path ||
        (backendBase && frontend.path.startsWith(backendBase + "/"))
      );
    });

    if (paramMatch) {
      findings.push({
        frontendEndpoint: frontend,
        backendMatch: paramMatch,
        issue: "ok",
        severity: "info",
        explanation: `Route matched via parameterized path ${paramMatch.path}`,
      });
      continue;
    }

    // No match found
    findings.push({
      frontendEndpoint: frontend,
      backendMatch: null,
      issue: "missing",
      severity: "error",
      explanation: `Frontend calls ${frontend.method} ${frontend.path} but no matching backend route found. This may cause runtime errors in production.`,
    });
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Generation
// ─────────────────────────────────────────────────────────────────────────────

function generateReport(
  frontendEndpoints: EndpointPattern[],
  backendEndpoints: EndpointPattern[],
  findings: AuditFinding[],
): AuditReport {
  const missingRoutes = findings.filter((f) => f.issue === "missing").length;
  const indirectCalls = findings.filter((f) => f.issue === "indirect").length;
  const undocumentedRoutes = backendEndpoints.filter(
    (b) => !findings.some((f) => f.backendMatch?.path === b.path),
  ).length;

  return {
    timestamp: new Date().toISOString(),
    frontendEndpoints,
    backendEndpoints,
    findings: findings.sort((a, b) => {
      const severityOrder = { error: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }),
    summary: {
      totalFrontendCalls: frontendEndpoints.length,
      totalBackendRoutes: backendEndpoints.length,
      missingRoutes,
      undocumentedRoutes,
      indirectCalls,
    },
    exceptions: AUDIT_ALLOWLIST,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Formatting
// ─────────────────────────────────────────────────────────────────────────────

function printReport(report: AuditReport): void {
  console.log(
    "\n╔════════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║          API Coverage Audit Report                              ║",
  );
  console.log(
    "╚════════════════════════════════════════════════════════════════╝\n",
  );

  console.log(`📊 Summary (${report.timestamp}):`);
  console.log(`  Frontend Calls:      ${report.summary.totalFrontendCalls}`);
  console.log(`  Backend Routes:      ${report.summary.totalBackendRoutes}`);
  console.log(`  ❌ Missing Routes:    ${report.summary.missingRoutes}`);
  console.log(`  ⚠️  Undocumented:     ${report.summary.undocumentedRoutes}`);
  console.log(`  🔀 Indirect Calls:   ${report.summary.indirectCalls}`);
  console.log();

  if (report.summary.missingRoutes > 0) {
    console.log("❌ Missing Backend Routes:");
    report.findings
      .filter((f) => f.issue === "missing")
      .forEach((f) => {
        console.log(
          `  • ${f.frontendEndpoint.path} (${f.frontendEndpoint.method})`,
        );
        console.log(`    From: ${f.frontendEndpoint.source}`);
        console.log(`    Issue: ${f.explanation}\n`);
      });
  }

  if (report.summary.undocumentedRoutes > 0) {
    console.log("⚠️  Undocumented Backend Routes (not called from frontend):");
    const undocumented = report.backendEndpoints.filter(
      (b) =>
        !report.findings.some(
          (f) => f.backendMatch?.path === b.path && f.issue !== "missing",
        ),
    );
    undocumented.slice(0, 10).forEach((e) => {
      console.log(`  • ${e.path} (${e.method})`);
    });
    if (undocumented.length > 10) {
      console.log(`  ... and ${undocumented.length - 10} more`);
    }
    console.log();
  }

  if (
    report.summary.missingRoutes === 0 &&
    report.summary.undocumentedRoutes === 0
  ) {
    console.log("✅ All frontend API calls have matching backend routes!");
    console.log();
  }

  console.log(`📋 Full report saved to: api-coverage-report.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const clientDir = path.join(process.cwd(), "client", "src");
  const serverDir = path.join(process.cwd(), "server");

  console.log("🔍 Scanning frontend API calls...");
  const frontendEndpoints = scanFrontendApis(clientDir);
  console.log(
    `   Found ${frontendEndpoints.length} unique frontend API calls\n`,
  );

  console.log("🔍 Scanning backend routes...");
  const backendEndpoints = scanBackendRoutes(serverDir);
  console.log(`   Found ${backendEndpoints.length} backend endpoints\n`);

  console.log("📊 Auditing coverage...");
  const findings = auditCoverage(frontendEndpoints, backendEndpoints);

  const report = generateReport(frontendEndpoints, backendEndpoints, findings);

  // Save report to JSON file
  const reportPath = path.join(process.cwd(), "api-coverage-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print formatted report
  printReport(report);

  // Exit with error code if there are missing routes
  if (report.summary.missingRoutes > 0) {
    console.log(
      `\n⚠️  Found ${report.summary.missingRoutes} missing backend routes!`,
    );
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("❌ Audit failed:", error);
  process.exit(1);
});
