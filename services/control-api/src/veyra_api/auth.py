"""Authentication and server-side authorization (spec §2).

Identity is pluggable: local/test environments accept a developer header; production
must verify the identity provider's session JWT (Clerk) - deliberately not stubbed open.
Authorization never trusts tenant IDs from the client: every resource is loaded, then
the caller's membership in *that resource's* org is checked.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, Request

ROLES_ALL = frozenset({"owner", "researcher", "billing_admin", "viewer"})
CAN_RESEARCH = frozenset({"owner", "researcher"})  # code, quotes, job authorization
CAN_BILL = frozenset({"owner", "billing_admin"})  # top-ups, payment methods
CAN_SEE_BILLING = frozenset({"owner", "billing_admin", "researcher"})
CAN_ADMIN = frozenset({"owner"})


@dataclass(frozen=True)
class Principal:
    user_id: UUID
    subject: str


def authenticate(request: Request) -> Principal:
    settings = request.app.state.settings
    db = request.app.state.db
    subject = None
    if settings.dev_auth_enabled:
        subject = request.headers.get("x-veyra-dev-user")
    if not subject:
        # Production: verify identity-provider JWT here (issuer, audience, expiry, MFA claim).
        raise HTTPException(401, "authentication required")
    subject = subject.strip().lower()
    if not (3 <= len(subject) <= 254):
        raise HTTPException(401, "invalid subject")
    with db.tx() as conn:
        row = conn.execute(
            "INSERT INTO users(auth_subject, email) VALUES (%s, %s) "
            "ON CONFLICT (auth_subject) DO UPDATE SET auth_subject = EXCLUDED.auth_subject "
            "RETURNING id", (subject, subject if "@" in subject else None)).fetchone()
    return Principal(row["id"], subject)


def role_in(conn, principal: Principal, org_id: UUID) -> str | None:
    row = conn.execute("SELECT role FROM memberships WHERE org_id = %s AND user_id = %s",
                       (org_id, principal.user_id)).fetchone()
    return row["role"] if row else None


def require(conn, principal: Principal, org_id: UUID, allowed: frozenset[str]) -> str:
    role = role_in(conn, principal, org_id)
    if role is None:
        # Indistinguishable from "does not exist" to avoid cross-tenant enumeration.
        raise HTTPException(404, "not found")
    if role not in allowed:
        raise HTTPException(403, f"role {role!r} cannot perform this action")
    return role


def audit(conn, principal: Principal | None, org_id, action: str, resource: str,
          detail: dict | None = None) -> None:
    import json

    conn.execute("INSERT INTO audit_events(org_id, actor_id, action, resource, detail) "
                 "VALUES (%s, %s, %s, %s, %s)",
                 (org_id, principal.user_id if principal else None, action, resource,
                  json.dumps(detail or {})))
