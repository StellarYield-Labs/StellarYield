# Execution Coordinator Runbook

This runbook covers the Issue #79 exactly-once execution coordinator for keeper and rebalance work.

## State model

Every on-chain intent is tracked as one durable `ExecutionRecord`:

```text
READY -> LEASED -> BUILT -> SIMULATED -> SIGNED -> SUBMITTED -> CONFIRMED
                                                └-> RECONCILING -> CONFIRMED
                         └-> FAILED / EXPIRED
```

Workers must mutate records only while holding the latest lease fencing token. A stale worker that resumes after its lease expires must fail closed with `StaleLeaseError`.

## Stuck executions

1. Query records where `state = LEASED` and `leaseExpiresAt < now`.
2. Confirm the worker is no longer active through keeper logs and lease contention metrics.
3. Let another worker acquire the lease; the fencing token must increment before any mutation.
4. If the record is expired, transition it to `EXPIRED` rather than rebuilding with a later timeout.

## Ambiguous submissions

If RPC submission times out after signing or submission:

1. Move the execution to `RECONCILING`.
2. Search by `submissionHash` or `signedEnvelopeHash` before resubmitting.
3. If the transaction is confirmed, record `resultXdr`, release the sequence reservation, and transition to `CONFIRMED`.
4. If the transaction is not found and the validity window is still open, rebuild only under a fresh lease and fresh sequence reservation.

Never resubmit blindly while a `submissionHash` exists.

## Poisoned executions

Terminal contract failures should be classified as `contract`, moved to `FAILED`, and excluded from retry queues. Transport failures may be retried after backoff, but only with a new fencing token.

## Sequence conflicts

If the keeper source account sequence advances unexpectedly:

1. Mark the current execution `RECONCILING`.
2. Invalidate stale sequence reservations for that source account.
3. Re-simulate the transaction because the ledger footprint or timeout may also be stale.
4. Reserve a new sequence under the current lease before signing.

## Required metrics

Expose or alert on:

- lease contention count;
- stale worker mutation attempts;
- retry class counts (`transport`, `contract`, `unknown`);
- sequence reservation conflicts;
- confirmation latency;
- reconciliation count;
- per-vault serialization queue depth.
