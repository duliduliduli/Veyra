"""Spec §30 sprint exit: inspect code, authorize a bounded job, observe it, receive an
immutable report and receipt, and verify safe cancellation."""

import threading
import uuid

from conftest import SLOW_STRATEGY, Api, wait_for
from veyra_api import ledger

TOPUP = 10 * 10**9


def _reconciled(app):
    with app.state.db.tx() as conn:
        assert ledger.reconcile(conn) == []


def test_full_vertical_slice(api: Api, worker, app):
    who, org, quote, job = api.funded_job()
    assert job["state"] == "queued"
    assert api.balance(who, org)["reserved_nano"] == quote["customer_max_nano"]

    assert worker.run_once(job["id"])
    job = api.get_job(who, job["id"])
    assert job["state"] == "settled" and job["outcome"] == "completed"
    receipt = job["receipt"]
    assert 0 < receipt["customer_charge_nano"] <= quote["customer_max_nano"]
    assert receipt["released_nano"] == quote["customer_max_nano"] - receipt[
        "customer_charge_nano"]

    bal = api.balance(who, org)
    assert bal["reserved_nano"] == 0
    assert bal["available_nano"] == TOPUP - receipt["customer_charge_nano"]
    assert bal["settled_usage_nano"] == receipt["customer_charge_nano"]

    rep = api.ok(api.c.get(f"/v1/reports/{job['report_id']}", headers=who))
    assert rep["outcome"] == "completed"
    assert rep["metrics"]["trade_count"] > 0
    assert set(rep["artifacts"]) == {"report.json", "report.html", "trades.csv"}
    full = api.ok(api.c.get(f"/v1/reports/{job['report_id']}/artifacts/report.json",
                            headers=who))
    assert full["provenance"]["run_inputs_hash"] == quote["input_hash"]
    assert full["evidence_note"].startswith("Synthetic")
    html = api.c.get(f"/v1/reports/{job['report_id']}/artifacts/report.html", headers=who)
    assert "sandbox" in html.headers["content-security-policy"]
    _reconciled(app)


def test_same_inputs_reproduce_identical_results(api: Api, worker):
    who = api.user()
    org = api.org(who)
    api.topup(who, org)
    proj = api.project(who, org)
    digests = []
    for _ in range(2):
        q = api.quote(who, proj["latest_version"]["id"])
        job = api.job(who, api.authorize(who, q)["id"])
        worker.run_once(job["id"])
        rep_id = api.get_job(who, job["id"])["report_id"]
        digests.append(api.ok(api.c.get(f"/v1/reports/{rep_id}", headers=who))["result_digest"])
    assert digests[0] == digests[1]


def test_job_creation_is_idempotent(api: Api):
    who, org, quote, job = api.funded_job()
    auth_id = job["authorization_id"]
    again = api.c.post("/v1/jobs", json={"authorization_id": auth_id},
                       headers=who | {"idempotency-key": "k" * 8})
    assert again.status_code == 409  # authorization already consumed by another key
    # replaying the original key returns the original job (no second reservation)
    q2 = api.quote(who, job["project_version_id"])
    a2 = api.authorize(who, q2)
    j1 = api.job(who, a2["id"], key="same-key-123")
    j2 = api.job(who, a2["id"], key="same-key-123")
    assert j1["id"] == j2["id"]


def test_consent_must_match_quote_and_funds_must_exist(api: Api):
    who = api.user()
    org = api.org(who)
    proj = api.project(who, org)
    q = api.quote(who, proj["latest_version"]["id"])
    r = api.c.post(f"/v1/quotes/{q['id']}/authorize", headers=who,
                   json={"accept_max_nano": q["customer_max_nano"] - 1})
    assert r.status_code == 409
    r = api.c.post(f"/v1/quotes/{q['id']}/authorize", headers=who,
                   json={"accept_max_nano": q["customer_max_nano"]})
    assert r.status_code == 402  # no credit yet
    assert api.balance(who, org)["reserved_nano"] == 0


