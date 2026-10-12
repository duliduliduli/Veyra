"""A reservation must be claimed once within 15 minutes of authorization.

Claimed reservations belong to the job until its normal settlement, regardless of
age or job state. Callers must hold the authorization row lock in their transaction.
"""

from datetime import timedelta

from veyra_api import ledger
from veyra_api.settlement import require_consistent_authorization

AUTHORIZATION_CLAIM_WINDOW = timedelta(minutes=15)


def claim_expires_at(auth: dict):
    return auth["created_at"] + AUTHORIZATION_CLAIM_WINDOW


def release_expired_unused(conn, auth: dict) -> bool:
    """Close an expired, unclaimed reservation under its authorization row lock.

    The separate job query must run AFTER acquiring that lock: a NOT EXISTS in a
    locking candidate query alone can see a stale READ COMMITTED snapshot.
    """
    if auth["status"] != "reserved":
        return False
    if conn.execute("SELECT 1 FROM jobs WHERE authorization_id = %s",
                    (auth["id"],)).fetchone():
        return False
    expired = conn.execute("SELECT clock_timestamp() >= %s AS expired",
                           (claim_expires_at(auth),)).fetchone()["expired"]
    if not expired:
        return False
    require_consistent_authorization(conn, auth)
    ledger.settle(conn, auth["org_id"], auth["id"], charge=0, supplier=0, fee=0,
                  overrun=0, release=auth["reserved_nano"])
    conn.execute("UPDATE authorizations SET status = 'settled', settled_at = now() "
                 "WHERE id = %s", (auth["id"],))
    return True
