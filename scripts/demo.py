"""End-to-end walkthrough of the sprint-1 vertical slice over the public HTTP API.

    uv run python scripts/demo.py

Creates an org, adds $10 of (simulated) service credit through a signed payment
webhook, snapshots the SMA template, quotes and authorizes a bounded backtest, runs
it on a worker, and writes the report artifacts to ./demo-output/.
"""

import json
import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from veyra_api import config, payments
from veyra_api.app import create_app
from veyra_billing import format_usd
from veyra_scheduler.worker import Worker


def main() -> None:
    settings = config.load()
    app = create_app(settings)
    out = Path("demo-output")
    out.mkdir(exist_ok=True)
    with TestClient(app) as c:
        me = {"x-veyra-dev-user": "founder@example.test"}

        def ok(r):
            if r.status_code >= 400:
                raise SystemExit(f"{r.request.method} {r.request.url} -> {r.status_code} {r.text}")
            return r.json()

        org = ok(c.post("/v1/orgs", json={"name": "Demo org"}, headers=me))["id"]
        pay = ok(c.post(f"/v1/orgs/{org}/billing/topups", json={"amount_usd": "10.00"},
                        headers=me))
        event = json.dumps({"id": f"evt_{uuid.uuid4().hex}", "type": "payment.succeeded",
                            "data": {"provider_ref": pay["provider_ref"],
                                     "amount_nano": pay["amount_nano"]}}).encode()
        ok(c.post("/v1/webhooks/payments/dev", content=event, headers={
            "veyra-signature": payments.sign(settings.payment_webhook_secret, event)}))
        print("balance:", ok(c.get(f"/v1/orgs/{org}/billing/balance", headers=me))["display"])

        proj = ok(c.post(f"/v1/orgs/{org}/projects",
                         json={"name": f"sma-{uuid.uuid4().hex[:6]}", "template": "sma_cross"},
                         headers=me))
        v = proj["latest_version"]
        print(f"code snapshot v{v['version_no']} {v['content_hash'][:20]}…")

        quote = ok(c.post("/v1/quotes", headers=me, json={
            "project_version_id": v["id"], "dataset_id": "synth-btcusd-1d-v1",
            "start": "2020-01-01", "end": "2024-01-01", "params": {"fast": 10, "slow": 40},
            "resource_class": "small", "max_runtime_seconds": 120}))
        print("quote:", quote["estimate"]["display"], "| expires", quote["expires_at"])

        auth = ok(c.post(f"/v1/quotes/{quote['id']}/authorize", headers=me,
                         json={"accept_max_nano": quote["customer_max_nano"]}))
        job = ok(c.post("/v1/jobs", json={"authorization_id": auth["id"]},
                        headers=me | {"idempotency-key": uuid.uuid4().hex}))
        print("job queued:", job["id"])

        Worker(app.state.db, app.state.store, settings, "demo-worker").run_once(job["id"])
        job = ok(c.get(f"/v1/jobs/{job['id']}", headers=me))
        r = job["receipt"]
        print(f"job {job['outcome']}: charged {format_usd(r['customer_charge_nano'], 6)} "
              f"of max {format_usd(r['authorized_max_nano'], 6)}; "
              f"released {format_usd(r['released_nano'], 6)}")

        rep = ok(c.get(f"/v1/reports/{job['report_id']}", headers=me))
        m = rep["metrics"]
        print(f"net return {m['net_return']}  max DD {m['max_drawdown']}  "
              f"sharpe {m['sharpe']}  trades {m['trade_count']}")
        for name in rep["artifacts"]:
            body = c.get(f"/v1/reports/{job['report_id']}/artifacts/{name}", headers=me)
            (out / name).write_bytes(body.content)
        print("balance:", ok(c.get(f"/v1/orgs/{org}/billing/balance", headers=me))["display"])
        print(f"artifacts written to {out.resolve()}")


if __name__ == "__main__":
    main()
