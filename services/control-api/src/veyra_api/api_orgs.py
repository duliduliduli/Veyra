from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from veyra_api import ledger
from veyra_api.auth import CAN_ADMIN, Principal, audit, require
from veyra_api.deps import CurrentUser, db

router = APIRouter(prefix="/v1")


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MemberIn(BaseModel):
    subject: str = Field(min_length=3, max_length=254)
    role: Literal["owner", "researcher", "billing_admin", "viewer"]


@router.get("/me")
def me(p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        orgs = conn.execute(
            "SELECT o.id, o.name, m.role FROM memberships m "
            "JOIN organizations o ON o.id = m.org_id "
            "WHERE m.user_id = %s ORDER BY o.created_at", (p.user_id,)).fetchall()
    return {"user_id": p.user_id, "subject": p.subject, "organizations": orgs}


@router.post("/orgs", status_code=201)
def create_org(body: OrgIn, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        org = conn.execute("INSERT INTO organizations(name) VALUES (%s) RETURNING id, name",
                           (body.name,)).fetchone()
        conn.execute("INSERT INTO memberships(org_id, user_id, role) VALUES (%s, %s, 'owner')",
                     (org["id"], p.user_id))
        ledger.ensure_org_accounts(conn, org["id"])
        audit(conn, p, org["id"], "org.create", f"org:{org['id']}")
    return org


@router.post("/orgs/{org_id}/members", status_code=201)
def add_member(org_id: UUID, body: MemberIn, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        require(conn, p, org_id, CAN_ADMIN)
        subject = body.subject.strip().lower()
        user = conn.execute(
            "INSERT INTO users(auth_subject, email) VALUES (%s, %s) ON CONFLICT (auth_subject) "
            "DO UPDATE SET auth_subject = EXCLUDED.auth_subject RETURNING id",
            (subject, subject if "@" in subject else None)).fetchone()
        if user["id"] == p.user_id:
            raise HTTPException(400, "cannot change your own role")
        conn.execute("INSERT INTO memberships(org_id, user_id, role) VALUES (%s, %s, %s) "
                     "ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role",
                     (org_id, user["id"], body.role))
        audit(conn, p, org_id, "member.upsert", f"user:{user['id']}", {"role": body.role})
    return {"user_id": user["id"], "role": body.role}
