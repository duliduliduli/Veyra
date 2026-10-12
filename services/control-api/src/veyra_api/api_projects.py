import json
import re
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, ConfigDict, Field, field_validator
from veyra_api.auth import CAN_RESEARCH, ROLES_ALL, Principal, audit, require
from veyra_api.deps import CurrentUser, db, store
from veyra_sim import data
from veyra_sim.report import digest

router = APIRouter(prefix="/v1")

PATH_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_\-]*(/[A-Za-z0-9_][A-Za-z0-9_\-]*)*\.py$")
MAX_FILES = 50
MAX_TOTAL_BYTES = 256 * 1024
TEMPLATES_DIR = Path(__file__).resolve().parents[4] / "templates" / "strategies"


def _template(name: str) -> dict[str, str]:
    path = TEMPLATES_DIR / f"{name}.py"
    if not re.fullmatch(r"[a-z0-9_]{1,40}", name) or not path.is_file():
        raise HTTPException(422, f"unknown template {name!r}")
    return {"strategy.py": path.read_text()}


class FilesIn(BaseModel):
    files: dict[str, str]
    entrypoint: str = "strategy.py"
    expected_version_no: int | None = Field(default=None, ge=1, le=2147483647, strict=True)


def _clean_text(value: str, *, multiline: bool = False) -> str:
    if any((ord(c) < 32 and not (multiline and c in "\n\r\t")) or ord(c) == 127
           for c in value):
        raise ValueError("control characters are not allowed")
    value.encode("utf-8")
    return value.strip()


class ProjectSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=4000)
    folder: str | None = Field(default=None, max_length=80)
    visibility: Literal["private"] = "private"

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if value is None or not (value := _clean_text(value)):
            raise ValueError("name must not be empty")
        return value

    @field_validator("description")
    @classmethod
    def clean_description(cls, value):
        if value is None:
            raise ValueError("description must be a string")
        return _clean_text(value, multiline=True)

    @field_validator("folder")
    @classmethod
    def clean_folder(cls, value):
        if value is None:
            return None
        value = " ".join(_clean_text(value).split())
        if "/" in value or "\\" in value or value in (".", ".."):
            raise ValueError("folder must be a flat name, not a path")
        return value or None

    @field_validator("visibility")
    @classmethod
    def private_only(cls, value):
        if value is None:
            raise ValueError("visibility must be private")
        return value


class ProjectIn(ProjectSettings):
    template: str | None = "sma_cross"
    files: dict[str, str] | None = None
    entrypoint: str = "strategy.py"


class ProjectPatch(ProjectSettings):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    visibility: Literal["private"] | None = None


class DuplicateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        return ProjectSettings.clean_name(value) if value is not None else None


def _validate_files(files: dict[str, str], entrypoint: str) -> None:
    if not files or len(files) > MAX_FILES:
        raise HTTPException(422, f"between 1 and {MAX_FILES} files required")
    total = 0
    for path, content in files.items():
        if not PATH_RE.fullmatch(path) or ".." in path.split("/"):
            raise HTTPException(422, f"invalid file path {path!r}")
        try:
            total += len(content.encode())
        except UnicodeEncodeError as exc:
            raise HTTPException(422, "files must contain valid UTF-8 text") from exc
    if total > MAX_TOTAL_BYTES:
        raise HTTPException(422, f"project exceeds {MAX_TOTAL_BYTES} bytes")
    if entrypoint not in files:
        raise HTTPException(422, "entrypoint must be one of the files")


