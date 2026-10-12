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
| `apps/web` | Phone-first app: markets, code, runs, wallet (no build step) |
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

Run the app:

```bash
uv run uvicorn veyra_api.app:create_app --factory --reload   # app + API on :8000
uv run python -m veyra_scheduler all                         # worker + reaper (runs backtests)
```

Open http://localhost:8000 on a phone (same network: use `--host 0.0.0.0` and your
computer's IP) or with the browser's phone emulation. Sign in with any email, add test
credit in Wallet, create a strategy in Code, get a price, approve, and read the report.
API docs are at `/docs`. The dev sign-in and test payments only exist when `APP_ENV` is
`local` or `test` in this source candidate, including the signed development webhook.
An unset `APP_ENV` still defaults to `local`; verify deployment labels before release.
The deployed webhook configuration has not been verified. See
[the source gate](docs/development-payment-webhook-gate.md).

Phone journey test (needs the two commands above running):

```bash
npm i --no-save playwright && node tests/e2e/phone.mjs light
```

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

The 5% fee above is a proposed test rate, not approved production pricing. The current
payment provider is a development stand-in, not a connected real payment service.

## Writing a strategy

```python
from veyra_sdk import Strategy

class MyStrategy(Strategy):
    def on_bar(self, bar, ctx):        # bar: the bar that just closed
        if ctx.position == 0:
            ctx.buy("0.1")             # fills at the NEXT bar's open
```

Saved strategies can import helper modules from their snapshot root. Nested
relative imports use explicit Python packages; the selected entrypoint must define
one distinct `Strategy` subclass. See the [snapshot import contract](docs/python-snapshot-imports.md)
for nested entrypoints, initializer files, runtime-name collisions and local test limits.

The SDK sends bars sequentially, but the local resource-limited process does not
isolate the filesystem or network. Run only trusted local sample code. The worker
rejects non-local/test environment labels; that guard does not protect a mislabeled
deployment or turn the process into a sandbox. Production untrusted execution
remains blocked pending real isolation. See [the isolation ADR](docs/adr/0002-local-strategy-isolation.md).
