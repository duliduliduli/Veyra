import json
import re
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
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


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    template: str | None = "sma_cross"
    files: dict[str, str] | None = None
    entrypoint: str = "strategy.py"


def _validate_files(files: dict[str, str], entrypoint: str) -> None:
    if not files or len(files) > MAX_FILES:
        raise HTTPException(422, f"between 1 and {MAX_FILES} files required")
    total = 0
    for path, content in files.items():
        if not PATH_RE.match(path) or ".." in path.split("/"):
            raise HTTPException(422, f"invalid file path {path!r}")
        total += len(content.encode())
    if total > MAX_TOTAL_BYTES:
        raise HTTPException(422, f"project exceeds {MAX_TOTAL_BYTES} bytes")
    if entrypoint not in files:
        raise HTTPException(422, "entrypoint must be one of the files")


def _snapshot(conn, objects, p: Principal, org_id, project_id, files, entrypoint) -> dict:
    _validate_files(files, entrypoint)
    conn.execute("SELECT 1 FROM projects WHERE id = %s FOR UPDATE", (project_id,))
    n = conn.execute("SELECT COALESCE(max(version_no), 0) + 1 AS n FROM project_versions "
                     "WHERE project_id = %s", (project_id,)).fetchone()["n"]
    content = {"files": files, "entrypoint": entrypoint}
    content_hash = digest(content)
    key = f"orgs/{org_id}/projects/{project_id}/versions/{n}.json"
    objects.put(key, json.dumps(content, sort_keys=True).encode())
    row = conn.execute(
        "INSERT INTO project_versions(org_id, project_id, version_no, content_hash, entrypoint, "
        "object_key, created_by) VALUES (%s,%s,%s,%s,%s,%s,%s) "
        "RETURNING id, project_id, version_no, content_hash, entrypoint, created_at",
        (org_id, project_id, n, content_hash, entrypoint, key, p.user_id)).fetchone()
    audit(conn, p, org_id, "project.version", f"project_version:{row['id']}",
          {"content_hash": content_hash})
    return row


@router.get("/catalog/datasets")
def catalog(p: Principal = CurrentUser):
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
def bars(dataset_id: str, start: str | None = None, end: str | None = None,
         p: Principal = CurrentUser):
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
            "SELECT p.id, p.name, p.created_at, v.id AS latest_version_id, "
            "v.version_no AS latest_version_no FROM projects p "
            "JOIN LATERAL (SELECT id, version_no FROM project_versions "
            "WHERE project_id = p.id ORDER BY version_no DESC LIMIT 1) v ON true "
            "WHERE p.org_id = %s ORDER BY p.created_at DESC LIMIT 100", (org_id,)).fetchall()
    return {"projects": rows}


@router.post("/orgs/{org_id}/projects", status_code=201)
def create_project(org_id: UUID, body: ProjectIn, p: Principal = CurrentUser,
                   database=Depends(db), objects=Depends(store)):
    files = body.files if body.files is not None else _template(body.template or "")
    with database.tx() as conn:
        require(conn, p, org_id, CAN_RESEARCH)
        if conn.execute("SELECT 1 FROM projects WHERE org_id = %s AND name = %s",
                        (org_id, body.name)).fetchone():
            raise HTTPException(409, "project name already exists")
        proj = conn.execute("INSERT INTO projects(org_id, name, created_by) VALUES (%s,%s,%s) "
                            "RETURNING id, org_id, name, created_at",
                            (org_id, body.name, p.user_id)).fetchone()
        version = _snapshot(conn, objects, p, org_id, proj["id"], files, body.entrypoint)
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


@router.post("/projects/{project_id}/versions", status_code=201)
def create_version(project_id: UUID, body: FilesIn, p: Principal = CurrentUser,
                   database=Depends(db), objects=Depends(store)):
    with database.tx() as conn:
        proj = _load_project(conn, p, project_id, CAN_RESEARCH)
        return _snapshot(conn, objects, p, proj["org_id"], project_id, body.files,
                         body.entrypoint)


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

