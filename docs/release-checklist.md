# Stellar Wave Release Readiness Checklist

Before submitting a PR for the Stellar Wave program, make sure your contribution meets these release readiness standards.

## Issue Linking

- [ ] Your PR description includes `Fixes #ISSUE_NUMBER` to automatically close the relevant issue.
- [ ] The linked issue acceptance criteria are covered by the PR description or test notes.

## Build and CI

- [ ] All GitHub Actions CI checks pass.
- [ ] The Vercel preview deployment builds successfully without errors.
- [ ] Any advisory failures are either fixed or explained for maintainers.

## Testing and Validation

- [ ] Smoke test: manually verify the core happy path for your feature in the preview environment.
- [ ] Smart contracts: fuzzing and unit tests pass locally when contracts changed (`cargo test`).
- [ ] Frontend: relevant `npm run test` checks pass when client code changed.
- [ ] Backend: relevant `npm test` checks pass when server code changed.

## Documentation and Visuals

- [ ] Any new or modified UI components include desktop and mobile screenshots in the PR description.
- [ ] If there are no visual changes, the PR says `No visual changes`.
- [ ] If this is a new feature or smart contract, appropriate documentation and NatSpec comments have been added.
- [ ] If applicable, the `README.md` or contributor guides have been updated to reflect new environment variables or architectural changes.

Keep your submission concise and ensure all checklist items are met before requesting a review.

## Deployment Checks

- Confirm the Vercel deployment for `main` finishes successfully.
- Confirm the Vercel project still points its Root Directory at `client`, with Install `npm ci --no-audit`, Build `npm run build`, and Output `dist`. See the Vercel Deployment Settings section in [`README.md`](../README.md) for the full table.
- Confirm any backend deployment job or hosting platform reports a healthy release.
- Confirm Soroban contract deployment steps, addresses, and network targets match the intended release.
- Record any updated contract addresses or environment values in the relevant docs or deployment notes.

## Post-deploy Smoke Checks

- Run `scripts/smoke-test.sh --json > smoke-results/latest.json` to capture machine-readable pass/fail output.
- Store JSON snapshots in `smoke-results/` (gitignored) or upload as CI artifacts for operator history.
- The transparency dashboard smoke panel can read a latest JSON payload from browser local storage under `stellar-yield.smoke-results`.

### Automated Release Smoke Report

After deploying frontend and backend, maintainers can run **Release smoke report** (`.github/workflows/release-smoke-report.yml`) via **Actions -> Release smoke report -> Run workflow**.

- Inputs: `frontend_url`, `backend_url` (required), and optional `issue_or_pr_number` to post a Markdown table on that issue or PR.
- Output: job summary plus uploaded artifact `release-smoke-report-<run_id>` containing `smoke-report.md` with pass/fail per URL.
- Rerun: in GitHub Actions, use **Re-run failed jobs** or **Re-run all jobs** on the workflow run. Locally, run:

```bash
FRONTEND_URL="https://your-frontend.example" API_BASE_URL="https://your-backend.example" \
  VITE_API_BASE_URL="https://your-backend.example" \
  node scripts/smoke-test.js --report --markdown-out=smoke-report.md
```

- Portable report only: `node scripts/smoke-test.js --report --markdown`.
- For preview deployments, use `PREVIEW_API_BASE_URL` or `API_BASE_URL` for the backend under test. `BACKEND_URL` remains supported as a legacy alias.

Default checks expect HTTP 200 on `BACKEND_HEALTH_PATH` (default `/api/health`), `BACKEND_YIELDS_PATH` (default `/api/yields`), frontend `/`, and `FRONTEND_ASSET_PATH` (default `/favicon.svg`). Override via workflow dispatch inputs or the same-named environment variables.

## Rollback Notes

- If the frontend deployment is unhealthy, redeploy the last known good Vercel build from the Vercel dashboard.
- If the backend release is unhealthy, roll back to the previous stable deployment in the hosting platform.
- If a contract deployment is incorrect, stop frontend promotion of the new addresses and follow the contract-specific remediation plan before resuming traffic.

## Documentation

- Keep this checklist linked from `README.md` and `CONTRIBUTING.md`.
- Update the checklist when deployment tooling, approval policy, or smoke-test expectations change.
