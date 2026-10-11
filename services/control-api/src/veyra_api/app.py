from contextlib import asynccontextmanager

from fastapi import FastAPI
from veyra_api import config, ledger
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

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    return app
