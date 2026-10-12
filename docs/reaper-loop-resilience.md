# Reaper loop resilience

The scheduler attempts expired-lease cleanup and unused-authorization recovery
independently on each pass. An ordinary `Exception` from either call is logged at
ERROR level with its operation name and exception class, without exception text or
tracebacks that could expose database configuration. A failed call is not reported
as successful, and does not prevent the other call from being attempted.

After both attempts, the loop keeps its existing sleep of
`max(job_lease_seconds / 2, 1)` seconds before trying again. Persistent failures
therefore produce at most one failure log per operation per pass, rather than an
immediate retry loop. `BaseException` subclasses such as `KeyboardInterrupt` and
`SystemExit` propagate. This does not add handling for startup or sleep failures,
timeouts for hung calls, or supervision of a terminated daemon thread.

No job, ledger, authorization, transaction or batch behavior changes. A maintenance
call can have committed earlier work before failing; the existing maintenance
functions remain responsible for idempotency and transaction boundaries. The
local/test Worker guard still precedes scheduler side effects for worker/all modes;
the existing reaper-only mode still does not construct a Worker or object store.

Mock-only regression tests capture the loop without starting threads or a Worker,
opening a database, or running a strategy. They cover independent failures and
recovery, persistent failures, call order, unchanged sleep and its one-second floor,
safe error logs, and propagation of process-level exceptions. Existing worker-gate
and reservation-recovery unit tests cover the surrounding wiring. These checks do
not establish PostgreSQL reconnection, concurrency, or deployed-service behavior.
No service was started, deployed, enabled or published by this source-only change.
