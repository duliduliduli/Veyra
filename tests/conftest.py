from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import replace

import psycopg
import pytest
from fastapi.testclient import TestClient
from veyra_api import config, payments
from veyra_api.app import create_app
from veyra_scheduler.worker import Worker

ADMIN_URL = os.environ.get("TEST_DATABASE_ADMIN_URL",
                           "postgresql://veyra:veyra@localhost:5432/postgres")


@pytest.fixture(scope="session")
def database_url():
    name = f"veyra_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    yield ADMIN_URL.rsplit("/", 1)[0] + f"/{name}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture(scope="session")
def settings(database_url, tmp_path_factory):
    return replace(config.load(), app_env="test", database_url=database_url,
                   object_store_dir=tmp_path_factory.mktemp("objects"),
                   payment_webhook_secret="test-secret", job_lease_seconds=2)


@pytest.fixture(scope="session")
def app(settings):
    application = create_app(settings)
    with TestClient(application) as client:
        application.state.client = client
        yield application


@pytest.fixture
def api(app):
    return Api(app.state.client, app.state.settings)


@pytest.fixture
def worker(app):
    return Worker(app.state.db, app.state.store, app.state.settings, worker_id="test-worker")


class Api:
    """Thin test client speaking the public HTTP contract."""

    def __init__(self, client: TestClient, settings):
        self.c = client
        self.settings = settings

    @staticmethod
    def user(name: str | None = None) -> dict:
        return {"x-veyra-dev-user": f"{name or uuid.uuid4().hex[:12]}@example.test"}

    def ok(self, resp, status=(200, 201, 202)):
        assert resp.status_code in ((status,) if isinstance(status, int) else status), \
            f"{resp.status_code}: {resp.text}"
        return resp.json()

    def org(self, who: dict) -> str:
        return self.ok(self.c.post("/v1/orgs", json={"name": "Test org"}, headers=who))["id"]

    def webhook(self, event: dict, *, secret: str | None = None, ts: int | None = None):
        body = json.dumps(event).encode()
        sig = payments.sign(secret or self.settings.payment_webhook_secret, body, ts)
        return self.c.post("/v1/webhooks/payments/dev", content=body,
                           headers={"veyra-signature": sig, "content-type": "application/json"})

    def topup(self, who: dict, org: str, usd: str = "10.00") -> dict:
        pay = self.ok(self.c.post(f"/v1/orgs/{org}/billing/topups", json={"amount_usd": usd},
                                  headers=who))
        self.ok(self.webhook({"id": f"evt_{uuid.uuid4().hex}", "type": "payment.succeeded",
                              "data": {"provider_ref": pay["provider_ref"],
                                       "amount_nano": pay["amount_nano"]}}))
        return pay

    def balance(self, who: dict, org: str) -> dict:
        return self.ok(self.c.get(f"/v1/orgs/{org}/billing/balance", headers=who))

    def project(self, who: dict, org: str, source: str | None = None) -> dict:
        body = {"name": f"p-{uuid.uuid4().hex[:8]}"}
        if source is not None:
            body |= {"files": {"strategy.py": source}, "template": None}
        return self.ok(self.c.post(f"/v1/orgs/{org}/projects", json=body, headers=who))

    def quote(self, who: dict, version_id: str, **kw) -> dict:
        body = {"project_version_id": version_id, "dataset_id": "synth-btcusd-1d-v1",
                "start": "2021-01-01", "end": "2023-01-01", "params": {"fast": 10, "slow": 40},
                "max_runtime_seconds": 60} | kw
        return self.ok(self.c.post("/v1/quotes", json=body, headers=who))

    def authorize(self, who: dict, quote: dict) -> dict:
        return self.ok(self.c.post(f"/v1/quotes/{quote['id']}/authorize",
                                   json={"accept_max_nano": quote["customer_max_nano"]},
                                   headers=who))

    def job(self, who: dict, auth_id: str, key: str | None = None) -> dict:
        return self.ok(self.c.post("/v1/jobs", json={"authorization_id": auth_id},
                                   headers=who | {"idempotency-key": key or uuid.uuid4().hex}))

    def get_job(self, who: dict, job_id: str) -> dict:
        return self.ok(self.c.get(f"/v1/jobs/{job_id}", headers=who))

    def funded_job(self, who: dict | None = None, source: str | None = None, **quote_kw):
        who = who or self.user()
        org = self.org(who)
        self.topup(who, org)
        proj = self.project(who, org, source)
        quote = self.quote(who, proj["latest_version"]["id"], **quote_kw)
        auth = self.authorize(who, quote)
        job = self.job(who, auth["id"])
        return who, org, quote, job


def wait_for(predicate, timeout=30.0, interval=0.1):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError("condition not met in time")


SLOW_STRATEGY = """
import time
from veyra_sdk import Strategy

class Slow(Strategy):
    def on_bar(self, bar, ctx):
        time.sleep(0.05)
"""
