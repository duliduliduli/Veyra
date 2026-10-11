"""Job settlement - the only path that turns usage into customer charges.

Idempotent: safe to call from the worker, the reaper and cancellation concurrently;
the job row lock plus ``settled_at`` and the ledger idempotency key ensure exactly one
settlement per authorization.
"""

from __future__ import annotations

import json
from decimal import Decimal
from uuid import UUID

from veyra_api import ledger
from veyra_billing import RATE_CARD_V1, compute_cost_nano, settle_amounts

RATE_CARDS = {RATE_CARD_V1.version: RATE_CARD_V1}


def record_compute_usage(conn, *, org_id: UUID, job_id: UUID, attempt_id: UUID,
                         resource_class: str, rate_version: str, billed_seconds: int,
                         detail: dict) -> None:
    """One usage event per attempt; replays are ignored (unique supplier_event_key)."""
    rates = RATE_CARDS[rate_version]
    rc = rates.resource_class(resource_class)
    cost = compute_cost_nano(rates, resource_class, billed_seconds) if billed_seconds > 0 else 0
    conn.execute(
        "INSERT INTO usage_events(org_id, job_id, supplier_event_key, supplier, meter, units, "
        "unit, supplier_cost_nano, rate_version, detail) VALUES "
        "(%s,%s,%s,%s,'compute',%s,'task-second',%s,%s,%s) "
        "ON CONFLICT (supplier_event_key) DO NOTHING",
        (org_id, job_id, f"attempt:{attempt_id}:compute", rates.supplier, billed_seconds, cost,
         rate_version, json.dumps(detail | {"vcpus": str(rc.vcpus),
                                            "memory_gb": str(rc.memory_gb)})))


def settle_job(conn, job_id: UUID, outcome: str, *, error: str | None = None) -> dict | None:
    """Settle a job inside the caller's transaction. Returns the receipt, or None if the
    job was already settled."""
    job = conn.execute("SELECT * FROM jobs WHERE id = %s FOR UPDATE", (job_id,)).fetchone()
    if job is None:
        raise LookupError(job_id)
    if job["state"] == "settled":
        return None
    auth = conn.execute("SELECT * FROM authorizations WHERE id = %s FOR UPDATE",
                        (job["authorization_id"],)).fetchone()
    rate_version = job["config"]["rate_version"]
    rates = RATE_CARDS[rate_version]
    usage = conn.execute("SELECT * FROM usage_events WHERE job_id = %s ORDER BY id",
                         (job_id,)).fetchall()
    supplier = sum(u["supplier_cost_nano"] for u in usage)
    s = settle_amounts(rates, supplier, auth["reserved_nano"])
    ledger.settle(conn, job["org_id"], auth["id"], charge=s.customer_charge_nano,
                  supplier=s.supplier_cost_nano, fee=s.fee_revenue_nano,
                  overrun=s.overrun_absorbed_nano, release=s.release_nano)
    conn.execute("UPDATE authorizations SET status = 'settled', settled_at = now() "
                 "WHERE id = %s", (auth["id"],))
    receipt = {
        "currency": "USD",
        "rate_version": rate_version,
        "rate_source": rates.source,
        "platform_fee_bps": rates.platform_fee_bps,
        "authorized_max_nano": auth["reserved_nano"],
        "supplier_cost_nano": s.supplier_cost_nano,
        "platform_fee_nano": s.fee_revenue_nano,
        "customer_charge_nano": s.customer_charge_nano,
        "absorbed_by_platform_nano": s.overrun_absorbed_nano,
        "released_nano": s.release_nano,
        "tax_nano": None,  # tax treatment not yet decided (spec §25) - shown as unavailable
        "lines": [{"supplier": u["supplier"], "meter": u["meter"], "units": str(u["units"]),
                   "unit": u["unit"], "supplier_cost_nano": u["supplier_cost_nano"],
                   "detail": u["detail"]} for u in usage],
        "charge_usd": str(Decimal(s.customer_charge_nano) / 10**9),
    }
    conn.execute("UPDATE jobs SET state = 'settled', outcome = %s, error = COALESCE(%s, error), "
                 "receipt = %s, settled_at = now(), updated_at = now(), version = version + 1 "
                 "WHERE id = %s", (outcome, error, json.dumps(receipt), job_id))
    conn.execute("INSERT INTO outbox(event_type, org_id, resource_id, resource_version, "
                 "correlation_id, payload) VALUES ('job.settled', %s, %s, %s, %s, %s)",
                 (job["org_id"], job_id, job["version"] + 1, str(auth["quote_id"]),
                  json.dumps({"outcome": outcome,
                              "customer_charge_nano": s.customer_charge_nano})))
    return receipt
