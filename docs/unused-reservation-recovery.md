# Unused backtest reservation recovery

This is source-only. No deployed service, configuration, resource, database, ledger,
price, fee or production billing gate was changed or enabled.

## Contract

- Quote-price expiry remains its existing `quotes.expires_at`. Authorization instead
  grants one fixed 15-minute **job claim window**, starting at the authorization's
  database-generated `created_at`, even if the quote expires first. Authorization
  responses expose the derived `claim_expires_at`; there is no schema migration or
  new runtime setting. Retries never change either timestamp or reserve again.
- POST `/jobs` first locks the authorization and checks the existing org-scoped
  idempotency key. A matching existing job is returned with HTTP 200, even years
  later and in queued, running, finalizing, stopping or settled state. Another key
  cannot create a second job for that authorization; key reuse with a different
  authorization remains HTTP 409. Existing tenant/role checks run before recovery.
- An unused, reserved authorization is claimable only when PostgreSQL's current
  wall clock is before its claim deadline. The separate post-lock check uses
  `clock_timestamp()`, avoiding a transaction-start timestamp or API-host clock.
  A claim validated before the deadline can finish committing afterward while its
  lock remains held. At or after the deadline, the late POST releases the full
  reservation and returns HTTP 410. The function returns normally through the
  transaction context so this release commits before the response is returned.
- Recovery uses existing `ledger.settle`, with zero charge, supplier cost, fee and
  overrun, and a full release. It records the existing `settle:<authorization_id>`
  idempotency key and sets existing status `settled` and `settled_at` atomically.
  Here, `settled` means the reservation is closed, including a zero-charge expiry
  without a job. No job, usage event, receipt, outbox event or execution is invented.
- A repeat late POST after recovery returns the same terminal HTTP 410 without
  another posting, including when the reaper recovered first or a prior response
  was lost. Reauthorizing the old quote returns the same authorization and original
  deadline; it does not renew consent. A new quote and explicit new authorization
  are required. Before recovery, an expired authorization can still read `reserved`;
  clients must use `claim_expires_at` rather than interpreting that status as consent
  to start a new job.

## Recovery and locking

`reap_unused_authorizations` processes at most 100 candidates per invocation (default
100, valid batch sizes 1–100). Each candidate gets a separate transaction. It selects
only expired reserved authorizations with no visible job, ordered by creation time
and ID, and locks one authorization `FOR UPDATE ... SKIP LOCKED`, the same row lock
used by job creation. It then separately rechecks job existence **after** locking.
A candidate-query `NOT EXISTS` alone is insufficient under READ COMMITTED: its
snapshot can miss a concurrent job that committed before lock acquisition.

A job in any state makes an authorization ineligible, forever. Recovery never locks
job rows, so it does not invert settlement's existing job-then-authorization locks.
One authorization per transaction plus the ledger's existing account-ID lock order
avoids holding ledger locks across different organizations in concurrent batches.
Failure rolls back the current authorization's journal, balances and status; earlier
completed candidates remain committed. Concurrent reapers skip locked candidates and
retry them in later scans. Expected integrity holds roll back only their candidate;
visited-ID exclusion and scheduler-owned process-local cursors let later healthy
records progress even behind more than 100 held records. See
[held-record resilience](held-record-resilience.md) for cursor/reset semantics.
The batch limit bounds locked rows and writes, not the
number of rows PostgreSQL must scan; this deliberately avoids an unneeded migration.

The existing scheduler reaper loop calls this bounded recovery function after its
worker-lease cleanup. This change does not deploy or start that process. The current
API-only Railway deployment has no running reaper: passive orphan recovery therefore
will not run there unless a separate deployment is later approved. A late job POST
provides on-demand recovery, but untouched abandoned reservations can remain held
until an authorized reaper is operated. Production account access remains closed;
the deployed development-webhook configuration is unverified. The integrated local
candidate now gates that webhook to local/test (see development-payment-webhook-gate.md).
This is not evidence that the gate is deployed or that all billing is disabled.

## Verification and release gates

Offline tests use synthetic clocks, mocked database/ledger boundaries and a local
FastAPI test client. They cover derived deadlines, post-lock fresh job checks, every
job state, idempotent and permission checks, commit-on-410 control flow, no renewal,
zero-charge postings, error propagation, per-transaction batching and scheduler wiring.
Mocks do not establish real PostgreSQL transaction or concurrency correctness.

`tests/test_reservation_recovery_postgres.py` stages disposable-PostgreSQL tests for:

- Full release and repeat reaper/claim/authorize calls with one reserve and one settle
- Preservation of every job state, late matching-key retries, unused fresh consent,
  and a fresh authorization claim after the original quote has expired
- Bounded batches and concurrent reapers within and across organizations
- Actual journal/balance/status rollback after a posting has already occurred
- Both lock orders of claim versus recovery, including a pre-deadline validated claim
  held open until after expiry, a claimant blocked behind recovery, and deadline
  expiry while a claimant waits for the authorization lock
- A stale pre-lock no-job observation and a single-statement stale READ COMMITTED
  candidate snapshot held behind a test-only advisory-lock gate while a job commits,
  followed by a fresh post-lock job recheck
- Cached balances, zero settled usage, ledger idempotency and global trial balance

These PostgreSQL tests were not run in this source-only task. Running them against
an approved disposable database and checking both race orders repeatedly remain
release gates. Independent source review was completed; it cannot substitute for
the unrun PostgreSQL proof. No migration test is needed because no
migration changed. Use the existing offline `no_db` plugin when PostgreSQL use is
not authorized; it deselects these tests rather than reporting them as passing.
