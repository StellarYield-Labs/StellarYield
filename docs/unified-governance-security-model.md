# Unified Governance Control Plane: Security Model & Emergency Procedure

This document describes the security model introduced to unify client
proposals, server admin actions, and on-chain optimistic governance
(Issue #81). It supersedes the "placeholder success" behavior previously
present in `server/src/routes/admin.ts`, where several admin mutation
routes returned `success: true` while the underlying on-chain action was a
`TODO` and never actually executed.

## Problem This Solves

Before this change, three governance surfaces could disagree about whether
a privileged action had actually happened:

- **Client** — assembled transactions and tracked signature/status locally
  in `localStorage` (`useGovernanceStore`), with no way to recover state
  after a refresh or on another device.
- **Server** — admin routes (`/api/admin/vaults/:vaultId/pause`,
  `/api/admin/fees/config`, `/api/admin/risk/parameters`, etc.) recorded an
  audit log entry and returned `success: true`, but the actual on-chain
  mutation was a `TODO` comment. The audit trail and the API response both
  implied the action had taken effect when it had not.
- **Contract** — `contracts/optimistic_governance` could execute *any*
  `(contract, function, args)` payload passed to `propose`, with no
  allowlist, so a compromised or buggy proposer could invoke arbitrary
  contract methods.

## Architecture

### 1. Canonical Action Schema and Hash

`server/src/governance/actionSchema.ts` defines `GovernanceAction`: a
versioned payload with `schemaVersion`, `network`, `targetContractId`,
`method` (drawn from `ALLOWED_GOVERNANCE_METHODS`), typed `args`,
`expectedCurrentState`, `proposer`, `creationLedger`,
`executionWindowSeconds`, and a human-readable `rationale`.

`hashGovernanceAction()` produces a deterministic sha256 hash over a fixed
field ordering (`canonicalizeAction`), independent of JS object key
insertion order. This is the **single source of truth** shared by:

- the server's `GovernanceProposal.actionHash` (Postgres),
- the on-chain `Proposal.action_hash` (`BytesN<32>` in
  `contracts/optimistic_governance/src/storage.rs`),
- and, going forward, the client preview and any signatures collected.

Test vectors live in `server/src/governance/governance-test-vectors.json`
and are regenerated via `npm run governance:vectors` (server). Any change to
the schema requires a `GOVERNANCE_ACTION_SCHEMA_VERSION` bump and
regenerated vectors — otherwise client/server/contract hashes silently
diverge and the "byte-for-byte what was reviewed" invariant breaks.

### 2. On-Chain Allowlist

`contracts/optimistic_governance` no longer accepts an arbitrary
`(contract_id, function)` pair. The admin must explicitly register each
allowed pair via `allow_action` (and may later `revoke_action`). `propose()`
rejects any target not on the allowlist with `Error::ActionNotAllowed`, and
`execute()` re-checks the allowlist at execution time in case it was
revoked after the proposal was created — so a stale proposal cannot bypass
a since-tightened allowlist.

This means generic arbitrary invocation is structurally impossible: the
governance contract simply refuses to store or execute a proposal targeting
an unregistered method.

### 3. Proposals Are Not Success Until Confirmed On-Chain

Admin routes covered by this change (`vault pause/resume`, `vault
parameters`, `fee config`, `risk parameters`) now call
`createProposal()` (`server/src/governance/governanceProposalService.ts`)
and respond with **HTTP 202 Accepted** and a `status: "PROPOSED"` body that
explicitly states the action has not executed on-chain. There is no code
path where these routes can return `success: true` for an unexecuted
mutation.

Proposal status only reaches `CONFIRMED` once
`server/src/indexer/governanceIndexer.ts` observes an `execute` event for
the matching `onChainProposalId` from the optimistic_governance contract
and reconciles it into Postgres (`GovernanceProposal.status`,
`GovernanceEvent`). Status is therefore derived from indexed on-chain
events and transaction results, not from server-side intent.

### 4. Simulation Evidence and Staleness Gate

`simulateProposal()` runs a real `simulateTransaction` call against the
target contract/method via Soroban RPC and persists the result as a
`GovernanceSimulation` row: transaction footprint, result, diagnostic
events, resource fee, and risk warnings, alongside the ledger it was
simulated at and an expiry timestamp.

`isSimulationStale()` fails closed: if there is no simulation, the
recorded expiry has passed, the current ledger has advanced more than
`GOVERNANCE_MAX_SIMULATION_LEDGER_AGE` ledgers past the simulation ledger,
or the RPC cannot be reached to confirm freshness, the simulation is
treated as stale. Approval flows must check this before allowing a
proposal to progress — a stale simulation is never presented as current
without a warning and execution gate.

### 5. Proposal Lifecycle

Proposals move through: `PENDING` → `CHALLENGED` (disputed by a veYIELD
holder) → `PENDING` (reinstated) or `CANCELLED` (dispute resolved against
the proposal, or explicitly cancelled) → `CONFIRMED` (executed on-chain) or
`EXPIRED` (challenge window elapsed, then execution window elapsed without
execution) or `FAILED` (allowlist revoked between proposal and execution,
or the invoked contract call itself failed).

A `CANCELLED`, `EXPIRED`, disputed (`CHALLENGED`), or already-`Executed`
proposal cannot execute — enforced both in the contract's `execute()` match
arm and mirrored by the indexer's status reconciliation.

### 6. Persistence and Recovery

- **Server restart:** proposal, simulation, and event rows are Postgres
  tables (`GovernanceProposal`, `GovernanceSimulation`, `GovernanceEvent`),
  not in-memory state.
- **Client refresh / another device:** `useGovernanceProposals` (client)
  fetches `/api/governance/proposals` on mount rather than reading from
  `localStorage`, so the canonical proposal list is always server-derived.
- **Empty database rebuild:** because `GovernanceEvent` records are created
  from indexed chain events with an idempotent unique key
  (`txHash, topic, onChainProposalId`), replaying the on-chain event history
  from ledger 0 against an empty database reconstructs the same proposal
  statuses.

## What Is Explicitly Out of Scope Here

This change delivers the schema, allowlist, persistence, simulation, and
route wiring described above. It does not yet include: end-to-end tests
against a local Soroban network, front-running detection between
simulation and execution, or a governance UI proposal *creation* flow bound
to the new canonical schema (the existing client-side multi-sig builder in
`docs/governance-proposal-lifecycle.md` remains for its own use case).
These are natural follow-ups tracked against the same issue.

## Emergency Procedure

The existing emergency freeze/resume flow
(`docs/EMERGENCY_RUNBOOK.md`, `POST /api/admin/recommendations/freeze`) is
**unchanged** — it is a separate, off-chain recommendation-engine circuit
breaker and does not go through the governance proposal flow, since it
must be instantaneous and does not mutate on-chain state.

For genuinely on-chain emergency actions (protocol freeze/recovery, vault
pause), operators must still go through the proposal → simulate → approve
→ execute flow described above. There is deliberately no "skip the
challenge window" fast path in the contract: the challenge window is the
protocol's defense against a single compromised admin key. If an admin key
is suspected compromised:

1. Immediately trigger the off-chain freeze
   (`POST /api/admin/recommendations/freeze`) to halt new
   recommendations/deposits at the application layer — this does not
   require the governance contract and takes effect immediately.
2. Use `revoke_action` (if the admin key is still trusted enough to call
   it) to remove sensitive `(contract, function)` pairs from the on-chain
   allowlist, preventing any pending or future proposal from executing
   against them even if the challenge window has already elapsed.
3. Any pending proposals that should not execute can be disputed by a
   veYIELD holder (`dispute`) or cancelled by the proposer/admin
   (`cancel`) before their execution window elapses.
4. Follow the standard incident process in `docs/EMERGENCY_RUNBOOK.md` for
   verification, communication, and postmortem.

## Relevant Files

| File | Purpose |
|---|---|
| `server/src/governance/actionSchema.ts` | Canonical `GovernanceAction` schema, allowlist, and hash |
| `server/src/governance/governance-test-vectors.json` | Shared hash test vectors |
| `server/src/governance/governanceProposalService.ts` | Create/simulate/list/cancel proposals; staleness gate |
| `server/src/routes/governance.ts` | `/api/governance/proposals` lifecycle routes |
| `server/src/routes/admin.ts` | Admin mutation routes rewired to propose, not fake-succeed |
| `server/src/indexer/governanceIndexer.ts` | Reconciles proposal status from on-chain events |
| `server/prisma/schema.prisma` | `GovernanceProposal`, `GovernanceSimulation`, `GovernanceEvent` models |
| `contracts/optimistic_governance/src/lib.rs` | On-chain allowlist, cancel, dispute resolution, expiry |
| `client/src/pages/governance/useGovernanceProposals.ts` | Client fetch of canonical proposal state |
| `client/src/pages/governance/GovernanceProposalsPanel.tsx` | Server-backed proposal list UI |
