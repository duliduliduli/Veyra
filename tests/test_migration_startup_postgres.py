"""Staged, unrun PostgreSQL runner gates. Never include in source-only checks.

Every test owns a newly created disposable database, not the shared app schema.
Only migration SQL and synthetic private rows run here; no app, worker or engine.
"""

import os
import time
from concurrent.futures import ThreadPoolExecutor
from importlib import resources
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import make_conninfo
from veyra_api import db

LOCK = "SELECT pg_advisory_xact_lock(7426001)"
VERSIONS = ["0001_init", "0002_strategy_organization", "0003_strategy_publications"]
MIGRATIONS = resources.files("veyra_api.migrations")


@pytest.fixture
def migration_url():
    admin_url = os.environ.get("TEST_DATABASE_ADMIN_URL",
                               "postgresql://veyra:veyra@localhost:5432/postgres")
    name = "veyra_migration_" + uuid4().hex
    # Cleanup is reached only after this test successfully creates its own database.
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
    url = make_conninfo(admin_url, dbname=name, options="-csearch_path=public")
    try:
        with psycopg.connect(url) as conn:
            assert conn.execute("SELECT current_database()").fetchone() == (name,)
            assert conn.execute("SELECT to_regclass('public.schema_migrations')") \
                .fetchone() == (None,)
        yield url
    finally:
        # No FORCE, shared schema cleanup, production name, or down migration.
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))


def select_migrations(monkeypatch, paths):
    monkeypatch.setattr(db, "resources", SimpleNamespace(
        files=lambda package: SimpleNamespace(iterdir=lambda: iter(paths))))


def seed_0002(monkeypatch, url):
    with monkeypatch.context() as patch:
        select_migrations(patch, [MIGRATIONS / f"{version}.sql" for version in VERSIONS[:2]])
        assert db.migrate(url) == VERSIONS[:2]
    with psycopg.connect(url) as conn:
        user = conn.execute("INSERT INTO users(auth_subject) VALUES ('legacy') RETURNING id") \
            .fetchone()[0]
        org = conn.execute("INSERT INTO organizations(name) VALUES ('Legacy') RETURNING id") \
            .fetchone()[0]
        project = conn.execute(
            "INSERT INTO projects(org_id, name, description, folder, created_by) "
            "VALUES (%s, 'PRIVATE NAME', 'PRIVATE DESCRIPTION', 'PRIVATE FOLDER', %s) RETURNING *",
            (org, user)).fetchone()
        conn.execute(
            "INSERT INTO project_versions(org_id, project_id, version_no, content_hash, "
            "entrypoint, object_key, created_by) "
            "VALUES (%s, %s, 1, 'sha256:legacy', 'main.py', 'private.json', %s)",
            (org, project[0], user))
    return private_rows(url)


def private_rows(url):
    with psycopg.connect(url) as conn:
        return {table: conn.execute(sql.SQL("SELECT * FROM {} ORDER BY id").format(
            sql.Identifier(table))).fetchall()
                for table in ("users", "organizations", "projects", "project_versions")}


def ledger_rows(url):
    with psycopg.connect(url) as conn:
        return conn.execute("SELECT version, applied_at FROM schema_migrations ORDER BY version") \
            .fetchall()


class ObservedConnection:
    """Delegate transactions unchanged; use barriers only around real runner SQL."""

    def __init__(self, connection, observe):
        self.connection = connection
        self.observe = observe

    def __enter__(self):
        self.connection.__enter__()
        return self

    def __exit__(self, *args):
        return self.connection.__exit__(*args)

    def execute(self, query, params=None):
        self.observe(self.connection, query, "before")
        result = self.connection.execute(query, params)
        self.observe(self.connection, query, "after")
        return result

    def commit(self):
        return self.connection.commit()


def observe_connections(monkeypatch, observe):
    def connect(url, *, autocommit):
        return ObservedConnection(psycopg.connect(url, autocommit=autocommit), observe)

    monkeypatch.setattr(db, "psycopg", SimpleNamespace(connect=connect))


def test_runner_upgrades_0002_preserves_private_rows_and_repeat_ledger(migration_url, monkeypatch):
    before = seed_0002(monkeypatch, migration_url)
    original_ledger = ledger_rows(migration_url)
    assert db.migrate(migration_url) == VERSIONS[2:]
    assert private_rows(migration_url) == before
    upgraded_ledger = ledger_rows(migration_url)
    assert upgraded_ledger[:2] == original_ledger
    assert [row[0] for row in upgraded_ledger] == VERSIONS
    with psycopg.connect(migration_url) as conn:
        assert conn.execute("SELECT * FROM strategy_publications").fetchall() == []
    assert db.migrate(migration_url) == []
    assert ledger_rows(migration_url) == upgraded_ledger
    assert private_rows(migration_url) == before
    with psycopg.connect(migration_url) as conn:
        assert conn.execute("SELECT * FROM strategy_publications").fetchall() == []


