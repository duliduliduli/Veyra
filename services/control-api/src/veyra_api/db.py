from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from importlib import resources

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class Database:
    def __init__(self, url: str, min_size: int = 1, max_size: int = 10):
        self.url = url
        self.pool = ConnectionPool(url, min_size=min_size, max_size=max_size,
                                   kwargs={"row_factory": dict_row}, open=True)

    @contextmanager
    def tx(self) -> Iterator[psycopg.Connection]:
        """One transaction. Commits on success, rolls back on any exception."""
        with self.pool.connection() as conn, conn.transaction():
            yield conn

    def close(self) -> None:
        self.pool.close()


def migrate(url: str) -> list[str]:
    applied = []
    with psycopg.connect(url, autocommit=False) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(7426001)")
        conn.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())""")
        done = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
        files = sorted(f for f in resources.files("veyra_api.migrations").iterdir()
                       if f.name.endswith(".sql"))
        for f in files:
            version = f.name.removesuffix(".sql")
            if version in done:
                continue
            conn.execute(f.read_text())
            conn.execute("INSERT INTO schema_migrations(version) VALUES (%s)", (version,))
            applied.append(version)
        conn.commit()
    return applied
