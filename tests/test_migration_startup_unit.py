"""Runner contracts with transactional doubles, never a real connection or runtime."""

from dataclasses import dataclass, field
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from veyra_api import db

LIMITS = "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'"
LOCK = "SELECT pg_advisory_xact_lock(7426001)"
CREATE_LEDGER = """CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"""
READ_LEDGER = "SELECT version FROM schema_migrations"
INSERT_VERSION = "INSERT INTO schema_migrations(version) VALUES (%s)"
URL = "mock-migration-connection"


@pytest.fixture(autouse=True)
def no_external_boundaries(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("migration unit test crossed an external boundary")

    for target in (
        "psycopg.connect", "psycopg.Connection.connect", "psycopg.AsyncConnection.connect",
        "psycopg_pool.ConnectionPool.__init__", "veyra_api.db.Database.__init__",
        "socket.socket.connect", "socket.socket.connect_ex", "socket.create_connection",
        "threading.Thread.start", "subprocess.Popen", "os.system", "os.fork",
        "veyra_sim.engine.run", "veyra_sim.sandbox.StrategyProcess",
        "veyra_scheduler.worker.StrategyProcess", "veyra_sdk.host._load_strategy",
        "veyra_api.ledger.post", "veyra_api.ledger.reserve", "veyra_api.ledger.settle",
        "veyra_api.ledger.credit_topup", "veyra_api.ledger.ensure_org_accounts",
        "veyra_api.ledger.ensure_platform_accounts", "veyra_scheduler.worker.Worker.execute",
    ):
        monkeypatch.setattr(target, blocked)


@dataclass(order=True)
class MigrationFile:
    name: str
    events: list = field(compare=False)

    def read_text(self):
        self.events.append(("read", self.name))
        return f"SQL {self.name}"


class Connection:
    """Model driver commit/rollback; this does not prove PostgreSQL atomicity."""

    def __init__(self, events, versions=()):
        self.events = events
        self.versions = list(versions)
        self.sql = []
        self.failure = RuntimeError("injected migration failure")
        self.fail_at = None
        self.fail_commit = False
        self.fail_exit = False
        self.commits = self.rollbacks = 0

    def __enter__(self):
        self.events.append(("enter",))
        self.pending_versions = self.versions.copy()
        self.pending_sql = self.sql.copy()
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is not None:
            self.events.append(("rollback", exc))
            self.pending_versions = self.versions.copy()
            self.pending_sql = self.sql.copy()
            self.rollbacks += 1
        self.events.append(("exit", exc_type))
        if self.fail_exit:
            raise self.failure
        return False

    def execute(self, sql, params=None):
        self.events.append(("execute", sql, params))
        if (sql, params) == self.fail_at:
            raise self.failure
        if sql == READ_LEDGER:
            return [(version,) for version in self.pending_versions]
        if sql == INSERT_VERSION:
            assert params[0] not in self.pending_versions
            self.pending_versions.append(params[0])
        elif sql.startswith("SQL "):
            self.pending_sql.append(sql)
        else:
            assert sql in (LIMITS, LOCK, CREATE_LEDGER), f"unexpected SQL: {sql}"
        return []

    def commit(self):
        self.events.append(("commit",))
        if self.fail_commit:
            raise self.failure
        self.versions = self.pending_versions.copy()
        self.sql = self.pending_sql.copy()
        self.commits += 1


@pytest.fixture
def case(monkeypatch):
    events = []
    connection = Connection(events, ["0001_done"])
    files = [MigrationFile(name, events) for name in (
        "0003_next.sql", "__init__.py", "0001_done.sql", "0002_next.sql")]
    connect = Mock(return_value=connection)
    resources = Mock(return_value=SimpleNamespace(iterdir=lambda: iter(files)))
    # Replace only this module's references; the real connector remains a sentinel.
    monkeypatch.setattr(db, "psycopg", SimpleNamespace(connect=connect))
    monkeypatch.setattr(db, "resources", SimpleNamespace(files=resources))
    return SimpleNamespace(conn=connection, events=events, connect=connect, resources=resources)


def start_events():
    return [("enter",), ("execute", LIMITS, None), ("execute", LOCK, None),
            ("execute", CREATE_LEDGER, None), ("execute", READ_LEDGER, None)]


def migration_events(version):
    return [("read", f"{version}.sql"), ("execute", f"SQL {version}.sql", None),
            ("execute", INSERT_VERSION, (version,))]


def test_limits_precede_lock_and_ledger_then_sorted_missing_sql_and_single_commit(case):
    result = db.migrate(URL)
    case.events.append(("returned", result))
    case.connect.assert_called_once_with(URL, autocommit=False)
    case.resources.assert_called_once_with("veyra_api.migrations")
    assert case.events == (start_events() + migration_events("0002_next")
                           + migration_events("0003_next") + [
                               ("commit",), ("exit", None),
                               ("returned", ["0002_next", "0003_next"])])
    assert case.conn.versions == ["0001_done", "0002_next", "0003_next"]
    assert case.conn.commits == 1 and case.conn.rollbacks == 0


def test_repeat_startup_reads_committed_ledger_and_skips_all_recorded_sql(case):
    assert db.migrate(URL) == ["0002_next", "0003_next"]
    before = (case.conn.versions.copy(), case.conn.sql.copy())
    case.events.clear()
    assert db.migrate(URL) == []
    assert case.events == start_events() + [("commit",), ("exit", None)]
    assert (case.conn.versions, case.conn.sql) == before
    assert case.conn.commits == 2 and case.conn.rollbacks == 0


@pytest.mark.parametrize("failure", [
    (LIMITS, None), (LOCK, None), (CREATE_LEDGER, None), (READ_LEDGER, None),
    ("SQL 0003_next.sql", None), (INSERT_VERSION, ("0003_next",)),
], ids=["limits", "advisory", "create-ledger", "read-ledger", "partial-sql", "partial-ledger"])
def test_failure_propagates_without_commit_and_rolls_back_pending_sql_and_ledger(case, failure):
    case.conn.fail_at = failure
    with pytest.raises(RuntimeError) as caught:
        db.migrate(URL)
    assert caught.value is case.conn.failure
    assert case.conn.versions == ["0001_done"] and case.conn.sql == []
    assert case.conn.pending_versions == ["0001_done"] and case.conn.pending_sql == []
    assert case.conn.commits == 0 and case.conn.rollbacks == 1
    assert not any(event[0] == "commit" for event in case.events)
    assert case.events[-2:] == [("rollback", case.conn.failure), ("exit", RuntimeError)]
    if failure[0] in (LIMITS, LOCK, CREATE_LEDGER, READ_LEDGER):
        case.resources.assert_not_called()
    else:
        assert ("execute", INSERT_VERSION, ("0002_next",)) in case.events


def test_failed_attempt_can_be_retried_from_last_committed_version(case):
    case.conn.fail_at = (INSERT_VERSION, ("0003_next",))
    with pytest.raises(RuntimeError):
        db.migrate(URL)
    case.conn.fail_at = None
    case.events.clear()
    assert db.migrate(URL) == ["0002_next", "0003_next"]
    assert case.events == (start_events() + migration_events("0002_next")
                           + migration_events("0003_next") + [("commit",), ("exit", None)])
    assert case.conn.commits == case.conn.rollbacks == 1


def test_commit_failure_propagates_without_returning_applied_versions(case):
    case.conn.fail_commit = True
    with pytest.raises(RuntimeError) as caught:
        db.migrate(URL)
    assert caught.value is case.conn.failure
    assert case.conn.versions == ["0001_done"] and case.conn.sql == []
    assert case.conn.commits == 0 and case.conn.rollbacks == 1
    assert case.events[-3:] == [
        ("commit",), ("rollback", case.conn.failure), ("exit", RuntimeError)]


def test_context_exit_failure_propagates_even_after_successful_commit(case):
    case.conn.fail_exit = True
    with pytest.raises(RuntimeError) as caught:
        db.migrate(URL)
    assert caught.value is case.conn.failure
    assert case.conn.commits == 1 and case.conn.rollbacks == 0
    assert case.conn.versions == ["0001_done", "0002_next", "0003_next"]
    assert case.events[-2:] == [("commit",), ("exit", None)]
