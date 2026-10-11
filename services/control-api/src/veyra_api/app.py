from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from veyra_api import config, ledger
from veyra_api.api_billing import dev_router
from veyra_api.api_billing import router as billing_router
from veyra_api.api_jobs import router as jobs_router
from veyra_api.api_orgs import router as orgs_router
from veyra_api.api_projects import router as projects_router
from veyra_api.db import Database, migrate
from veyra_api.storage import ObjectStore


def create_app(settings: config.Settings | None = None) -> FastAPI:
    settings = settings or config.load()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        migrate(settings.database_url)
        app.state.db = Database(settings.database_url)
        with app.state.db.tx() as conn:
            ledger.ensure_platform_accounts(conn)
        yield
        app.state.db.close()

    app = FastAPI(title="Veyra Control API", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.store = ObjectStore(settings.object_store_dir)
    for r in (orgs_router, projects_router, jobs_router, billing_router):
        app.include_router(r)

    if settings.dev_auth_enabled:
        app.include_router(dev_router)

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    # The hash allows only the attribution-logo style the vendored chart library injects
    # (its license requires the attribution); bump it with the library version.
    csp = ("default-src 'self'; img-src 'self' data:; "
           "style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; "
           "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", csp)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    # shortcut: served from the source checkout, move to a CDN/Vercel when traffic needs it
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


WEB_DIR = Path(__file__).resolve().parents[4] / "apps" / "web"
