import base64
import binascii
import hashlib
import json
import math
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator
from veyra_api import ledger
from veyra_api.auth import CAN_RESEARCH, ROLES_ALL, Principal, audit, require
from veyra_api.deps import CurrentUser, db, settings, store
from veyra_api.reservations import claim_expires_at, release_expired_unused
from veyra_api.settlement import settle_job
from veyra_billing import RATE_CARD_V1, format_usd, quote_compute, to_nano
from veyra_sim import ENGINE_NAME, ENGINE_VERSION, data
from veyra_sim.report import digest

router = APIRouter(prefix="/v1")

# Unprofiled heuristic until W38 measures real runtimes; shown to the customer as such.
EST_STARTUP_S = 3
EST_SECONDS_PER_BAR = Decimal("0.002")


class QuoteIn(BaseModel):
    project_version_id: UUID
    dataset_id: str
    start: date
    end: date
    starting_cash: Decimal = Field(default=Decimal("10000"), gt=0, le=Decimal("1e12"))
    params: dict = Field(default_factory=dict)
    resource_class: Literal["small", "standard", "large"] = "small"
    max_runtime_seconds: int = Field(default=300, ge=10)
    taker_fee_bps: Decimal = Field(default=Decimal("10"), ge=0, le=1000)
    slippage_bps: Decimal = Field(default=Decimal("5"), ge=0, le=1000)

    @field_validator("params", mode="before")
    @classmethod
    def small_params(cls, v):
        # Safe details avoid echoing invalid floats/Unicode in FastAPI's error JSON.
        def reject(detail):
            raise HTTPException(422, detail)

        def string(value):
            if "\x00" in value or any(0xD800 <= ord(char) <= 0xDFFF for char in value):
                reject("parameter names and strings must contain valid Unicode without NUL")

        def visit(value, depth):
            kind = type(value)
            if kind in (dict, list):
                if depth > 16:
                    reject("params must nest at most 16 objects or arrays, including the root")
                if kind is dict:
                    for key, child in value.items():
                        if type(key) is not str:
                            reject("parameter names must be strings")
                        string(key)
                        visit(child, depth + 1)
                else:
                    for child in value:
                        visit(child, depth + 1)
            elif kind is str:
                string(value)
            elif kind in (int, float):
                if kind is float and not math.isfinite(value):
                    reject("parameter numbers must be finite")
                if (kind is int or value.is_integer()) and abs(value) > 9007199254740991:
                    reject("parameter integers must be within ±9007199254740991; "
                           "use strings for exact larger values")
            elif value is not None and kind is not bool:
                reject("params must contain only JSON values")

        if type(v) is not dict:
            reject("params must be a JSON object")
        visit(v, 1)
        encoded = json.dumps(v, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > 8192:
            reject("params must serialize to at most 8 KiB of UTF-8 JSON")
        return v


class AuthorizeIn(BaseModel):
    # Explicit consent: the client must echo the exact ceiling it showed the user.
    accept_max_nano: int


class JobIn(BaseModel):
    authorization_id: UUID


def _usd(n: int) -> str:
    return format_usd(n, 4)


@router.post("/quotes", status_code=201)
def create_quote(body: QuoteIn, p: Principal = CurrentUser, database=Depends(db),
                 cfg=Depends(settings)):
    if body.start >= body.end:
        raise HTTPException(422, "start must be before end")
    if body.dataset_id not in data.CATALOG:
        raise HTTPException(422, "unknown dataset")
    if body.max_runtime_seconds > cfg.max_job_runtime_seconds:
        raise HTTPException(422, f"max_runtime_seconds above {cfg.max_job_runtime_seconds}")
    bars = data.load(body.dataset_id, body.start.isoformat(), body.end.isoformat())
    if not bars:
        raise HTTPException(422, "no data in the selected range")
    est = EST_STARTUP_S + int(EST_SECONDS_PER_BAR * len(bars)) + 1
    q = quote_compute(RATE_CARD_V1, body.resource_class, est, body.max_runtime_seconds)
    if q.customer_max_nano > to_nano(cfg.max_job_customer_usd):
        raise HTTPException(422, f"ceiling {_usd(q.customer_max_nano)} exceeds per-job limit "
                                 f"${cfg.max_job_customer_usd}; lower max_runtime_seconds")
    with database.tx() as conn:
        pv = conn.execute("SELECT * FROM project_versions WHERE id = %s",
                          (body.project_version_id,)).fetchone()
        if pv is None:
            raise HTTPException(404, "not found")
        require(conn, p, pv["org_id"], CAN_RESEARCH)
        request = json.loads(body.model_dump_json())
        inputs = {
            "code": pv["content_hash"], "data": data.manifest_hash(bars),
            "engine": f"{ENGINE_NAME}=={ENGINE_VERSION}", "rates": RATE_CARD_V1.version,
            "request": request,
        }
        estimate = q.as_dict() | {
            "bars": len(bars), "method": "unprofiled heuristic (startup + per-bar)",
            "data_cost_nano": 0, "data_note": "synthetic dataset; no acquisition cost",
            "display": {"expected": _usd(q.customer_expected_nano),
                        "maximum": _usd(q.customer_max_nano)},
            "tax": "not yet calculated",
            "failure_policy": "Charged for compute actually used, never above the maximum. "
                              "Unused reservation is released at settlement.",
        }
        row = conn.execute(
            "INSERT INTO quotes(org_id, project_version_id, request, input_hash, rate_version, "
            "estimate, customer_max_nano, expires_at, created_by) VALUES "
            "(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id, input_hash, customer_max_nano, "
            "expires_at, estimate",
            (pv["org_id"], pv["id"], json.dumps(request), digest(inputs), RATE_CARD_V1.version,
             json.dumps(estimate), q.customer_max_nano,
             datetime.now(UTC) + timedelta(seconds=cfg.quote_ttl_seconds), p.user_id)).fetchone()
    return row | {"inputs": inputs}


@router.post("/quotes/{quote_id}/authorize", status_code=201)
def authorize(quote_id: UUID, body: AuthorizeIn, p: Principal = CurrentUser,
              database=Depends(db)):
    with database.tx() as conn:
        quote = conn.execute("SELECT * FROM quotes WHERE id = %s FOR UPDATE",
                             (quote_id,)).fetchone()
        if quote is None:
            raise HTTPException(404, "not found")
        require(conn, p, quote["org_id"], CAN_RESEARCH)
        existing = conn.execute("SELECT * FROM authorizations WHERE quote_id = %s",
                                (quote_id,)).fetchone()
        if existing:
            return existing | {"claim_expires_at": claim_expires_at(existing)}  # idempotent retry
        if quote["expires_at"] <= datetime.now(UTC):
            raise HTTPException(410, "quote expired; request a new quote")
        if body.accept_max_nano != quote["customer_max_nano"]:
            raise HTTPException(409, "accepted maximum does not match the quote")
        auth = conn.execute(
            "INSERT INTO authorizations(org_id, quote_id, input_hash, reserved_nano, status, "
            "approved_by) VALUES (%s,%s,%s,%s,'reserved',%s) RETURNING *",
            (quote["org_id"], quote_id, quote["input_hash"], quote["customer_max_nano"],
             p.user_id)).fetchone()
        try:
            ledger.reserve(conn, quote["org_id"], quote["customer_max_nano"], auth["id"])
        except ledger.InsufficientFunds:
            raise HTTPException(402, "insufficient service credit for this maximum") from None
        audit(conn, p, quote["org_id"], "quote.authorize", f"authorization:{auth['id']}",
              {"reserved_nano": auth["reserved_nano"], "input_hash": quote["input_hash"]})
    return auth | {"claim_expires_at": claim_expires_at(auth)}


@router.post("/jobs", status_code=201)
def create_job(body: JobIn, response: Response, p: Principal = CurrentUser,
               database=Depends(db), idempotency_key: str = Header(min_length=8, max_length=128)):
    with database.tx() as conn:
        auth = conn.execute("SELECT * FROM authorizations WHERE id = %s FOR UPDATE",
                            (body.authorization_id,)).fetchone()
        if auth is None:
            raise HTTPException(404, "not found")
        require(conn, p, auth["org_id"], CAN_RESEARCH)
        prior = conn.execute("SELECT * FROM jobs WHERE org_id = %s AND idempotency_key = %s",
                             (auth["org_id"], idempotency_key)).fetchone()
        if prior:
            if prior["authorization_id"] != auth["id"]:
                raise HTTPException(409, "idempotency key reused with a different request")
            response.status_code = 200
            return _job_view(conn, prior)
        if conn.execute("SELECT 1 FROM jobs WHERE authorization_id = %s",
                        (auth["id"],)).fetchone():
            raise HTTPException(409, "authorization already used by another job")
        if auth["status"] != "reserved":
            # A closed authorization without a job is an expired, unused reservation.
            raise HTTPException(410, "authorization expired; request a new quote")
        if release_expired_unused(conn, auth):
            # Returning (rather than raising) commits the release before the 410 response.
            response.status_code = 410
            return {"detail": "authorization expired; request a new quote"}
        quote = conn.execute("SELECT * FROM quotes WHERE id = %s", (auth["quote_id"],)).fetchone()
        if quote["input_hash"] != auth["input_hash"]:
            raise HTTPException(409, "authorization does not match quote inputs")
        config = quote["request"] | {
            "quote_id": str(quote["id"]), "input_hash": quote["input_hash"],
            "rate_version": quote["rate_version"],
            "engine": f"{ENGINE_NAME}=={ENGINE_VERSION}",
        }
        job = conn.execute(
            "INSERT INTO jobs(org_id, project_version_id, authorization_id, idempotency_key, "
            "config, state, created_by) VALUES (%s,%s,%s,%s,%s,'queued',%s) RETURNING *",
            (auth["org_id"], quote["project_version_id"], auth["id"], idempotency_key,
             json.dumps(config), p.user_id)).fetchone()
        conn.execute("INSERT INTO outbox(event_type, org_id, resource_id, resource_version, "
                     "correlation_id) VALUES ('job.queued', %s, %s, %s, %s)",
                     (job["org_id"], job["id"], job["version"], str(quote["id"])))
        audit(conn, p, job["org_id"], "job.create", f"job:{job['id']}")
        return _job_view(conn, job)


def _job_view(conn, job: dict) -> dict:
    report = conn.execute("SELECT id FROM reports WHERE job_id = %s", (job["id"],)).fetchone()
    attempts = conn.execute(
        "SELECT attempt_no, worker_id, started_at, heartbeat_at, ended_at, end_reason, "
        "billed_seconds FROM job_attempts WHERE job_id = %s ORDER BY attempt_no",
        (job["id"],)).fetchall()
    auth = conn.execute("SELECT reserved_nano, status FROM authorizations WHERE id = %s",
                        (job["authorization_id"],)).fetchone()
    return {k: job[k] for k in ("id", "org_id", "project_version_id", "authorization_id",
                                "state", "outcome", "version", "cancel_requested", "progress",
                                "error", "config", "receipt", "created_at", "updated_at",
                                "settled_at")} | {
        "budget": {"reserved_nano": auth["reserved_nano"], "status": auth["status"],
                   "maximum": _usd(auth["reserved_nano"])},
        "report_id": report["id"] if report else None, "attempts": attempts}


def _load_job(conn, p, job_id, allowed, lock=False):
    job = conn.execute("SELECT * FROM jobs WHERE id = %s" + (" FOR UPDATE" if lock else ""),
                       (job_id,)).fetchone()
    if job is None:
        raise HTTPException(404, "not found")
    require(conn, p, job["org_id"], allowed)
    return job


def _decode_authorization_cursor(cursor):
    try:
        decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if (not isinstance(decoded, list) or len(decoded) != 2
                or not all(isinstance(value, str) for value in decoded)):
            raise ValueError("cursor must contain timestamp and ID strings")
        stamp, authorization_id = decoded
        stamp = datetime.fromisoformat(stamp)
        authorization_id = UUID(authorization_id)
        if stamp.tzinfo is None:
            raise ValueError("cursor timestamp must include a timezone")
        return stamp.astimezone(UTC), authorization_id
    except (ValueError, TypeError, OverflowError, binascii.Error) as exc:
        raise HTTPException(422, "invalid authorization cursor") from exc


def _authorization_request(request, project_version_id):
    # Preserve saved values, rather than normalizing or replacing approved inputs.
    try:
        if not isinstance(request, dict):
            raise ValueError("invalid saved inputs")
        saved = {key: request[key] for key in QuoteIn.model_fields if key in request}
        if len(saved) != len(QuoteIn.model_fields):
            raise ValueError("incomplete saved inputs")
        QuoteIn.small_params(saved["params"])
        encoded = json.dumps(saved, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > 16384:
            raise ValueError("saved inputs exceed discovery bound")
        validated = QuoteIn.model_validate_json(encoded, strict=True)
        if validated.project_version_id != project_version_id:
            raise ValueError("saved version does not match authorization")
        return saved
    except (ValueError, TypeError, RecursionError, HTTPException) as exc:
        raise HTTPException(503, "authorization inputs unavailable") from exc


@router.get("/orgs/{org_id}/authorizations")
def list_authorizations(org_id: UUID, p: Principal = CurrentUser, database=Depends(db),
                        limit: Annotated[int, Query(ge=1, le=100)] = 50,
                        cursor: Annotated[str | None, Query(max_length=512)] = None,
                        project_id: UUID | None = None):
    with database.tx() as conn:
        require(conn, p, org_id, CAN_RESEARCH)
        conditions = ["a.org_id = %s", "a.approved_by = %s"]
        params = [org_id, p.user_id]
        if project_id is not None:
            conditions.append("v.project_id = %s")
            params.append(project_id)
        if cursor is not None:
            conditions.append("(a.created_at, a.id) < (%s, %s)")
            params.extend(_decode_authorization_cursor(cursor))
        params.append(limit + 1)
        rows = conn.execute(
            "SELECT statement_timestamp() AS as_of, a.id, a.quote_id, v.project_id, "
            "p.name AS project_name, q.input_hash AS quote_input_hash, "
            "q.project_version_id, v.version_no, v.content_hash, a.input_hash, q.request, "
            "a.reserved_nano, a.created_at, a.status, j.id AS job_id, j.state AS job_state "
            "FROM authorizations a JOIN quotes q ON q.id = a.quote_id AND q.org_id = a.org_id "
            "JOIN project_versions v ON v.id = q.project_version_id AND v.org_id = a.org_id "
            "JOIN projects p ON p.id = v.project_id AND p.org_id = a.org_id "
            "LEFT JOIN jobs j ON j.authorization_id = a.id AND j.org_id = a.org_id WHERE "
            + " AND ".join(conditions) + " ORDER BY a.created_at DESC, a.id DESC LIMIT %s",
            params).fetchall()
        as_of = (rows[0]["as_of"] if rows else
                 conn.execute("SELECT clock_timestamp() AS as_of").fetchone()["as_of"])
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps(
            [last["created_at"].isoformat(), str(last["id"])]).encode()).decode()
    for row in rows:
        row.pop("as_of")
        if row.pop("quote_input_hash") != row["input_hash"]:
            raise HTTPException(503, "authorization inputs unavailable")
        row["request"] = _authorization_request(row["request"], row["project_version_id"])
        row["claim_expires_at"] = claim_expires_at(row)
        job_id, job_state = row.pop("job_id"), row.pop("job_state")
        row["job"] = {"id": job_id, "state": job_state} if job_id is not None else None
        if row["job"] is not None:
            row["recovery_state"] = "used"
        elif row["status"] == "settled":
            row["recovery_state"] = "released"
        elif row["claim_expires_at"] <= as_of:
            row["recovery_state"] = "expired_pending_release"
        else:
            row["recovery_state"] = "claimable"
    return {"authorizations": rows, "next_cursor": next_cursor, "has_more": has_more,
            "as_of": as_of}


@router.get("/orgs/{org_id}/jobs")
def list_jobs(org_id: UUID, p: Principal = CurrentUser, database=Depends(db),
              limit: Annotated[int, Query(ge=1, le=100)] = 50,
              cursor: Annotated[str | None, Query(max_length=512)] = None,
              project_id: UUID | None = None):
    with database.tx() as conn:
        require(conn, p, org_id, ROLES_ALL)
        conditions, params = ["j.org_id = %s"], [org_id]
        if project_id is not None:
            conditions.append("v.project_id = %s")
            params.append(project_id)
        if cursor is not None:
            try:
                decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
                if (not isinstance(decoded, list) or len(decoded) != 2
                        or not all(isinstance(value, str) for value in decoded)):
                    raise ValueError("cursor must contain timestamp and ID strings")
                stamp, job_id = decoded
                stamp = datetime.fromisoformat(stamp)
                job_id = UUID(job_id)
                if stamp.tzinfo is None:
                    raise ValueError("cursor timestamp must include a timezone")
                stamp = stamp.astimezone(UTC)
            except (ValueError, TypeError, OverflowError, binascii.Error) as exc:
                raise HTTPException(422, "invalid history cursor") from exc
            conditions.append("(j.created_at, j.id) < (%s, %s)")
            params.extend((stamp, job_id))
        params.append(limit + 1)
        rows = conn.execute(
            "SELECT j.id, j.state, j.outcome, j.progress, j.created_at, j.settled_at, "
            "v.project_id, p.name AS project_name, j.project_version_id, v.version_no, "
            "j.config->>'start' AS \"start\", j.config->>'end' AS \"end\", "
            "j.config->>'dataset_id' AS dataset_id, a.reserved_nano, "
            "(j.receipt->>'customer_charge_nano')::bigint AS charge_nano, "
            "r.id AS report_id, r.metrics "
            "FROM jobs j JOIN authorizations a ON a.id = j.authorization_id "
            "JOIN project_versions v ON v.id = j.project_version_id AND v.org_id = j.org_id "
            "JOIN projects p ON p.id = v.project_id AND p.org_id = j.org_id "
            "LEFT JOIN reports r ON r.job_id = j.id AND r.org_id = j.org_id WHERE "
            + " AND ".join(conditions) + " ORDER BY j.created_at DESC, j.id DESC LIMIT %s",
            params).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        if rows:
            counts = conn.execute(
                "SELECT v.project_id, count(*) AS run_count FROM jobs j "
                "JOIN project_versions v ON v.id = j.project_version_id AND v.org_id = j.org_id "
                "WHERE j.org_id = %s AND v.project_id = ANY(%s) GROUP BY v.project_id",
                (org_id, list({row["project_id"] for row in rows}))).fetchall()
            counts = {row["project_id"]: row["run_count"] for row in counts}
            for row in rows:
                row["project_run_count"] = counts[row["project_id"]]
    next_cursor = None
    if has_more:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps(
            [last["created_at"].isoformat(), str(last["id"])]).encode()).decode()
    return {"jobs": rows, "next_cursor": next_cursor, "has_more": has_more}