def test_cancel_queued_job_releases_everything(api: Api, app):
    who, org, quote, job = api.funded_job()
    job = api.ok(api.c.post(f"/v1/jobs/{job['id']}/cancel", headers=who))
    assert job["state"] == "settled" and job["outcome"] == "cancelled"
    assert job["receipt"]["customer_charge_nano"] == 0
    assert api.balance(who, org)["available_nano"] == TOPUP
    _reconciled(app)


def test_cancel_running_job_produces_labelled_incomplete_report(api: Api, worker, app):
    who, org, quote, job = api.funded_job(source=SLOW_STRATEGY)
    t = threading.Thread(target=worker.run_once, args=(job["id"],))
    t.start()
    wait_for(lambda: api.get_job(who, job["id"])["progress"].get("bars_done"))
    api.ok(api.c.post(f"/v1/jobs/{job['id']}/cancel", headers=who))
    t.join(timeout=30)
    job = api.get_job(who, job["id"])
    assert job["outcome"] == "incomplete" and job["error"] == "cancelled by user"
    rep = api.ok(api.c.get(f"/v1/reports/{job['report_id']}/artifacts/report.json",
                           headers=who))
    assert rep["complete"] is False
    assert rep["bars"]["processed"] < rep["bars"]["total"]
    html = api.c.get(f"/v1/reports/{job['report_id']}/artifacts/report.html", headers=who).text
    assert "INCOMPLETE RUN" in html
    assert job["receipt"]["customer_charge_nano"] <= quote["customer_max_nano"]
    _reconciled(app)


def test_runaway_strategy_is_stopped_at_authorized_runtime(api: Api, worker, app):
    spin = ("from veyra_sdk import Strategy\n"
            "class Spin(Strategy):\n"
            "    def on_bar(self, bar, ctx):\n"
            "        while True:\n"
            "            pass\n")
    who, org, quote, job = api.funded_job(source=spin, max_runtime_seconds=10)
    worker.run_once(job["id"])
    job = api.get_job(who, job["id"])
    assert job["outcome"] == "incomplete"
    assert job["error"] == "authorized maximum runtime reached"
    assert job["receipt"]["customer_charge_nano"] <= quote["customer_max_nano"]
    _reconciled(app)


def test_crashing_strategy_fails_and_bills_only_usage(api: Api, worker, app):
    boom = ("from veyra_sdk import Strategy\n"
            "class Boom(Strategy):\n"
            "    def on_bar(self, bar, ctx):\n"
            "        raise ValueError('kaboom')\n")
    who, org, quote, job = api.funded_job(source=boom)
    worker.run_once(job["id"])
    job = api.get_job(who, job["id"])
    assert job["outcome"] == "failed" and "kaboom" in job["error"]
    assert job["report_id"] is None
    assert job["receipt"]["customer_charge_nano"] <= quote["customer_max_nano"]
    _reconciled(app)


def test_strategy_cannot_forge_protocol_or_see_the_future(api: Api, worker):
    sneaky = (
        "import json, sys\n"
        "from veyra_sdk import Strategy\n"
        "class Sneaky(Strategy):\n"
        "    def initialize(self, config, instrument):\n"
        "        super().initialize(config, instrument)\n"
        "        self.seen = []\n"
        "    def on_bar(self, bar, ctx):\n"
        "        assert not self.seen or bar.ts > self.seen[-1]\n"
        "        self.seen.append(bar.ts)\n"
        "        print(json.dumps({'type': 'intents', 'seq': ctx.seq, 'intents': [\n"
        "            {'client_id': 'x', 'side': 'buy', 'qty': '1000000'}]}))\n"
        "        if ctx.seq == 0:\n"
        "            ctx.buy('0.01')\n")
    who, org, quote, job = api.funded_job(source=sneaky)
    worker.run_once(job["id"])
    job = api.get_job(who, job["id"])
    assert job["outcome"] == "completed", job["error"]
    rep = api.ok(api.c.get(f"/v1/reports/{job['report_id']}/artifacts/report.json",
                           headers=who))
    assert len(rep["fills"]) == 1  # only the real ctx.buy, not the printed fake
    fill = rep["fills"][0]
    # signal on bar 0, filled at bar 1's open - never on the bar that produced it
    assert fill["ts"] == rep["equity_curve"][1][0]


