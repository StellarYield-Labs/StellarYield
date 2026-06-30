# Implementation Notes — Issue #27

**Issue:** Add secure MPC key-share storage, rotation, and backup recovery tests
**Upstream:** https://github.com/StellarYield-Labs/StellarYield/issues/27

## Acceptance Criteria

Area: MPC operations, key management
Why this matters
MPC key shares are sensitive. A production ceremony should not only generate shares, but also store them securely, support rotation, and prove recovery behavior under participant churn or storage failures.
Relevant files
backend/mpc_nodes/coordinator/ceremony.go
backend/mpc_nodes
Scope
Add a pluggable key-share storage interface with encrypted-at-rest implementation.
Add configurable KMS or local development key provider.
Add key-share rotation flow that produces a new session and invalidates old signing material.
Add backup and restore tests using encrypted stored shares.
Add operational docs for development versus production key storage.
Acceptance criteria
Raw key shares are not stored unencrypted.
Rotation creates new signing material without leaving the coordinator in an ambiguous state.
Restore tests prove a node can recover encrypted local material and resume expected behavior.
Documentation explains required production configuration.
Validation
go test ./backend/mpc_nodes/...
Add at least one storage-level test proving encrypted bytes differ from plaintext share material.

---
_Delete this file before merging._