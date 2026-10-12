"""Staged disposable-PostgreSQL gates; not run by source-only verification.

Synthetic credits only. No strategy, engine or subprocess is executed. These tests
must pass in CI before claiming real rollback or concurrent settlement correctness.
"""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from veyra_api import api_jobs, ledger, reservations
from veyra_api.settlement import SettlementIntegrityError, settle_job
from veyra_scheduler.reaper import reap_expired, reap_unused_authorizations


@pytest.fixture
def guarded_job(api, app):
    result = api.funded_job()
    who, org, quote, job = result
    try:
        yield result
    finally:
        # Session-scoped app: never leave corrupt/running fixtures for another reaper test.
        with app.state.db.tx() as conn:
            current = conn.execute("SELECT state FROM jobs WHERE id = %s",
                                   (job["id"],)).fetchone()
            if current["state"] != "settled":
                conn.execute("UPDATE jobs SET authorization_id = %s, config = %s WHERE id = %s",
                             (job["authorization_id"], json.dumps(job["config"]), job["id"]))
                conn.execute("UPDATE authorizations SET reserved_nano = %s WHERE id = %s",
                             (quote["customer_max_nano"], job["authorization_id"]))
                conn.execute("UPDATE quotes SET input_hash = %s WHERE id = %s",
                             (quote["input_hash"], quote["id"]))
                settle_job(conn, UUID(job["id"]), "cancelled")


def snapshot(app, job_id):
    with app.state.db.tx() as conn:
        return {
            "job": conn.execute("SELECT * FROM jobs WHERE id = %s", (job_id,)).fetchone(),
            "authorized_jobs": conn.execute(
                "SELECT * FROM jobs WHERE authorization_id = %s ORDER BY id",
                (job_id,)).fetchall(),
            "auths": conn.execute("SELECT * FROM authorizations ORDER BY id").fetchall(),
            "attempts": conn.execute("SELECT * FROM job_attempts WHERE job_id = %s ORDER BY id",
                                     (job_id,)).fetchall(),
            "usage": conn.execute("SELECT * FROM usage_events WHERE job_id = %s ORDER BY id",
                                  (job_id,)).fetchall(),
            "entries": conn.execute("SELECT * FROM journal_entries ORDER BY id").fetchall(),
            "lines": conn.execute(
                "SELECT * FROM journal_lines ORDER BY entry_id, account_id").fetchall(),
            "balances": conn.execute("SELECT * FROM ledger_accounts ORDER BY id").fetchall(),
            "outbox": conn.execute("SELECT * FROM outbox WHERE resource_id = %s ORDER BY id",
                                   (job_id,)).fetchall(),
        }


def corrupt(api, app, who, org, quote, job, kind):
    replacement = None
    if kind in ("cross_org_authorization", "same_org_authorization"):
        target = api.org(who) if kind == "cross_org_authorization" else org
        if target != org:
            api.topup(who, target)
        project = api.project(who, target)
        replacement = api.authorize(who, api.quote(who, project["latest_version"]["id"]))
    with app.state.db.tx() as conn:
        if replacement:
            conn.execute("UPDATE jobs SET authorization_id = %s WHERE id = %s",
                         (replacement["id"], job["id"]))
        elif kind in ("ceiling_increase", "ceiling_decrease"):
            conn.execute("UPDATE authorizations SET reserved_nano = reserved_nano + %s "
                         "WHERE id = %s",
                         (1 if kind == "ceiling_increase" else -1, job["authorization_id"]))
        elif kind == "quote_hash":
            conn.execute("UPDATE quotes SET input_hash = 'changed' WHERE id = %s", (quote["id"],))
        else:
            config = job["config"] | {kind: "large" if kind == "resource_class" else "unknown"}
            conn.execute("UPDATE jobs SET config = %s WHERE id = %s",
                         (json.dumps(config), job["id"]))


@pytest.mark.parametrize("kind", [
    "cross_org_authorization", "same_org_authorization", "ceiling_increase", "ceiling_decrease",
    "quote_hash", "resource_class", "rate_version",
])
def test_worker_finish_rolls_back_attempt_usage_and_finances_on_identity_drift(
        api, app, worker, guarded_job, kind):
    who, org, quote, job = guarded_job
    claim = worker.claim(job["id"])
    corrupt(api, app, who, org, quote, job, kind)
    before = snapshot(app, job["id"])
    with pytest.raises(SettlementIntegrityError):
        worker._finish(claim, "failed", "preflight rejected", 0, None, {}, [])
    assert snapshot(app, job["id"]) == before
    with app.state.db.tx() as conn:
        assert ledger.reconcile(conn) == []


def test_queued_cancel_cannot_release_altered_ceiling(api, app, guarded_job, monkeypatch):
    who, org, quote, job = guarded_job
    corrupt(api, app, who, org, quote, job, "ceiling_increase")
    before = snapshot(app, job["id"])
    rejected = []

    def observe(conn, job_id, *args, **kwargs):
        try:
            return settle_job(conn, job_id, *args, **kwargs)
        except SettlementIntegrityError:
            rejected.append(str(job_id))
            raise

    monkeypatch.setattr(api_jobs, "settle_job", observe)
    response = api.c.post(f"/v1/jobs/{job['id']}/cancel", headers=who)
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal Server Error"}
    assert rejected == [job["id"]]
    assert snapshot(app, job["id"]) == before