def test_two_workers_never_claim_the_same_job(api: Api, app):
    from veyra_scheduler.worker import Worker

    who, org, quote, job = api.funded_job()
    w1 = Worker(app.state.db, app.state.store, app.state.settings, "w1")
    w2 = Worker(app.state.db, app.state.store, app.state.settings, "w2")
    results: list = []
    barrier = threading.Barrier(2)

    def go(w):
        barrier.wait()
        results.append(w.claim(job["id"]))

    threads = [threading.Thread(target=go, args=(w,)) for w in (w1, w2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    claims = [c for c in results if c]
    assert len(claims) == 1
    w1.execute(claims[0])
    assert api.get_job(who, job["id"])["outcome"] == "completed"


def test_unknown_idempotency_and_bad_input_are_rejected(api: Api):
    who = api.user()
    org = api.org(who)
    proj = api.project(who, org)
    vid = proj["latest_version"]["id"]
    bad = [{"start": "2022-01-01", "end": "2021-01-01"}, {"dataset_id": "nope"},
           {"max_runtime_seconds": 10**6}, {"start": "1990-01-01", "end": "1990-02-01"}]
    for kw in bad:
        body = {"project_version_id": vid, "dataset_id": "synth-btcusd-1d-v1",
                "start": "2021-01-01", "end": "2022-01-01"} | kw
        assert api.c.post("/v1/quotes", json=body, headers=who).status_code == 422, kw
    r = api.c.post("/v1/jobs", json={"authorization_id": str(uuid.uuid4())}, headers=who)
    assert r.status_code == 422  # Idempotency-Key header required


def _assert_customer_fault(api, who, job, quote):
    job = api.get_job(who, job["id"])
    assert job["outcome"] == "failed"
    assert job["error"].startswith("strategy error"), job["error"]
    # a misbehaving strategy pays for what it used; it must not get free compute
    assert 0 < job["receipt"]["customer_charge_nano"] <= quote["customer_max_nano"]


def test_absurd_quantity_is_a_strategy_error_not_free_compute(api: Api, worker):
    huge = ("from veyra_sdk import Strategy\n"
            "class Huge(Strategy):\n"
            "    def on_bar(self, bar, ctx):\n"
            "        ctx.buy('1e40')\n")
    who, org, quote, job = api.funded_job(source=huge)
    worker.run_once(job["id"])
    _assert_customer_fault(api, who, job, quote)


def test_raw_writes_to_stdout_cannot_break_the_protocol(api: Api, worker):
    raw = ("import os\n"
           "from veyra_sdk import Strategy\n"
           "class Raw(Strategy):\n"
           "    def on_bar(self, bar, ctx):\n"
           "        os.write(1, b'not json\\n')\n")
    who, org, quote, job = api.funded_job(source=raw)
    worker.run_once(job["id"])
    job = api.get_job(who, job["id"])
    # raw fd writes go to stderr now, so the run completes normally
    assert job["outcome"] == "completed", job["error"]


def test_chart_bars_and_web_app_are_served(api: Api):
    who = api.user()
    bars = api.ok(api.c.get("/v1/catalog/datasets/synth-btcusd-1d-v1/bars",
                            params={"start": "2021-01-01", "end": "2021-02-01"}, headers=who))
    assert len(bars["bars"]) == 31 and bars["bars"][0]["ts"].startswith("2021-01-01")
    assert api.c.get("/v1/catalog/datasets/nope/bars", headers=who).status_code == 404
    page = api.c.get("/")
    assert page.status_code == 200 and "<title>" in page.text
    assert "script-src" not in page.headers["content-security-policy"]  # 'self' only
