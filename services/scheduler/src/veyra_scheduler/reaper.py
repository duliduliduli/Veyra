"""Settles jobs whose worker stopped heartbeating (crash, partition, OOM).

Bumping the fence token first means a zombie worker that wakes up later can no longer
write results or charges (spec §10.2, §12.1).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from veyra_api.db import Database
from veyra_api.reservations import AUTHORIZATION_CLAIM_WINDOW, release_expired_unused
from veyra_api.settlement import (
    SettlementIntegrityError,
    _approved_rates,
    record_compute_usage,
    settle_job,
)

log = logging.getLogger("veyra.reaper")


@dataclass
class ReapCursor:
    """Process-local scan position; reuse separately for each recovery path."""

    after: tuple[datetime, UUID] | None = None


def reap_expired(database: Database, *, batch_size: int = 100,
                 cursor: ReapCursor | None = None) -> list[str]:
    """Visit at most one bounded batch, rolling back each integrity hold independently."""
    if type(batch_size) is not int or not 1 <= batch_size <= 100:
        raise ValueError("batch_size must be an integer between 1 and 100")
    cursor = cursor if cursor is not None else ReapCursor()
    reaped = []
    visited = []
    for _ in range(batch_size):
        job = None
        try:
            with database.tx() as conn:
                after = "AND (j.created_at, j.id) > (%s, %s) " if cursor.after else ""
                job = conn.execute(
                    "SELECT j.*, a.id AS attempt_id "
                    "FROM jobs j JOIN job_attempts a ON a.job_id = j.id "
                    "AND a.fence_token = j.fence_token WHERE j.state = 'running' "
                    "AND a.ended_at IS NULL AND a.lease_expires_at < now() "
                    "AND NOT (j.id = ANY(%s::uuid[])) " + after +
                    "ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED",
                    (visited, *(cursor.after or ()))).fetchone()
                if job is not None:
                    visited = [*visited, job["id"]]
                    # Refresh the non-locking join after owning the authoritative job lock.
                    attempt = conn.execute(
                        "SELECT id, started_at, heartbeat_at FROM job_attempts "
                        "WHERE id = %s AND job_id = %s AND fence_token = %s "
                        "AND ended_at IS NULL AND lease_expires_at < now()",
                        (job["attempt_id"], job["id"], job["fence_token"])).fetchone()
                    if attempt is not None:
                        auth = conn.execute("SELECT * FROM authorizations WHERE id = %s FOR UPDATE",
                                            (job["authorization_id"],)).fetchone()
                        rates = _approved_rates(conn, job, auth)
                        cfg = job["config"]
                        conn.execute("UPDATE jobs SET fence_token = fence_token + 1 WHERE id = %s",
                                     (job["id"],))
                        # Bill only heartbeat-proven time; the unproven gap is platform-borne.
                        proven = (attempt["heartbeat_at"] - attempt["started_at"]).total_seconds()
                        billed = math.ceil(proven) + rates.startup_overhead_seconds
                        conn.execute(
                            "UPDATE job_attempts SET ended_at = now(), "
                            "end_reason = 'lease_expired', billed_seconds = %s WHERE id = %s",
                            (billed, job["attempt_id"]))
                        record_compute_usage(conn, org_id=job["org_id"], job_id=job["id"],
                                             attempt_id=job["attempt_id"],
                                             resource_class=cfg["resource_class"],
                                             rate_version=cfg["rate_version"],
                                             billed_seconds=billed,
                                             detail={"basis": "heartbeat-proven", "reaped": True})
                        settle_job(conn, job["id"], "failed",
                                   error="worker stopped responding; run did not complete")
        except SettlementIntegrityError as exc:
            if job is None:
                raise
            cursor.after = (job["created_at"], job["id"])
            log.error("reap_expired held job %s (%s); operator review required",
                      job["id"], type(exc).__name__)
            continue
        if job is None:
            cursor.after = None
            break
        cursor.after = (job["created_at"], job["id"])
        if attempt is not None:
            reaped.append(str(job["id"]))
            log.warning("reaped job %s", job["id"])
    return reaped


def reap_unused_authorizations(database: Database, *, batch_size: int = 100,
                               cursor: ReapCursor | None = None) -> list[str]:
    """Release at most 100 unused expired reservations; never lock a job row.

    One authorization per transaction avoids cross-org ledger lock cycles between
    concurrent batches. Visit a held authorization only once per pass.
    """
    if type(batch_size) is not int or not 1 <= batch_size <= 100:
        raise ValueError("batch_size must be an integer between 1 and 100")
    cursor = cursor if cursor is not None else ReapCursor()
    released = []
    visited = []
    for _ in range(batch_size):
        auth = None
        try:
            with database.tx() as conn:
                after = "AND (a.created_at, a.id) > (%s, %s) " if cursor.after else ""
                auth = conn.execute(
                    "SELECT a.* FROM authorizations a WHERE a.status = 'reserved' "
                    "AND a.created_at <= clock_timestamp() - %s "
                    "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.authorization_id = a.id) "
                    "AND NOT (a.id = ANY(%s::uuid[])) " + after +
                    "ORDER BY a.created_at, a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED",
                    (AUTHORIZATION_CLAIM_WINDOW, visited, *(cursor.after or ()))).fetchone()
                if auth is None:
                    cursor.after = None
                    break
                visited = [*visited, auth["id"]]
                did_release = release_expired_unused(conn, auth)
        except SettlementIntegrityError as exc:
            if auth is None:
                raise
            cursor.after = (auth["created_at"], auth["id"])
            log.error("reap_unused_authorizations held authorization %s (%s); "
                      "operator review required", auth["id"], type(exc).__name__)
            continue
        cursor.after = (auth["created_at"], auth["id"])
        if did_release:
            released.append(str(auth["id"]))
    return released