def _snapshot(conn, objects, p: Principal, org_id, project_id, files, entrypoint,
              expected_version_no=None) -> dict:
    _validate_files(files, entrypoint)
    if not conn.execute("SELECT 1 FROM projects WHERE id = %s AND org_id = %s FOR UPDATE",
                        (project_id, org_id)).fetchone():
        raise HTTPException(404, "not found")
    n = conn.execute("SELECT COALESCE(max(version_no), 0) + 1 AS n FROM project_versions "
                     "WHERE project_id = %s", (project_id,)).fetchone()["n"]
    if expected_version_no is not None and expected_version_no != n - 1:
        raise HTTPException(409, "project version changed; reload before saving")
    content = {"files": files, "entrypoint": entrypoint}
    content_hash = digest(content)
    key = f"orgs/{org_id}/projects/{project_id}/versions/{n}.json"
    objects.put(key, json.dumps(content, sort_keys=True).encode())
    row = conn.execute(
        "INSERT INTO project_versions(org_id, project_id, version_no, content_hash, entrypoint, "
        "object_key, created_by) VALUES (%s,%s,%s,%s,%s,%s,%s) "
        "RETURNING id, project_id, version_no, content_hash, entrypoint, created_at",
        (org_id, project_id, n, content_hash, entrypoint, key, p.user_id)).fetchone()
    conn.execute("UPDATE projects SET updated_at = clock_timestamp() WHERE id = %s",
                 (project_id,))
    audit(conn, p, org_id, "project.version", f"project_version:{row['id']}",
          {"content_hash": content_hash})
    return row


@router.get("/catalog/datasets")
def catalog():
    out = []
    for spec in data.CATALOG.values():
        bars = data.generate_bars(spec)
        out.append({
            "dataset_id": spec.dataset_id, "provider": spec.provider,
            "instrument_id": spec.instrument.instrument_id,
            "quote_currency": spec.instrument.quote_currency, "resolution": "1d",
            "price_basis": "synthetic last", "coverage_start": bars[0].ts,
            "coverage_end": bars[-1].ts, "bars": len(bars), "license": spec.license,
            "allowed_uses": ["display", "backtest", "report"], "export_policy": "allowed",
            "price_nano": 0, "manifest_hash": data.manifest_hash(bars),
            "quality_findings": len(data.quality_findings(bars)),
        })
    return {"datasets": out}


@router.get("/catalog/datasets/{dataset_id}/bars")
def bars(dataset_id: str, start: str | None = None, end: str | None = None):
    if dataset_id not in data.CATALOG:
        raise HTTPException(404, "not found")
    # Strings keep exact prices; clients convert only for drawing.
    return {"dataset_id": dataset_id, "bars": [
        {"ts": b.ts, "open": str(b.open), "high": str(b.high), "low": str(b.low),
         "close": str(b.close), "volume": str(b.volume)}
        for b in data.load(dataset_id, start, end)]}


