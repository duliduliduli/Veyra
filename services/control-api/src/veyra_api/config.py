import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_env: str
    database_url: str
    object_store_dir: Path
    payment_webhook_secret: str
    job_lease_seconds: int
    quote_ttl_seconds: int
    max_job_runtime_seconds: int
    max_job_customer_usd: str

    @property
    def dev_auth_enabled(self) -> bool:
        return self.app_env in ("local", "test")


def load() -> Settings:
    return Settings(
        app_env=os.environ.get("APP_ENV", "local"),
        database_url=os.environ.get("DATABASE_URL",
                                    "postgresql://veyra:veyra@localhost:5432/veyra"),
        object_store_dir=Path(os.environ.get("OBJECT_STORE_DIR", ".data/objects")),
        # Local default only; any non-local env must set a real secret reference.
        payment_webhook_secret=os.environ.get("PAYMENT_WEBHOOK_SECRET", "dev-webhook-secret"),
        job_lease_seconds=int(os.environ.get("JOB_LEASE_SECONDS", "15")),
        quote_ttl_seconds=int(os.environ.get("QUOTE_TTL_SECONDS", "900")),
        max_job_runtime_seconds=int(os.environ.get("MAX_JOB_DURATION_SECONDS", "1800")),
        max_job_customer_usd=os.environ.get("MAX_JOB_CUSTOMER_USD", "1.00"),
    )