def test_reaper_rolls_back_fence_attempt_usage_and_finances(
        api, app, worker, guarded_job, monkeypatch):
    who, org, quote, job = guarded_job
    claim = worker.claim(job["id"])
    with app.state.db.tx() as conn:
        conn.execute("UPDATE job_attempts SET lease_expires_at = now() - interval '1 second' "
                     "WHERE id = %s", (claim.attempt_id,))
    corrupt(api, app, who, org, quote, job, "ceiling_increase")
    before = snapshot(app, job["id"])
    attempted = []
    from veyra_scheduler import reaper

    approved_rates = reaper._approved_rates

    def observe(conn, candidate, auth):
        attempted.append(str(candidate["id"]))
        return approved_rates(conn, candidate, auth)

    monkeypatch.setattr(reaper, "_approved_rates", observe)
    assert job["id"] not in reap_expired(app.state.db)
    assert str(job["id"]) in attempted
    assert snapshot(app, job["id"]) == before


def test_runtime_only_platform_fault_releases_original_reservation_without_charge(
        api, app, worker, guarded_job):
    who, org, quote, job = guarded_job
    claim = worker.claim(job["id"])
    with app.state.db.tx() as conn:
        conn.execute("UPDATE jobs SET config = config || %s::jsonb WHERE id = %s",
                     (json.dumps({"params": {"changed": True}, "max_runtime_seconds": "bad"}),
                      job["id"]))
    worker._finish(claim, "failed", "preflight rejected", 0, None, {}, [])
    current = api.get_job(who, job["id"])
    assert current["state"] == "settled" and current["outcome"] == "failed"
    assert current["receipt"]["customer_charge_nano"] == 0
    assert current["receipt"]["released_nano"] == quote["customer_max_nano"]
    assert api.balance(who, org)["reserved_nano"] == 0
    with app.state.db.tx() as conn:
        assert ledger.reconcile(conn) == []


def test_concurrent_valid_settlement_posts_once_and_replay_remains_noop(api, app, guarded_job):
    who, org, quote, job = guarded_job
    barrier = Barrier(2)

    def settle():
        with app.state.db.tx() as conn:
            conn.execute("SET LOCAL lock_timeout = '5s'")
            conn.execute("SET LOCAL statement_timeout = '10s'")
            barrier.wait(timeout=5)
            return settle_job(conn, UUID(job["id"]), "cancelled")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: settle(), range(2)))
    assert sum(result is None for result in results) == 1
    receipt = next(result for result in results if result is not None)
    assert receipt["released_nano"] == quote["customer_max_nano"]
    with app.state.db.tx() as conn:
        assert conn.execute("SELECT count(*) AS n FROM journal_entries "
                            "WHERE idempotency_key = %s",
                            (f"settle:{job['authorization_id']}",)).fetchone()["n"] == 1
        assert settle_job(conn, UUID(job["id"]), "failed") is None
        assert ledger.reconcile(conn) == []
    assert api.balance(who, org)["reserved_nano"] == 0


@pytest.mark.parametrize("caller", ["late_claim", "unused_reaper"])
@pytest.mark.parametrize("kind", ["ceiling", "org", "hash"])
def test_unused_release_rolls_back_corrupt_approval(api, app, monkeypatch, caller, kind):
    who = api.user()
    org = api.org(who)
    api.topup(who, org)
    project = api.project(who, org)
    quote = api.quote(who, project["latest_version"]["id"])
    auth = api.authorize(who, quote)
    other_org = api.org(who)
    with app.state.db.tx() as conn:
        original = conn.execute("SELECT * FROM authorizations WHERE id = %s",
                                (auth["id"],)).fetchone()
        # The same authenticated caller owns both orgs, so tenancy checks reach the guard.
        assert conn.execute("SELECT role FROM memberships WHERE org_id = %s AND user_id = %s",
                            (other_org, original["approved_by"])).fetchone()["role"] == "owner"
        conn.execute("UPDATE authorizations SET created_at = "
                     "(SELECT LEAST(min(created_at), now()) - interval '1 day' "
                     "FROM authorizations) WHERE id = %s", (auth["id"],))
        if kind == "ceiling":
            conn.execute("UPDATE authorizations SET reserved_nano = reserved_nano + 1 "
                         "WHERE id = %s", (auth["id"],))
        elif kind == "org":
            conn.execute("UPDATE authorizations SET org_id = %s WHERE id = %s",
                         (other_org, auth["id"]))
        else:
            conn.execute("UPDATE authorizations SET input_hash = 'changed' WHERE id = %s",
                         (auth["id"],))
    try:
        before = snapshot(app, auth["id"])
        rejected = []
        from veyra_scheduler import reaper

        def observe(conn, candidate):
            try:
                return reservations.release_expired_unused(conn, candidate)
            except SettlementIntegrityError:
                rejected.append(str(candidate["id"]))
                raise

        monkeypatch.setattr(reaper, "release_expired_unused", observe)
        monkeypatch.setattr(api_jobs, "release_expired_unused", observe)
        if caller == "late_claim":
            response = api.c.post("/v1/jobs", json={"authorization_id": auth["id"]},
                                  headers=who | {"idempotency-key": "corrupt-approval-claim"})
            assert response.status_code == 500
            assert response.json() == {"detail": "Internal Server Error"}
        else:
            assert auth["id"] not in reap_unused_authorizations(app.state.db, batch_size=1)
        assert rejected == [auth["id"]]
        assert snapshot(app, auth["id"]) == before
    finally:
        with app.state.db.tx() as conn:
            conn.execute("UPDATE authorizations SET created_at = %s, org_id = %s, "
                         "input_hash = %s, reserved_nano = %s WHERE id = %s",
                         (original["created_at"], original["org_id"], original["input_hash"],
                          original["reserved_nano"], auth["id"]))