@router.get("/orgs/{org_id}/projects")
def list_projects(org_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        require(conn, p, org_id, ROLES_ALL)
        rows = conn.execute(
            "SELECT p.id, p.name, p.description, p.folder, p.visibility, p.created_at, "
            "p.updated_at, v.id AS latest_version_id, "
            "v.version_no AS latest_version_no FROM projects p "
            "JOIN LATERAL (SELECT id, version_no FROM project_versions "
            "WHERE project_id = p.id ORDER BY version_no DESC LIMIT 1) v ON true "
            "WHERE p.org_id = %s ORDER BY p.updated_at DESC, p.id DESC LIMIT 100",
            (org_id,)).fetchall()
    return {"projects": rows}


def _insert_project(conn, p, org_id, name, description, folder):
    return conn.execute(
        "INSERT INTO projects(org_id, name, description, folder, created_by) "
        "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (org_id, name) DO NOTHING RETURNING *",
        (org_id, name, description, folder, p.user_id)).fetchone()


@router.post("/orgs/{org_id}/projects", status_code=201)
def create_project(org_id: UUID, body: ProjectIn, p: Principal = CurrentUser,
                   database=Depends(db), objects=Depends(store)):
    with database.tx() as conn:
        require(conn, p, org_id, CAN_RESEARCH)
        files = body.files if body.files is not None else _template(body.template or "")
        _validate_files(files, body.entrypoint)
        proj = _insert_project(conn, p, org_id, body.name, body.description, body.folder)
        if proj is None:
            raise HTTPException(409, "project name already exists")
        version = _snapshot(conn, objects, p, org_id, proj["id"], files, body.entrypoint)
        proj = conn.execute("SELECT * FROM projects WHERE id = %s", (proj["id"],)).fetchone()
    return proj | {"latest_version": version}


def _load_project(conn, p, project_id, allowed):
    proj = conn.execute("SELECT * FROM projects WHERE id = %s", (project_id,)).fetchone()
    if proj is None:
        raise HTTPException(404, "not found")
    require(conn, p, proj["org_id"], allowed)
    return proj


@router.get("/projects/{project_id}")
def get_project(project_id: UUID, p: Principal = CurrentUser, database=Depends(db)):
    with database.tx() as conn:
        proj = _load_project(conn, p, project_id, ROLES_ALL)
        versions = conn.execute(
            "SELECT id, version_no, content_hash, entrypoint, created_at FROM project_versions "
            "WHERE project_id = %s ORDER BY version_no DESC LIMIT 50", (project_id,)).fetchall()
    return proj | {"versions": versions}


@router.patch("/projects/{project_id}")
def update_project(project_id: UUID, body: ProjectPatch, p: Principal = CurrentUser,
                   database=Depends(db)):
    changes = body.model_dump(exclude_unset=True)
    try:
        with database.tx() as conn:
            proj = _load_project(conn, p, project_id, CAN_RESEARCH)
            if changes:
                columns = ", ".join(f"{field} = %s" for field in changes)
                proj = conn.execute(
                    f"UPDATE projects SET {columns}, updated_at = clock_timestamp() "
                    "WHERE id = %s RETURNING *", (*changes.values(), project_id)).fetchone()
                audit(conn, p, proj["org_id"], "project.settings", f"project:{project_id}",
                      {"fields": list(changes)})
    except UniqueViolation as exc:
        raise HTTPException(409, "project name already exists") from exc
    return proj


@router.post("/projects/{project_id}/duplicate", status_code=201)
def duplicate_project(project_id: UUID, body: DuplicateIn | None = None,
                      p: Principal = CurrentUser, database=Depends(db), objects=Depends(store)):
    requested_name = body.name if body is not None else None
    with database.tx() as conn:
        source = _load_project(conn, p, project_id, CAN_RESEARCH)
        latest = conn.execute(
            "SELECT object_key FROM project_versions WHERE project_id = %s "
            "ORDER BY version_no DESC LIMIT 1", (project_id,)).fetchone()
        if latest is None:
            raise HTTPException(409, "project has no saved version to duplicate")
        content = json.loads(objects.get(latest["object_key"]))
        _validate_files(content["files"], content["entrypoint"])
        n = 1
        while True:
            suffix = " copy" if n == 1 else f" copy {n}"
            name = requested_name or source["name"][:120 - len(suffix)] + suffix
            proj = _insert_project(conn, p, source["org_id"], name,
                                   source["description"], source["folder"])
            if proj is not None:
                break
            if requested_name is not None:
                raise HTTPException(409, "project name already exists")
            n += 1
        version = _snapshot(conn, objects, p, source["org_id"], proj["id"],
                            content["files"], content["entrypoint"])
        proj = conn.execute("SELECT * FROM projects WHERE id = %s", (proj["id"],)).fetchone()
        audit(conn, p, source["org_id"], "project.duplicate", f"project:{proj['id']}",
              {"source_project_id": str(project_id)})
    return proj | {"latest_version": version}


@router.post("/projects/{project_id}/versions", status_code=201)
def create_version(project_id: UUID, body: FilesIn, p: Principal = CurrentUser,
                   database=Depends(db), objects=Depends(store)):
    with database.tx() as conn:
        proj = _load_project(conn, p, project_id, CAN_RESEARCH)
        return _snapshot(conn, objects, p, proj["org_id"], project_id, body.files,
                         body.entrypoint, body.expected_version_no)


@router.get("/projects/{project_id}/versions/{version_no}")
def get_version(project_id: UUID, version_no: int, p: Principal = CurrentUser,
                database=Depends(db), objects=Depends(store)):
    with database.tx() as conn:
        _load_project(conn, p, project_id, ROLES_ALL)
        v = conn.execute("SELECT * FROM project_versions WHERE project_id = %s AND "
                         "version_no = %s", (project_id, version_no)).fetchone()
    if v is None:
        raise HTTPException(404, "not found")
    content = json.loads(objects.get(v["object_key"]))
    v.pop("object_key")
    return v | content