@router.get("/jobs/{job_id}")
def get_job(job_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        return _job_view(conn, _load_job(conn, p, job_id, ROLES_ALL))


@router.post("/jobs/{job_id}/cancel", status_code=202)
def cancel_job(job_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    """Requests a stop. Queued jobs settle immediately with no compute charge; running
    jobs stop at the next checkpoint and settle for compute actually used."""
    with database.tx() as conn:
        job = _load_job(conn, p, job_id, CAN_RESEARCH, lock=True)
        if job["state"] == "queued":
            settle_job(conn, job_id, "cancelled")
        elif job["state"] in ("running", "finalizing", "stopping"):
            conn.execute("UPDATE jobs SET cancel_requested = true, updated_at = now(), "
                         "version = version + 1 WHERE id = %s", (job_id,))
        audit(conn, p, job["org_id"], "job.cancel", f"job:{job_id}", {"state": job["state"]})
        return _job_view(conn, conn.execute("SELECT * FROM jobs WHERE id = %s",
                                            (job_id,)).fetchone())


ARTIFACT_TYPES = {"report.json": "application/json", "report.html": "text/html; charset=utf-8",
                  "trades.csv": "text/csv; charset=utf-8"}


@router.get("/reports/{report_id}")
def get_report(report_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        rep = conn.execute("SELECT * FROM reports WHERE id = %s", (report_id,)).fetchone()
        if rep is None:
            raise HTTPException(404, "not found")
        require(conn, p, rep["org_id"], ROLES_ALL)
    rep["artifacts"] = {name: {k: v for k, v in meta.items() if k != "key"}
                        for name, meta in rep["artifacts"].items()}
    return rep


@router.get("/reports/{report_id}/artifacts/{name}")
def get_artifact(report_id: UUID, name: str, p: Principal = CurrentUser,
                 database=Depends(db), objects=Depends(store), download: bool = False):
    if name not in ARTIFACT_TYPES:
        raise HTTPException(404, "not found")
    with database.tx() as conn:
        rep = conn.execute("SELECT * FROM reports WHERE id = %s", (report_id,)).fetchone()
        if rep is None or name not in rep["artifacts"]:
            raise HTTPException(404, "not found")
        require(conn, p, rep["org_id"], ROLES_ALL)
    headers = {"X-Content-Type-Options": "nosniff",
               "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; "
                                          "sandbox"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="veyra-{report_id}-{name}"'
    try:
        artifact = rep["artifacts"][name]
        if not isinstance(artifact["key"], str):
            raise ValueError("invalid artifact key")
        body = objects.get(artifact["key"])
        if (not isinstance(body, bytes) or type(artifact["bytes"]) is not int
                or len(body) != artifact["bytes"]
                or "sha256:" + hashlib.sha256(body).hexdigest() != artifact["sha256"]):
            raise ValueError("artifact identity changed")
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(503, "report artifact unavailable") from exc
    return Response(body, media_type=ARTIFACT_TYPES[name], headers=headers)
