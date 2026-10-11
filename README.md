# Veyra

Trading workspace: Python strategies, explicit data provenance, pay-per-use compute
with customer-set spending ceilings, and reproducible reports.

This repo implements the **first vertical slice** of the master build spec (§30). That
means a reviewer can snapshot strategy code, get a quote, authorize a hard spending
ceiling, run a bounded backtest, and get back an immutable report and an itemized
receipt. Cancellation and worker crashes are handled safely. It runs locally on
**synthetic data** with a simulated payment provider. No vendor accounts are needed.

See [`docs/status.md`](docs/status.md) for what is done, what is next, and what is
blocked on business decisions.

## Layout

| Path | What |
|---|---|
| `packages/billing` | Exact nano-USD money, versioned rate cards, quote/settlement math |
| `packages/python-sdk` | `Strategy` base class and the sandbox-side protocol host |
| `runtimes/simulator` | Trusted bar simulator, synthetic data, metrics, reports, process sandbox |
| `services/control-api` | FastAPI: orgs/RBAC, projects, quotes, authorizations, jobs, ledger, payments |
| `services/scheduler` | Worker (fenced leases, heartbeats, runtime caps) and reaper |
| `templates/strategies` | Starter strategies |
| `tests` | Money races, tenancy, webhooks, job lifecycle, crash recovery |
| `docs` | ADRs and build status |

## Run it

Requirements: Python 3.12+, [uv](https://docs.astral.sh/uv/), PostgreSQL 16.

```bash
./scripts/dev-db.sh          # local Postgres (system service or Docker)
uv sync
uv run pytest                # full test suite
uv run python scripts/demo.py   # end-to-end walkthrough -> demo-output/report.html
```

Run the services:

```bash
uv run uvicorn veyra_api.app:create_app --factory --reload   # API on :8000, docs at /docs
uv run python -m veyra_scheduler all                         # worker + reaper
```

Local requests authenticate with an `X-Veyra-Dev-User: you@example.com` header. That
only works when `APP_ENV` is `local` or `test`.

## The money flow

1. `POST /v1/orgs/{id}/billing/topups` creates a pending payment. Credit is added
   **only** when the signed webhook confirms it.
2. `POST /v1/quotes` returns expected and **maximum** cost and pins the hashes of code,
   data, engine, rates and request.
3. `POST /v1/quotes/{id}/authorize` takes the exact maximum the user saw and reserves it
   atomically.
4. `POST /v1/jobs` (with an `Idempotency-Key`) queues the run.
5. Settlement charges `min(actual + 5% fee, maximum)`, releases the rest, and writes an
   itemized receipt. If the platform overruns the ceiling, the platform absorbs the
   difference.

## Writing a strategy

```python
from veyra_sdk import Strategy

class MyStrategy(Strategy):
    def on_bar(self, bar, ctx):        # bar: the bar that just closed
        if ctx.position == 0:
            ctx.buy("0.1")             # fills at the NEXT bar's open
```

Strategies run in a separate, resource-limited process. They never see future bars, the
portfolio ledger, or the engine.
