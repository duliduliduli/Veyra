# Heartbeat lock order

Source-only change. PostgreSQL atomicity, actual lock races and global freedom from
deadlocks remain unverified; the staged database cases have not run.

## Bounded fix

`Worker._heartbeat` now locks the current job row before updating its attempt.
Its order is job → attempt, consistent with finish/reaper's job → authorization →
attempt order. Previously the heartbeat updated the attempt and then the job,
creating a potential inversion against those paths. This was a source-level risk,
not an observed PostgreSQL deadlock reproduction. PostgreSQL recommends consistent
object-lock order, and holds row locks until transaction end; see its
[locking documentation](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-DEADLOCKS).

After obtaining the job lock, heartbeat checks the authoritative running state and
fence. A missing, stopped or replaced job sets `claim.lost` and touches no attempt.
The update requires the exact attempt ID, claimed job ID and fence, with `ended_at
IS NULL`. Missing, foreign, ended or stale attempts also lose the claim without
publishing progress. Cancellation comes from the locked current job, not cached
claim data. Valid progress retains its existing JSON update in the same transaction.

An expired but still live attempt may renew until recovery wins the job lock and
fences/settles it, preserving the previous renewal contract. This change does not
introduce a lease-expiry rejection, a retry, a new timeout, or a new setting.

## Renewal clock

PostgreSQL `now()` is fixed at transaction start. A heartbeat that waits on a job
lock can therefore use an old timestamp and renew to an already-expired deadline.
The attempt update now uses `statement_timestamp()` for both heartbeat time and
lease expiry. Those expressions share the same statement-start value, sampled
after the job-lock statement has returned; the configured lease duration is
unchanged. See PostgreSQL's
[current-time functions](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

This only removes staleness caused by that job-lock wait. It does not guarantee
freshness after an unrelated direct attempt-lock wait, later transaction/commit
delays, or wall-clock adjustment. No extra attempt-lock protocol is introduced.

## Scope and checks

`_heartbeat_loop` is the only direct caller; `execute` owns the loop. Their interval,
stop, lost-lease and transient-error handling remain unchanged. No caller, fixture,
configuration, migration, export or dependency needed a runtime change. Claim,
finish, reaper, settlement/reservation guards, ledger and local/test execution gate
are unchanged.

The 23 new mocked cases cover SQL order and exact predicates; current cancellation;
missing/non-running/fenced jobs; missing/foreign/ended/fenced attempts; progress;
expired-live renewal; pending-write rollback; and loop interval/stop/error behavior.
Database, thread, socket, subprocess, strategy, engine and ledger boundaries are
intercepted. Mocks verify source contracts, not PostgreSQL transaction semantics.

The explicit six-file guarded allowlist passed 326 cases with zero forbidden-boundary
calls. Ruff and AST checks passed. The full `no_db` suite was not run by this slice:
it contains real trusted-template engine/subprocess execution. An initial seven-file
allowlist included an unrelated reservation HTTP-test file; the thread sentinel
blocked 18 TestClient portal-thread starts. That file was removed from this worker's
allowlist without weakening the sentinel or changing product code.

## Required release gates

`tests/test_heartbeat_lock_order_postgres.py` stages 11 disposable-database cases:

- Observe actual job-lock blocking with `pg_blocking_pids`, then prove the waiting
  heartbeat owns no attempt lock with `FOR UPDATE NOWAIT`.
- Verify renewal uses a timestamp after that wait and observes committed cancellation.
- Exercise finish and reaper winners, stale-heartbeat no-ops, and exactly one settlement.
- Pause heartbeat while it owns the job lock, verify reaper skips it, then renew an
  expired live attempt with only heartbeat/progress state changes.
- Check seven invalid job/attempt identities, repeat the losing heartbeat, and compare
  full attempt/job/usage/authorization/ledger/outbox snapshots.

These cases remain staged and unrun. Heartbeat-first `SKIP LOCKED` proves only the
already-held-lock scenario once run. It does not cover a reaper statement's stale
joined-attempt snapshot when heartbeat commits before the reaper acquires the job
lock. The paired refresh is now implemented in [held-record recovery](held-record-resilience.md),
with a separate advisory-gated PostgreSQL test. Both sets of real database tests
remain unrun release gates; the heartbeat-only suite does not prove that race closed.
