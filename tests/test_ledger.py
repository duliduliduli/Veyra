import threading
import uuid

import psycopg
import pytest
from veyra_api import ledger


def _org(app) -> uuid.UUID:
    with app.state.db.tx() as conn:
        org = conn.execute("INSERT INTO organizations(name) VALUES ('ledger') RETURNING id"
                           ).fetchone()["id"]
        ledger.ensure_org_accounts(conn, org)
        ledger.credit_topup(conn, org, 10 * 10**9, uuid.uuid4())
    return org


def test_concurrent_reservations_never_overspend(app):
    org = _org(app)  # $10 available
    results: list[bool] = []
    lock = threading.Lock()

    def attempt():
        try:
            with app.state.db.tx() as conn:
                ledger.reserve(conn, org, 10**9, uuid.uuid4())  # $1 each
            ok = True
        except ledger.InsufficientFunds:
            ok = False
        with lock:
            results.append(ok)

    threads = [threading.Thread(target=attempt) for _ in range(30)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(True) == 10
    with app.state.db.tx() as conn:
        b = ledger.balances(conn, org)
        assert b["available_nano"] == 0
        assert b["reserved_nano"] == 10 * 10**9
        assert ledger.reconcile(conn) == []


def test_posting_is_idempotent(app):
    org = _org(app)
    auth = uuid.uuid4()
    with app.state.db.tx() as conn:
        first = ledger.reserve(conn, org, 10**9, auth)
        second = ledger.reserve(conn, org, 10**9, auth)
        assert first.created and not second.created
        assert ledger.balances(conn, org)["reserved_nano"] == 10**9


def test_journal_is_append_only(app):
    _org(app)
    with pytest.raises(psycopg.errors.RaiseException), app.state.db.tx() as conn:
        conn.execute("UPDATE journal_lines SET amount_nano = amount_nano + 1")
    with pytest.raises(psycopg.errors.RaiseException), app.state.db.tx() as conn:
        conn.execute("DELETE FROM journal_entries")


def test_database_rejects_unbalanced_entries(app):
    org = _org(app)
    with pytest.raises(psycopg.errors.RaiseException), app.state.db.tx() as conn:
        e = conn.execute("INSERT INTO journal_entries(kind, idempotency_key) VALUES "
                         "('bad', %s) RETURNING id", (uuid.uuid4().hex,)).fetchone()["id"]
        acct = conn.execute("SELECT id FROM ledger_accounts WHERE code = %s",
                            (ledger.available_code(org),)).fetchone()["id"]
        conn.execute("INSERT INTO journal_lines(entry_id, account_id, amount_nano) "
                     "VALUES (%s, %s, -5)", (e, acct))
