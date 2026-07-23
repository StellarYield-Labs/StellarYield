import fs from "fs";
import path from "path";

const serverRoot = path.resolve(__dirname, "../..");

function readServerFile(relativePath: string): string {
  return fs.readFileSync(path.join(serverRoot, relativePath), "utf8");
}

function mountedApiPrefixes(appSource: string): string[] {
  const prefixes = new Set<string>();
  const useRegex = /app\.use\("([^"]+)"/g;
  const verbRegex = /app\.(?:get|post|put|patch|delete)\("([^"]+)"/g;

  for (const regex of [useRegex, verbRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(appSource)) !== null) {
      const route = match[1];
      if (route.startsWith("/api/")) {
        const [, api, prefix] = route.split("/");
        prefixes.add(`/${api}/${prefix}`);
      }
    }
  }

  return [...prefixes].sort();
}

function documentedPrefixes(openapiSource: string): Set<string> {
  const prefixes = new Set<string>();
  const pathRegex = /^  (\/api\/[^:\n]+):/gm;

  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(openapiSource)) !== null) {
    const route = match[1];
    const [, api, prefix] = route.split("/");
    if (api === "api" && prefix) {
      prefixes.add(`/api/${prefix}`);
      const parts = route.split("/");
      if (parts.length > 3 && !parts[3].startsWith("{")) {
        prefixes.add(`/api/${parts[2]}/${parts[3]}`);
      }
    }
  }

  return prefixes;
}

describe("OpenAPI route coverage", () => {
  it("documents every mounted top-level API route prefix", () => {
    const appSource = readServerFile("src/app.ts");
    const openapiSource = readServerFile("openapi.yaml");
    const documented = documentedPrefixes(openapiSource);

    const excluded = new Set([
      "/api/graphql", // GraphQL schema is exposed through Yoga/GraphiQL, not OpenAPI.
    ]);

    const missing = mountedApiPrefixes(appSource).filter(
      (prefix) => !excluded.has(prefix) && !documented.has(prefix),
    );

    expect(missing).toEqual([]);
  });
});
