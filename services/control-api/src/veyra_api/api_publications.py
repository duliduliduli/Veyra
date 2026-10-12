"""Explicit, immutable public snapshots. Private projects never change visibility."""

import base64
import binascii
import json
import logging
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from veyra_api.api_projects import ProjectSettings, _load_project
from veyra_api.api_projects import _load_snapshot as _content
from veyra_api.auth import CAN_ADMIN, Principal, audit, require
from veyra_api.deps import CurrentUser, db, store


class NoStoreRoute(APIRoute):
    async def handle(self, scope, receive, send):
        started = False

        async def no_store(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "no-store"
                headers["X-Content-Type-Options"] = "nosniff"
            await send(message)

        try:
            await super().handle(scope, receive, no_store)
        except StarletteHTTPException as exc:
            response = await http_exception_handler(Request(scope), exc)
            await response(scope, receive, no_store)
        except Exception:
            if started:
                raise
            logging.getLogger(__name__).exception("publication request failed")
            response = JSONResponse({"detail": "Internal Server Error"}, status_code=500)
            await response(scope, receive, no_store)


router = APIRouter(prefix="/v1", route_class=NoStoreRoute)


class PublicationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_version_id: UUID
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(max_length=4000)
    confirm_public: bool = Field(strict=True)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value):
        return ProjectSettings.clean_name(value)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value):
        return ProjectSettings.clean_description(value)

    @field_validator("confirm_public")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("confirm_public must be true to publish the selected version")
        return value


def _public_metadata(row):
    # Allowlist: never serialize the source project's metadata or identity columns.
    return {key: row[key] for key in (
        "id", "title", "description", "content_hash", "entrypoint", "published_at",
    )} | {"public_path": f"/v1/public/strategies/{row['id']}"}


def _receipt(row):
    return _public_metadata(row) | {
        "project_version_id": row["project_version_id"],
        "version_no": row["version_no"],
        "status": "revoked" if row["revoked_at"] is not None else "published",
        "revoked_at": row["revoked_at"],
    }


def _existing(conn, org_id, key):
    return conn.execute(
        "SELECT s.*, v.version_no FROM strategy_publications s "
        "JOIN project_versions v ON v.id = s.project_version_id AND v.org_id = s.org_id "
        "WHERE s.org_id = %s AND s.idempotency_key = %s", (org_id, key)).fetchone()


def _replay(row, body, response):
    if (row["project_version_id"], row["title"], row["description"]) != (
            body.project_version_id, body.title, body.description):
        raise HTTPException(409, "idempotency key already used for a different publication")
    response.status_code = 200
    return _receipt(row)


@router.post("/projects/{project_id}/publications", status_code=201)
def publish(project_id: UUID, body: PublicationIn, response: Response,
            idempotency_key: str = Header(pattern=r"^[A-Za-z0-9_-]{8,128}$"),
            p: Principal = CurrentUser, database=Depends(db), objects=Depends(store)):
    with database.tx() as conn:
        project = _load_project(conn, p, project_id, CAN_ADMIN)
        version = conn.execute(
            "SELECT * FROM project_versions WHERE id = %s AND project_id = %s "
            "AND org_id = %s FOR SHARE",
            (body.project_version_id, project_id, project["org_id"])).fetchone()
        if version is None:
            raise HTTPException(404, "not found")
        existing = _existing(conn, project["org_id"], idempotency_key)
        if existing is not None:
            return _replay(existing, body, response)
        _content(objects, version)
        row = conn.execute(
            "INSERT INTO strategy_publications(org_id, project_version_id, content_hash, "
            "entrypoint, title, description, idempotency_key, published_by) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING *",
            (project["org_id"], version["id"], version["content_hash"], version["entrypoint"],
             body.title, body.description, idempotency_key, p.user_id)).fetchone()
        if row is None:
            return _replay(_existing(conn, project["org_id"], idempotency_key), body, response)
        audit(conn, p, project["org_id"], "strategy.publish", f"publication:{row['id']}",
              {"project_version_id": str(version["id"]), "content_hash": row["content_hash"]})
        return _receipt(row | {"version_no": version["version_no"]})


