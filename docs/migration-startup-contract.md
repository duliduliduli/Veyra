# Migration startup source contract

## Change and scope

`veyra_api.db.migrate()` now sets transaction-local `lock_timeout = '5s'` and
`statement_timeout = '60s'` immediately after entering its connection context,
before acquiring advisory transaction lock `7426001`. These are the same values
already present in migrations 0002/0003; historical SQL files are unchanged.

The order stays: one non-autocommit connection/transaction → local limits →
advisory lock → create/read migration ledger → sorted, missing SQL files → each
version insert → one explicit commit → connection-context exit → return applied
versions. Both API lifespan and scheduler startup call this shared runner; their
startup paths and later pool/account initialization are unchanged.

Failures propagate; this function has no retry. The driver context is responsible
for rolling back uncommitted SQL and version rows. A successful commit cannot be
undone by a later connection-exit, pool or application-initialization failure. A
caller must not treat a missing success response as proof nothing committed.

## What this guard does not promise

- Connection acquisition, cumulative multi-migration duration and commit delays
  are not newly bounded by an overall deadline. No connection timeout or separate
  commit deadline was added. Per-lock/per-statement limits are not a wall-clock
  limit for the complete startup operation.
- It does not eliminate DDL contention or release locks before transaction end.
  All cooperating runners must use the same database and advisory key. The normal
  repeat/concurrency contract assumes PostgreSQL's default READ COMMITTED isolation.
- There is no new retry, timeout configuration, checksum, ledger repair or schema
  reconciliation. A manually drifted schema/ledger still needs separate diagnosis.
- The source uses fixed local values, including when session defaults differ.
  No deployed configuration, database, credential or service was changed here.

## Offline evidence

`tests/test_migration_startup_unit.py` uses mocked resources and a transactional
connection double. Its explicit contracts check limits before advisory/ledger
work; sorted missing SQL and per-version inserts; skipping recorded/non-SQL files;
repeat startup; errors during limits, lock, ledger read/create, partial SQL and
version insert; rollback propagation and clean retry; commit failure; and return
only after commit and connection-context exit.

These tests model driver rollback and do not establish PostgreSQL behavior. Run
only these named tests in the source-only allowlist, with plugin autoload disabled,
root conftest disabled and external-boundary sentinels. Do not substitute the
broad `no_db` selection or TestClient-based suites: an offline label does not prove
that a test cannot connect, start a thread or execute a strategy.

## Staged PostgreSQL release gates (unrun)

`tests/test_migration_startup_postgres.py` stages five focused gates:

1. Run actual 0001/0002 through `migrate()`, commit synthetic legacy private rows,
   then run actual 0003 through the same runner. Compare complete user,
   organization, project and version rows; assert the new publication table is
   empty. Repeat startup must return no applied versions and leave ledger rows,
   timestamps and private data unchanged.
2. After a committed 0002 baseline, apply 0003 plus a synthetic table migration,
   then inject a failing later SQL file. Verify SQL objects and all pending ledger
   rows rolled back, baseline/private rows survived, and a clean retry followed
   by repeat startup succeeds. Historical files are not edited.
3. Use two real runners. Hold the first immediately after actual advisory-lock
   acquisition, prove the second waits on that backend via `pg_blocking_pids`,
   then release. Only the first applies versions; the second reads the committed
   ledger and skips them. No sleep-only assertion substitutes for the lock proof.
4. Hold the advisory key beyond 5 seconds. The runner must raise lock timeout
   (`55P03`) before touching its ledger; after release, clean startup and repeat
   succeed.
5. Hold an exclusive lock on an existing migration ledger. Startup must time out
   without changing ledger rows, then succeed as a no-op after release.

Each gate creates its own uniquely named disposable database using the existing
test admin URL convention. It never uses the app/database fixtures or shared app
schema. Cleanup drops only that exact successfully created test database, without
`FORCE`; it is test-fixture cleanup, not a down migration. These tests require a
disposable PostgreSQL test service with database-creation privileges. The two-runner
gate creates threads. None of these gates, connections or threads was executed as
part of this source-only change. Do not run them against a deployed database.

## Application rollback and release limits

0003 is additive and starts empty; a source review finds no existing-private-row
publication or mutation during upgrade. Reverting application code after the
migration commits leaves 0003 and any later publication records in place. There
is no down migration, and an application rollback does not revoke publications.
Old-application startup/behavior compatibility has not been run or proven by these
tests; matching schemas alone would not be a meaningful complete compatibility
test. Real PostgreSQL evidence, old-application compatibility review and explicit
publication/deployment approval remain release gates.
