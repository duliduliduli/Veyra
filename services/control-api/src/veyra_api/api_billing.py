import json
import secrets
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from veyra_api import ledger, payments
from veyra_api.auth import CAN_BILL, CAN_SEE_BILLING, Principal, audit, require
from veyra_api.deps import CurrentUser, db, settings
from veyra_billing import format_usd, to_nano

router = APIRouter(prefix="/v1")


class TopupIn(BaseModel):
    # Proposed bounds; minimum top-up is an open pricing decision (spec §31).
    amount_usd: Decimal = Field(ge=Decimal("5"), le=Decimal("1000"), decimal_places=2)


@router.get("/orgs/{org_id}/billing/balance")
def balance(org_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        require(conn, p, org_id, CAN_SEE_BILLING)
        b = ledger.balances(conn, org_id)
    return b | {"currency": "USD", "display": {k.removesuffix("_nano"): format_usd(v, 4)
                                                for k, v in b.items()}}


@router.get("/orgs/{org_id}/billing/usage")
def usage(org_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        require(conn, p, org_id, CAN_SEE_BILLING)
        events = conn.execute(
            "SELECT job_id, supplier, meter, units, unit, supplier_cost_nano, rate_version, "
            "detail, created_at FROM usage_events WHERE org_id = %s ORDER BY id DESC LIMIT 200",
            (org_id,)).fetchall()
        entries = conn.execute(
            "SELECT id, kind, reference, created_at FROM journal_entries WHERE org_id = %s "
            "ORDER BY id DESC LIMIT 200", (org_id,)).fetchall()
    return {"usage_events": events, "journal_entries": entries}


@router.post("/orgs/{org_id}/billing/topups", status_code=201)
def create_topup(org_id: UUID, body: TopupIn, p: Principal = CurrentUser,
                 database=Depends(db)):
    with database.tx() as conn:
        require(conn, p, org_id, CAN_BILL)
        row = conn.execute(
            "INSERT INTO payments(org_id, provider, provider_ref, amount_nano, status, created_by) "
            "VALUES (%s, 'dev', %s, %s, 'pending', %s) RETURNING id, provider, provider_ref, "
            "amount_nano, status", (org_id, "devpay_" + secrets.token_hex(12),
                                    to_nano(body.amount_usd), p.user_id)).fetchone()
        audit(conn, p, org_id, "billing.topup.create", f"payment:{row['id']}")
    return row | {"note": "No credit is added until the provider's signed webhook confirms."}


@router.post("/webhooks/payments/dev", status_code=200)
async def payment_webhook(request: Request, database=Depends(db), cfg=Depends(settings),
                          veyra_signature: str | None = Header(default=None)):
    raw = await request.body()
    try:
        payments.verify(cfg.payment_webhook_secret, raw, veyra_signature)
    except payments.BadSignature as e:
        raise HTTPException(400, str(e)) from None
    event = json.loads(raw)
    event_id, kind = str(event["id"]), event["type"]
    ref, amount = event["data"]["provider_ref"], int(event["data"]["amount_nano"])
    with database.tx() as conn:
        fresh = conn.execute("INSERT INTO inbox_dedup(provider, event_id) VALUES ('dev', %s) "
                             "ON CONFLICT DO NOTHING RETURNING event_id", (event_id,)).fetchone()
        if not fresh:
            return {"status": "duplicate"}
        pay = conn.execute("SELECT * FROM payments WHERE provider = 'dev' AND provider_ref = %s "
                           "FOR UPDATE", (ref,)).fetchone()
        if pay is None:
            return {"status": "unknown_payment"}  # recorded; reconciliation will flag it
        if pay["status"] != "pending":
            return {"status": f"already_{pay['status']}"}
        if kind == "payment.succeeded":
            if amount != pay["amount_nano"]:
                raise HTTPException(409, "amount mismatch")
            conn.execute("UPDATE payments SET status = 'succeeded', confirmed_at = now() "
                         "WHERE id = %s", (pay["id"],))
            ledger.credit_topup(conn, pay["org_id"], pay["amount_nano"], pay["id"])
        elif kind == "payment.failed":
            conn.execute("UPDATE payments SET status = 'failed' WHERE id = %s", (pay["id"],))
        audit(conn, None, pay["org_id"], f"billing.{kind}", f"payment:{pay['id']}")
    return {"status": "processed"}
