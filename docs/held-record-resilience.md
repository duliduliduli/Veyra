# Held-record scheduler resilience

Source-only. Corrupt billing records remain held for explicit operator review;
this change never repairs, reprices, releases, or quarantines them automatically.

## Recovery contract

- Worker `run_once` catches only `SettlementIntegrityError` after `execute` has
  unwound the `_finish` transaction. It reports a handled claim and can take the
  next queued job. The corrupt job remains running with its original reservation;
  its pending finish writes roll back. Existing `LeaseLost` behavior is unchanged.
- `_finish` locks the current job, checks state/fence, then locks its authorization
  and validates the claimed billing inputs with the existing `_approved_rates`
  guard before recording usage. Settlement still validates the current persisted
  job and all usage under the same transaction. Unknown rates/resources receive
  the same integrity hold; there is no fallback catalog or broad KeyError catch.
- Both reapers visit at most `batch_size` candidates (default 100, valid 1–100).
  Each candidate has its own transaction. An expected integrity error escapes that
  transaction, then gets logged and skipped for this pass. Healthy records can
  commit before and after a hold. Unexpected exceptions still surface to the
  existing interval-level handler; process-level BaseExceptions still surface.
- A visited-ID exclusion prevents repeated selection within one call, including
  a renewed active attempt or an unused authorization whose fresh post-lock job
  check prevents a release.
  Returns contain only successfully committed recoveries. A commit failure cannot
  be reported as a completed recovery.
- Active recovery retains running-state, current-fence, unended-attempt and expired-
  lease predicates, `FOR UPDATE OF j SKIP LOCKED`, heartbeat-proven billing, and
  the existing settlement/idempotency path. After owning the job lock, a separate
  SELECT refreshes the exact selected attempt ID, job ID and current job fence,
  requiring an unended attempt whose lease is still `< now()`. Renewed, ended,
  missing or mismatched attempts cause no authorization lock, fence/attempt write,
  usage, ledger posting, settlement or success result/log. Eligible recovery bills
  only the refreshed `started_at` and `heartbeat_at`. Unused recovery retains
  authorization-only locking, the fresh post-lock job-existence check and wall-clock
  claim expiry.

## Bounded progress across intervals

The existing scheduler loop owns two separate process-local `ReapCursor` objects,
passed explicitly to the active and unused recovery paths. Each cursor orders its
scan by `(created_at, id)` and advances only after a candidate commits or its known
integrity hold has rolled back. A refreshed active no-op consumes a visit and moves
the cursor only after successful transaction exit, just like committed recovery.
Active end-of-scan reset also waits for successful exit. A held prefix larger than 100 therefore cannot fill
all future intervals: the next batch continues beyond that prefix. An unexpected
fault preserves the last completed scan position so the failed record can retry.

The cursor resets when selection reaches the end of that ordered eligible scan.
Rows skipped because they were locked, newly eligible older rows, and held records
are revisited on a later scan. Process restart resets the cursor; repeated restarts
before reaching the end can delay progress. A one-shot caller may omit the cursor
and receives the existing list result for a fresh bounded scan. Callers wanting
cross-call progress must reuse one cursor per path. Cursor state is internal typed
process state, never an HTTP input, database attribute, global singleton, or durable
quarantine marker. A scan bounds candidate attempts, not database query cost or
lock wait duration. No migration or new runtime setting is introduced.

## Locks and deliberate limits

Early guard reads use job → authorization locks and then the existing read-only
quote/version/project query, before any ledger locks. One-record transactions do
not retain locks from another organization's completed settlement. The new guard
adds no quote row lock and unused recovery still never locks a job row.

The subsequent [heartbeat lock-order change](heartbeat-lock-order.md) acquires the
current job lock before its matching live attempt, removing the source-level inverse
order. The active reaper refresh addresses a separate discovery race: heartbeat may
commit after discovery's snapshot but before its job lock, leaving an old attempt
from the non-locking join. Under PostgreSQL's default READ COMMITTED isolation, the
separate SELECT sees the latest committed attempt after the job is locked. It adds
no attempt lock: normal heartbeat, claim and finish writers serialize on that job
lock. This relies on that writer discipline, not arbitrary direct attempt writers.
The existing transaction-start `now()` expiry cutoff and attempt-end timestamp stay
unchanged; data freshness does not require changing the cutoff policy. See
[PostgreSQL READ COMMITTED](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)
and [SELECT locking](https://www.postgresql.org/docs/16/sql-select.html#SQL-FOR-UPDATE-SHARE).
Real PostgreSQL heartbeat/reaper concurrency remains unverified; source/mock checks
and an unrun staged gate are not a database reproduction or a global deadlock guarantee.

## Verification

The new unit suite uses a transactional SQL double and intercepted ledger calls.
It covers interleaved holds and healthy records, all-held termination, more than
100 held records before a healthy record, cursor wrap/restart and unexpected-fault
retry, malformed/unknown metadata, post-write usage-identity rollback, healthy billing,
worker next-claim progression, fencing, safe logs after rollback, and ordinary faults
and BaseExceptions. The 20 added lease-refresh cases cover stale renewed/equal-expiry,
ended/missing/wrong-identity discovery; refreshed billing timestamps; zero writes on
no-ops; held/healthy/no-op batches; more than 100 no-ops; cursor resume/wrap; refresh
query failure; and commit failure for recovery, no-op and empty scan. The explicit
five-file guarded allowlist passes 201 cases with zero forbidden-boundary calls. These doubles do not prove PostgreSQL transaction behavior.

`test_held_record_resilience_postgres.py` stages 15 disposable-database cases covering
scoped per-record snapshots, real rollback after pending attempt/fence/usage writes,
all-held termination, multi-pass cursor progress, repeated settlement, concurrent
reapers, and both worker/reaper fence winners. Fixtures use synthetic credits and
replace execution with `_finish`. Existing settlement tests now expect held reapers
to return normally after rollback while cancellation/late-claim HTTP failures retain
the generic 500 contract. `test_reaper_lease_refresh_postgres.py` stages the specific
snapshot-to-job-lock window using a materialized advisory gate in discovery. Its
plan and actual lock-wait checks precede a real heartbeat commit, then it compares
full financial/job/attempt snapshots and checks later healthy recovery. All
PostgreSQL tests remain unrun, not passed.

No settlement guard, reservation guard, ledger implementation, rate catalog, migration,
local/test execution gate, runtime/auth/security setting, or dependency changed.
Nothing was published, deployed, or started as a service.