def test_runner_partial_failure_rolls_back_schema_and_ledger_then_clean_retry(
        migration_url, monkeypatch, tmp_path):
    before = seed_0002(monkeypatch, migration_url)
    original_ledger = ledger_rows(migration_url)
    probe = tmp_path / "0004_probe.sql"
    probe.write_text("CREATE TABLE migration_probe (id integer PRIMARY KEY);")
    failure = tmp_path / "0005_failure.sql"
    failure.write_text("SELECT 1 / 0;")
    # The real runner sorts Paths; keep every unchanged/injected file in one directory.
    real_files = []
    for version in VERSIONS:
        target = tmp_path / f"{version}.sql"
        target.write_bytes((MIGRATIONS / target.name).read_bytes())
        real_files.append(target)
    with monkeypatch.context() as patch:
        select_migrations(patch, real_files + [probe, failure])
        with pytest.raises(psycopg.errors.DivisionByZero):
            db.migrate(migration_url)
    assert private_rows(migration_url) == before
    assert ledger_rows(migration_url) == original_ledger
    with psycopg.connect(migration_url) as conn:
        for table in ("strategy_publications", "migration_probe"):
            assert conn.execute("SELECT to_regclass(%s)", (table,)).fetchone() == (None,)
        assert conn.execute("SELECT to_regprocedure('protect_strategy_publication()')") \
            .fetchone() == (None,)
    with monkeypatch.context() as patch:
        select_migrations(patch, real_files + [probe])
        assert db.migrate(migration_url) == VERSIONS[2:] + ["0004_probe"]
        committed_ledger = ledger_rows(migration_url)
        assert db.migrate(migration_url) == []
        assert ledger_rows(migration_url) == committed_ledger
    assert [row[0] for row in committed_ledger] == VERSIONS + ["0004_probe"]
    assert private_rows(migration_url) == before
    with psycopg.connect(migration_url) as conn:
        assert conn.execute("SELECT * FROM migration_probe").fetchall() == []
        assert conn.execute("SELECT * FROM strategy_publications").fetchall() == []


def test_two_runners_serialize_before_ledger_and_second_skips_committed_versions(
        migration_url, monkeypatch):
    acquired, release, waiting = Event(), Event(), Event()
    owner, contender = [], []
    contender_statements = []

    def observe(conn, query, phase):
        pid = conn.info.backend_pid
        if phase == "before" and acquired.is_set() and pid != owner[0]:
            contender_statements.append(query)
            if query == LOCK:
                contender.append(pid)
                waiting.set()
        if query == LOCK and phase == "after" and not acquired.is_set():
            owner.append(pid)
            acquired.set()
            assert release.wait(timeout=10), "first runner was not released"

    observe_connections(monkeypatch, observe)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(db.migrate, migration_url)
        try:
            assert acquired.wait(timeout=5)
            second = pool.submit(db.migrate, migration_url)
            assert waiting.wait(timeout=2)
            with psycopg.connect(migration_url, autocommit=True) as observer:
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    blockers = observer.execute("SELECT pg_blocking_pids(%s)",
                                                (contender[0],)).fetchone()[0]
                    if owner[0] in blockers:
                        break
                    time.sleep(0.01)
                else:
                    pytest.fail("second runner was not blocked by the first advisory lock")
            assert not first.done() and not second.done()
            assert contender_statements == [
                "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'", LOCK]
        finally:
            release.set()
        assert first.result(timeout=15) == VERSIONS
        assert second.result(timeout=15) == []
    assert [row[0] for row in ledger_rows(migration_url)] == VERSIONS
    assert db.migrate(migration_url) == []


def test_advisory_contention_times_out_before_ledger_then_clean_retry(migration_url, monkeypatch):
    statements = []
    observe_connections(monkeypatch, lambda conn, query, phase:
                        statements.append(query) if phase == "before" else None)
    with psycopg.connect(migration_url) as holder:
        holder.execute(LOCK)
        started = time.monotonic()
        with pytest.raises(psycopg.errors.LockNotAvailable) as caught:
            db.migrate(migration_url)
        assert caught.value.sqlstate == "55P03"
        assert 4 <= time.monotonic() - started < 15
        assert statements == [
            "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'", LOCK]
        assert holder.execute("SELECT to_regclass('schema_migrations')").fetchone() == (None,)
    assert db.migrate(migration_url) == VERSIONS
    assert db.migrate(migration_url) == []


def test_ledger_contention_times_out_without_writes_then_repeat_succeeds(migration_url):
    assert db.migrate(migration_url) == VERSIONS
    before = ledger_rows(migration_url)
    with psycopg.connect(migration_url) as holder:
        holder.execute("LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE")
        started = time.monotonic()
        with pytest.raises(psycopg.errors.LockNotAvailable) as caught:
            db.migrate(migration_url)
        assert caught.value.sqlstate == "55P03"
        assert 4 <= time.monotonic() - started < 15
    assert ledger_rows(migration_url) == before
    assert db.migrate(migration_url) == []
    assert ledger_rows(migration_url) == before
