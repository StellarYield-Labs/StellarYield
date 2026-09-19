#!/usr/bin/env node

const { execFileSync } = require("child_process");

const forbiddenPathPatterns = [
  /^generated-issues\//,
  /^\.generated-issues\//,
  /^issue-drafts\//,
  /^\.issue-drafts\//,
  /^scripts\/generated-issues\//,
  /^scripts\/generated-issue-.*\.(c?js|mjs|ts)$/,
  /^scripts\/(create|publish|sync)-github-issues\.(c?js|mjs|ts)$/,
  /^scripts\/(create|publish|sync)-issues\.(c?js|mjs|ts)$/,
];

function listCandidatePaths() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );

  return output
    .split(/\r?\n/)
    .map((path) => path.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function isForbidden(path) {
  return forbiddenPathPatterns.some((pattern) => pattern.test(path));
}

const offenders = listCandidatePaths().filter(isForbidden);

if (offenders.length > 0) {
  console.error("Forbidden generated issue helper artifacts were found:");
  for (const path of offenders) {
    console.error(`- ${path}`);
  }
  console.error("");
  console.error(
    "Keep local generated issue publishing scripts outside the repo, under .generated-issues/, or under issue-drafts/.",
  );
  console.error(
    "Only commit reusable, documented maintainer scripts that are intentionally reviewed as source.",
  );
  process.exit(1);
}

console.log("No forbidden generated issue helper artifacts found.");
