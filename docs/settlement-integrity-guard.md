# Settlement billing identity guard

This source-only change prevents a corrupt persisted billing identity from being
used to settle a job or refund an expired unused authorization. It does not repair
records or choose replacement rates or reservation amounts.

## Invariants

Before settlement calculations, ledger posting, or terminal-state writes:

- The authorization is reserved and belongs to its quote's organization.
- Its quote, project version, and project exist within the same organization.
- The quote's request names that version, and the authorization/quote input hashes match.
- The reserved amount is a positive integer exactly equal to the original quote ceiling.
- For jobs, organization, authorization, quote, version and input hash links also match.
- A job's rate version and resource class match its quote and resolve in the existing
  rate catalog. Usage rows must belong to that organization and rate version.

Any mismatch raises `SettlementIntegrityError` and requires operator review. The
worker, active-job reaper and queued cancellation let this exception escape their
existing transaction. Pending attempt, fence and usage changes therefore share the
rollback boundary with settlement. Expired-unused recovery and late job claims use
the same authorization guard before their zero-charge release.

## Behavior preserved

- A settled job remains an immediate idempotent no-op, even if historical metadata
  is subsequently unavailable.
- Job settlement retains job-then-authorization row locking. The new quote/version/
  project join is read-only and takes no additional row lock.
- Unused release retains authorization locking, its post-lock job-existence check,
  and the database-clock expiry check. It needs no historical rate/resource catalog
  because it only returns an untouched reservation.
- Runtime-only preflight errors in params, cash, fees, slippage, runtime or engine
  still permit a zero-bill failure against an intact original billing identity.
- Normal completed, incomplete, failed, cancelled and reaped jobs keep existing
  charge caps, release math, receipts and ledger idempotency.

## Verification

Source-only tests intercept SQL and ledger boundaries. The safe local runner blocks
database connections/pools, subprocesses, strategy construction and engine execution.
The focused suite includes `test_settlement_identity_unit.py`, the adjusted
`test_reservation_recovery_unit.py`, and `test_reaper_loop_resilience.py`.

`test_settlement_identity_postgres.py` adds staged disposable-PostgreSQL gates for
worker, cancellation, active reaper, unused recovery and late-claim rollback, plus
concurrent valid settlement. Its fixtures restore corrupted fields and close test
jobs so the session-scoped database cannot contaminate later reaper checks. These
tests were syntax/lint checked only, never run in this source-only work.

## Limits and release gates

Mock tests verify exception propagation and that no ledger call is reached; they do
not prove PostgreSQL rollback, isolation, lock waits or production concurrency. Run
the staged PostgreSQL tests and existing job/crash/recovery suites in an authorized
disposable CI database before release. No database, ledger, strategy, engine, browser,
network service or subprocess was exercised by these tests.

This is a consistency guard, not cryptographic protection against coordinated writes
to all matching records. Quote identities and amounts are immutable in normal
application flows; the guard does not compare them with the original reserve journal.

Scheduler continuation is now handled by the separate
[held-record resilience slice](held-record-resilience.md): each reaper candidate has
its own rollback boundary, process-local cursors progress past held prefixes, and
the worker continues to its next claim. Integrity guards and automatic-repair policy
are unchanged. Unknown billing metadata is prevalidated before usage-rate lookup.

This guard introduced no schema migration, dependency, auth/security/runtime setting
or ledger implementation changes. Nothing was deployed or activated. The runtime
code adds one read-only approval-chain query on a previously unvalidated release path.