def _decode_cursor(cursor):
    try:
        decoded = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if (not isinstance(decoded, list) or len(decoded) != 2
                or not all(isinstance(value, str) for value in decoded)):
            raise ValueError("cursor must contain timestamp and ID strings")
        stamp, publication_id = decoded
        stamp = datetime.fromisoformat(stamp)
        publication_id = UUID(publication_id)
        if stamp.tzinfo is None:
            raise ValueError("cursor timestamp must include a timezone")
        return stamp.astimezone(UTC), publication_id
    except (ValueError, TypeError, OverflowError, binascii.Error) as exc:
        raise HTTPException(422, "invalid publication cursor") from exc


@router.get("/projects/{project_id}/publications")
def list_publications(project_id: UUID, p: Principal = CurrentUser, database=Depends(db),
                      limit: Annotated[int, Query(ge=1, le=100)] = 20,
                      cursor: Annotated[str | None, Query(max_length=512)] = None):
    with database.tx() as conn:
        project = _load_project(conn, p, project_id, CAN_ADMIN)
        conditions = ["v.project_id = %s", "s.org_id = %s"]
        params = [project_id, project["org_id"]]
        if cursor is not None:
            conditions.append("(s.published_at, s.id) < (%s, %s)")
            params.extend(_decode_cursor(cursor))
        params.append(limit + 1)
        rows = conn.execute(
            "SELECT s.*, v.version_no FROM strategy_publications s "
            "JOIN project_versions v ON v.id = s.project_version_id AND v.org_id = s.org_id "
            "WHERE " + " AND ".join(conditions) +
            " ORDER BY s.published_at DESC, s.id DESC LIMIT %s", params).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more:
        last = rows[-1]
        next_cursor = base64.urlsafe_b64encode(json.dumps(
            [last["published_at"].isoformat(), str(last["id"])]).encode()).decode()
    return {"publications": [_receipt(row) for row in rows],
            "next_cursor": next_cursor, "has_more": has_more}


@router.delete("/publications/{publication_id}")
def unpublish(publication_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        row = conn.execute(
            "SELECT s.*, v.version_no FROM strategy_publications s "
            "JOIN project_versions v ON v.id = s.project_version_id AND v.org_id = s.org_id "
            "WHERE s.id = %s FOR UPDATE OF s", (publication_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "not found")
        require(conn, p, row["org_id"], CAN_ADMIN)
        if row["revoked_at"] is None:
            changed = conn.execute(
                "UPDATE strategy_publications SET revoked_at = clock_timestamp() "
                "WHERE id = %s RETURNING revoked_at", (publication_id,)).fetchone()
            row |= changed
            audit(conn, p, row["org_id"], "strategy.unpublish", f"publication:{publication_id}")
        return _receipt(row)


@router.get("/public/strategies")
def discover(q: str = Query(default="", max_length=120, pattern=r"^[^\x00-\x1f\x7f]*$"),
             limit: int = Query(default=20, ge=1, le=100),
             offset: int = Query(default=0, ge=0, le=10000), database=Depends(db)):
    term = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    with database.tx() as conn:
        rows = conn.execute(
            "SELECT id, title, description, content_hash, entrypoint, published_at "
            "FROM strategy_publications WHERE revoked_at IS NULL "
            "AND (title ILIKE %s OR description ILIKE %s) "
            "ORDER BY published_at DESC, id DESC LIMIT %s OFFSET %s",
            (f"%{term}%", f"%{term}%", limit, offset)).fetchall()
    return {"strategies": [_public_metadata(row) for row in rows]}


@router.get("/public/strategies/{publication_id}")
def read_publication(publication_id: UUID, database=Depends(db), objects=Depends(store)):
    with database.tx() as conn:
        # Hold the publication lock through the object read so revocation serializes with it.
        row = conn.execute(
            "SELECT s.id, s.title, s.description, s.content_hash, s.entrypoint, s.published_at, "
            "v.object_key FROM strategy_publications s JOIN project_versions v "
            "ON v.id = s.project_version_id AND v.org_id = s.org_id "
            "WHERE s.id = %s AND s.revoked_at IS NULL FOR SHARE OF s",
            (publication_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "not found")
        return _public_metadata(row) | _content(objects, row)
