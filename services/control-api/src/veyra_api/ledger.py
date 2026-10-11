"""Append-only double-entry ledger with atomic reservations (spec §15.4).

Sign convention: journal line amounts are debit-positive. ``balance_nano`` on an
account is kept on its *normal* side (debit for assets/expenses, credit for
liabilities/revenue), so customer balances read as positive numbers.

Overspend safety comes from the database, not from read-then-write application logic:
reserving debits ``org:<id>:available`` with a single UPDATE; the row lock serializes
concurrent reservations and the ``balance_nonnegative`` CHECK rejects any that would
take it below zero.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from uuid import UUID

import psycopg
from psycopg import errors

DEBIT_NORMAL = {"asset", "expense"}

PLATFORM_ACCOUNTS = {
    "platform:payment_clearing": "asset",
    "platform:supplier_payable": "liability",
    "platform:fee_revenue": "revenue",
    "platform:overrun_expense": "expense",
}


class InsufficientFunds(Exception):
    pass


def available_code(org_id: UUID | str) -> str:
    return f"org:{org_id}:available"


def reserved_code(org_id: UUID | str) -> str:
    return f"org:{org_id}:reserved"


def ensure_platform_accounts(conn: psycopg.Connection) -> None:
    for code, kind in PLATFORM_ACCOUNTS.items():
        conn.execute("INSERT INTO ledger_accounts(code, kind) VALUES (%s, %s) "
                     "ON CONFLICT (code) DO NOTHING", (code, kind))


def ensure_org_accounts(conn: psycopg.Connection, org_id: UUID) -> None:
    ensure_platform_accounts(conn)
    for code in (available_code(org_id), reserved_code(org_id)):
        conn.execute("INSERT INTO ledger_accounts(code, org_id, kind, nonnegative) "
                     "VALUES (%s, %s, 'liability', true) ON CONFLICT (code) DO NOTHING",
                     (code, org_id))


@dataclass(frozen=True)
class Posted:
    entry_id: int
    created: bool  # False when the idempotency key had already been posted


def post(conn: psycopg.Connection, *, kind: str, idempotency_key: str,
         lines: list[tuple[str, int]], org_id: UUID | None = None,
         reference: dict | None = None) -> Posted:
    """Post a balanced entry exactly once per ``idempotency_key``.

    Must run inside the caller's transaction so it commits atomically with the
    business change it records.
    """
    lines = [(c, a) for c, a in lines if a != 0]
    if not lines:
        raise ValueError("entry has no non-zero lines")
    if sum(a for _, a in lines) != 0:
        raise ValueError("entry does not balance")

    row = conn.execute(
        "INSERT INTO journal_entries(org_id, kind, idempotency_key, reference) "
        "VALUES (%s, %s, %s, %s) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id",
        (org_id, kind, idempotency_key, json.dumps(reference or {}))).fetchone()
    if row is None:
        existing = conn.execute("SELECT id FROM journal_entries WHERE idempotency_key = %s",
                                (idempotency_key,)).fetchone()
        return Posted(existing["id"], False)
    entry_id = row["id"]

    codes = sorted({c for c, _ in lines})  # stable lock order avoids deadlocks
    accounts = {r["code"]: r for r in conn.execute(
        "SELECT id, code, kind FROM ledger_accounts WHERE code = ANY(%s) ORDER BY id FOR UPDATE",
        (codes,))}
    missing = set(codes) - accounts.keys()
    if missing:
        raise ValueError(f"unknown ledger accounts {sorted(missing)}")

    for code, amount in sorted(lines, key=lambda x: accounts[x[0]]["id"]):
        acct = accounts[code]
        conn.execute("INSERT INTO journal_lines(entry_id, account_id, amount_nano) "
                     "VALUES (%s, %s, %s)", (entry_id, acct["id"], amount))
        delta = amount if acct["kind"] in DEBIT_NORMAL else -amount
        try:
            with conn.transaction():  # savepoint so we can translate the error
                conn.execute("UPDATE ledger_accounts SET balance_nano = balance_nano + %s "
                             "WHERE id = %s", (delta, acct["id"]))
        except errors.CheckViolation:
            raise InsufficientFunds(code) from None
    return Posted(entry_id, True)


# ---------------------------------------------------------------- business postings

def credit_topup(conn, org_id: UUID, amount: int, payment_id: UUID) -> Posted:
    return post(conn, kind="topup", idempotency_key=f"topup:{payment_id}", org_id=org_id,
                reference={"payment_id": str(payment_id)},
                lines=[("platform:payment_clearing", amount), (available_code(org_id), -amount)])


def reserve(conn, org_id: UUID, amount: int, authorization_id: UUID) -> Posted:
    return post(conn, kind="reserve", idempotency_key=f"reserve:{authorization_id}",
                org_id=org_id, reference={"authorization_id": str(authorization_id)},
                lines=[(available_code(org_id), amount), (reserved_code(org_id), -amount)])


def settle(conn, org_id: UUID, authorization_id: UUID, *, charge: int, supplier: int,
           fee: int, overrun: int, release: int) -> Posted:
    if charge - supplier - fee + overrun != 0:
        raise ValueError("settlement amounts are inconsistent")
    lines = [
        (reserved_code(org_id), charge + release),
        (available_code(org_id), -release),
        ("platform:supplier_payable", -supplier),
        ("platform:fee_revenue", -fee),
        ("platform:overrun_expense", overrun),
    ]
    return post(conn, kind="settle", idempotency_key=f"settle:{authorization_id}",
                org_id=org_id, reference={"authorization_id": str(authorization_id),
                                          "charge_nano": charge, "release_nano": release},
                lines=lines)


def balances(conn, org_id: UUID) -> dict[str, int]:
    rows = conn.execute("SELECT code, balance_nano FROM ledger_accounts WHERE code = ANY(%s)",
                        ([available_code(org_id), reserved_code(org_id)],)).fetchall()
    by = {r["code"]: r["balance_nano"] for r in rows}
    settled = conn.execute(
        "SELECT COALESCE(sum((reference->>'charge_nano')::bigint), 0) AS s FROM journal_entries "
        "WHERE org_id = %s AND kind = 'settle'", (org_id,)).fetchone()["s"]
    return {"available_nano": by.get(available_code(org_id), 0),
            "reserved_nano": by.get(reserved_code(org_id), 0),
            "settled_usage_nano": int(settled)}


def reconcile(conn) -> list[str]:
    """Return discrepancies: cached balances vs journal, and global trial balance."""
    problems = []
    for r in conn.execute("""
        SELECT a.code, a.kind, a.balance_nano, COALESCE(sum(l.amount_nano), 0) AS raw
        FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
        GROUP BY a.id ORDER BY a.id"""):
        derived = r["raw"] if r["kind"] in DEBIT_NORMAL else -r["raw"]
        if derived != r["balance_nano"]:
            problems.append(f"{r['code']}: cached {r['balance_nano']} != journal {derived}")
    total = conn.execute("SELECT COALESCE(sum(amount_nano), 0) AS s FROM journal_lines").fetchone()
    if total["s"] != 0:
        problems.append(f"trial balance off by {total['s']}")
    return problems
