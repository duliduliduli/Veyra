"""Spec §23 Identity/RBAC: every private object denies other tenants and wrong roles."""

from conftest import Api


def test_other_tenant_cannot_see_or_touch_anything(api: Api, worker):
    alice, org, quote, job = api.funded_job()
    worker.run_once(job["id"])
    report_id = api.get_job(alice, job["id"])["report_id"]
    version_id = job["project_version_id"]
    mallory = api.user()
    api.org(mallory)  # has an org of her own

    for method, path in [
        ("get", f"/v1/jobs/{job['id']}"),
        ("post", f"/v1/jobs/{job['id']}/cancel"),
        ("get", f"/v1/reports/{report_id}"),
        ("get", f"/v1/reports/{report_id}/artifacts/report.json"),
        ("get", f"/v1/orgs/{org}/billing/balance"),
        ("get", f"/v1/orgs/{org}/billing/usage"),
        ("post", f"/v1/orgs/{org}/billing/topups"),
        ("post", f"/v1/orgs/{org}/members"),
    ]:
        kwargs = {"json": {"amount_usd": "10", "subject": "x@y.z", "role": "owner"}} \
            if method == "post" else {}
        r = getattr(api.c, method)(path, headers=mallory, **kwargs)
        assert r.status_code == 404, (path, r.status_code, r.text)

    # Using someone else's code version or quote is also refused.
    r = api.c.post("/v1/quotes", headers=mallory, json={
        "project_version_id": version_id, "dataset_id": "synth-btcusd-1d-v1",
        "start": "2021-01-01", "end": "2022-01-01"})
    assert r.status_code == 404
    r = api.c.post(f"/v1/quotes/{quote['id']}/authorize", headers=mallory,
                   json={"accept_max_nano": quote["customer_max_nano"]})
    assert r.status_code == 404


def test_unauthenticated_requests_are_rejected(api: Api):
    assert api.c.get("/v1/me").status_code == 401


def test_roles_are_enforced(api: Api):
    owner = api.user()
    org = api.org(owner)
    viewer, billing, researcher = api.user(), api.user(), api.user()
    for who, role in ((viewer, "viewer"), (billing, "billing_admin"),
                      (researcher, "researcher")):
        api.ok(api.c.post(f"/v1/orgs/{org}/members", headers=owner,
                          json={"subject": who["x-veyra-dev-user"], "role": role}))
    api.topup(owner, org)
    proj = api.project(researcher, org)  # researchers write code
    quote = api.quote(researcher, proj["latest_version"]["id"])

    # viewers cannot spend; billing admins cannot write code; researchers cannot top up
    r = api.c.post(f"/v1/quotes/{quote['id']}/authorize", headers=viewer,
                   json={"accept_max_nano": quote["customer_max_nano"]})
    assert r.status_code == 403
    assert api.c.post(f"/v1/orgs/{org}/projects", headers=billing,
                      json={"name": "x"}).status_code == 403
    assert api.c.post(f"/v1/orgs/{org}/billing/topups", headers=researcher,
                      json={"amount_usd": "10"}).status_code == 403
    assert api.c.get(f"/v1/orgs/{org}/billing/balance", headers=viewer).status_code == 403
    # but billing admins can fund and see the balance
    api.topup(billing, org)
    assert api.balance(billing, org)["available_nano"] == 20 * 10**9
