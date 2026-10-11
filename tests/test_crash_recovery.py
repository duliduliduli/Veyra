"""Spec §30 step 9: kill the worker mid-run; prove no duplicate charge, no orphan
worker, and correct reservation release. Also: a stale worker cannot write after its
lease was taken over (fencing)."""

import os
import signal
import subprocess
import sys
import time

import pytest
from conftest import SLOW_STRATEGY, Api, wait_for
from veyra_api import ledger
from veyra_scheduler.reaper import reap_expired
from veyra_scheduler.worker import LeaseLost


def _children(pid: int) -> list[int]:
    out = subprocess.run(["ps", "-o", "pid=", "--ppid", str(pid)], capture_output=True,
                         text=True).stdout
    return [int(x) for x in out.split()]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    stat = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True,
                          text=True).stdout.strip()
    return bool(stat) and not stat.startswith("Z")


def test_killed_worker_is_reaped_without_orphans_or_double_charge(api: Api, app, settings):
    who, org, quote, job = api.funded_job(source=SLOW_STRATEGY)
    code = ("import sys, logging\n"
            "from veyra_api.db import Database\n"
            "from veyra_api.storage import ObjectStore\n"
            "from veyra_api import config\n"
            "from veyra_scheduler.worker import Worker\n"
            "s = config.load()\n"
            "Worker(Database(s.database_url), ObjectStore(s.object_store_dir), s,"
            " 'doomed').run_once(sys.argv[1])\n")
    env = os.environ | {"APP_ENV": "test", "DATABASE_URL": settings.database_url,
                        "OBJECT_STORE_DIR": str(settings.object_store_dir),
                        "JOB_LEASE_SECONDS": str(settings.job_lease_seconds)}
    proc = subprocess.Popen([sys.executable, "-c", code, job["id"]], env=env)
    try:
        wait_for(lambda: api.get_job(who, job["id"])["progress"].get("bars_done"), timeout=30)
        strategy_pids = wait_for(lambda: _children(proc.pid))
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            proc.kill()

    # No orphan: the strategy process dies with its supervisor (PR_SET_PDEATHSIG).
    wait_for(lambda: not any(_alive(p) for p in strategy_pids), timeout=10)

    time.sleep(settings.job_lease_seconds + 0.5)
    reap_expired(app.state.db)
    assert reap_expired(app.state.db) == []  # second pass is a no-op

    job = api.get_job(who, job["id"])
    assert job["state"] == "settled" and job["outcome"] == "failed"
    assert job["attempts"][0]["end_reason"] == "lease_expired"
    charge = job["receipt"]["customer_charge_nano"]
    assert 0 < charge <= quote["customer_max_nano"]
    assert len(job["receipt"]["lines"]) == 1  # exactly one usage event

    bal = api.balance(who, org)
    assert bal["reserved_nano"] == 0
    assert bal["available_nano"] == 10 * 10**9 - charge
    with app.state.db.tx() as conn:
        assert ledger.reconcile(conn) == []


def test_stale_worker_cannot_write_after_takeover(api: Api, app, worker):
    who, org, quote, job = api.funded_job()
    claim = worker.claim(job["id"])
    assert claim is not None
    with app.state.db.tx() as conn:  # simulate a long GC pause / partition
        conn.execute("UPDATE job_attempts SET lease_expires_at = now() - interval '1 second' "
                     "WHERE id = %s", (claim.attempt_id,))
    assert str(job["id"]) in reap_expired(app.state.db)

    with pytest.raises(LeaseLost):
        worker.execute(claim)  # the zombie wakes up and tries to finish

    job = api.get_job(who, job["id"])
    assert job["outcome"] == "failed"
    assert len(job["receipt"]["lines"]) == 1
    assert job["report_id"] is None
    with app.state.db.tx() as conn:
        assert ledger.reconcile(conn) == []
