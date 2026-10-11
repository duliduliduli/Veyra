"""Settles jobs whose worker stopped heartbeating (crash, partition, OOM).

Bumping the fence token first means a zombie worker that wakes up later can no longer
write results or charges (spec §10.2, §12.1).
"""

from __future__ import annotations

import logging
import math

from veyra_api.db import Database
from veyra_api.settlement import RATE_CARDS, record_compute_usage, settle_job

log = logging.getLogger("veyra.reaper")


def reap_expired(database: Database) -> list[str]:
    reaped = []
    with database.tx() as conn:
        rows = conn.execute(
            "SELECT j.id AS job_id, j.org_id, j.config, a.id AS attempt_id, a.started_at, "
            "a.heartbeat_at FROM jobs j JOIN job_attempts a ON a.job_id = j.id "
            "AND a.fence_token = j.fence_token WHERE j.state = 'running' "
            "AND a.ended_at IS NULL AND a.lease_expires_at < now() "
            "FOR UPDATE OF j SKIP LOCKED").fetchall()
        for r in rows:
            cfg = r["config"]
            rates = RATE_CARDS[cfg["rate_version"]]
            conn.execute("UPDATE jobs SET fence_token = fence_token + 1 WHERE id = %s",
                         (r["job_id"],))
            # Bill only what heartbeats prove ran; the gap after the last heartbeat is
            # platform-borne until supplier usage reconciliation says otherwise.
            proven = (r["heartbeat_at"] - r["started_at"]).total_seconds()
            billed = math.ceil(proven) + rates.startup_overhead_seconds
            conn.execute("UPDATE job_attempts SET ended_at = now(), end_reason = 'lease_expired', "
                         "billed_seconds = %s WHERE id = %s", (billed, r["attempt_id"]))
            record_compute_usage(conn, org_id=r["org_id"], job_id=r["job_id"],
                                 attempt_id=r["attempt_id"], resource_class=cfg["resource_class"],
                                 rate_version=cfg["rate_version"], billed_seconds=billed,
                                 detail={"basis": "heartbeat-proven", "reaped": True})
            settle_job(conn, r["job_id"], "failed",
                       error="worker stopped responding; run did not complete")
            reaped.append(str(r["job_id"]))
            log.warning("reaped job %s", r["job_id"])
    return reaped
