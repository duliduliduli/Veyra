"""Spec §23 Payment events: duplicate, replayed, forged and stale webhooks settle once."""

import time
import uuid

from conftest import Api


def _pending(api: Api):
    who = api.user()
    org = api.org(who)
    pay = api.ok(api.c.post(f"/v1/orgs/{org}/billing/topups", json={"amount_usd": "25.00"},
                            headers=who))
    return who, org, pay


def _evt(pay, kind="payment.succeeded", amount=None, event_id=None):
    return {"id": event_id or f"evt_{uuid.uuid4().hex}", "type": kind,
            "data": {"provider_ref": pay["provider_ref"],
                     "amount_nano": pay["amount_nano"] if amount is None else amount}}


def test_no_credit_until_confirmed(api: Api):
    who, org, _ = _pending(api)
    assert api.balance(who, org)["available_nano"] == 0


def test_forged_and_stale_signatures_are_rejected(api: Api):
    who, org, pay = _pending(api)
    assert api.webhook(_evt(pay), secret="wrong").status_code == 400
    assert api.webhook(_evt(pay), ts=int(time.time()) - 3600).status_code == 400
    r = api.c.post("/v1/webhooks/payments/dev", json=_evt(pay))
    assert r.status_code == 400
    assert api.balance(who, org)["available_nano"] == 0


def test_duplicate_and_replayed_events_credit_once(api: Api):
    who, org, pay = _pending(api)
    event = _evt(pay)
    assert api.ok(api.webhook(event))["status"] == "processed"
    assert api.ok(api.webhook(event))["status"] == "duplicate"
    # a different event id for the same payment also cannot double-credit
    assert api.ok(api.webhook(_evt(pay)))["status"] == "already_succeeded"
    assert api.balance(who, org)["available_nano"] == 25 * 10**9


def test_amount_mismatch_is_refused(api: Api):
    who, org, pay = _pending(api)
    assert api.webhook(_evt(pay, amount=pay["amount_nano"] * 2)).status_code == 409
    assert api.balance(who, org)["available_nano"] == 0


def test_failed_payment_does_not_credit(api: Api):
    who, org, pay = _pending(api)
    api.ok(api.webhook(_evt(pay, kind="payment.failed")))
    assert api.ok(api.webhook(_evt(pay)))["status"] == "already_failed"
    assert api.balance(who, org)["available_nano"] == 0


def test_dev_checkout_credits_once_and_needs_billing_role(api: Api):
    who, org, pay = _pending(api)
    stranger = api.user()
    assert api.c.post(f"/v1/dev/payments/{pay['id']}/complete",
                      headers=stranger).status_code == 404
    api.ok(api.c.post(f"/v1/dev/payments/{pay['id']}/complete", headers=who))
    again = api.ok(api.c.post(f"/v1/dev/payments/{pay['id']}/complete", headers=who))
    assert again["status"] == "duplicate"
    assert api.balance(who, org)["available_nano"] == 25 * 10**9


def test_dev_checkout_does_not_exist_outside_local_and_test(settings):
    from dataclasses import replace

    from veyra_api.app import create_app

    prod = create_app(replace(settings, app_env="production"))
    paths = {getattr(r, "path", "") for r in prod.routes}
    assert not any(p.startswith("/v1/dev") for p in paths)
