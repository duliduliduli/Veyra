# ADR 0001: Sprint 1 vertical slice architecture

Status: accepted for local development · 2026-10-11

## Context

The master build spec (§30) asks for one safe, costed vertical slice before any vendor
accounts, data contracts or payments approval exist. That covers code version →
quote → authorization → bounded job → report + receipt, plus safe cancellation and
crash recovery.

## Decision

- **Python monorepo** (uv workspace) using the paths in spec §26:
  `packages/billing`, `packages/python-sdk`, `runtimes/simulator`,
  `services/control-api`, `services/scheduler`.
- **Postgres** is the system of record and the budget authority (spec §15.4). Local
  Postgres 16 stands in for Neon.
- **Money** is integer nano-USD (1e-9) everywhere. Floats are rejected.
- **Ledger** is append-only double-entry. DB triggers forbid UPDATE/DELETE and reject
  unbalanced entries. A cached balance per account carries a `CHECK (balance >= 0)` for
  customer accounts, so concurrent reservations cannot overspend: the row lock
  serializes them and the constraint rejects the loser. `ledger.reconcile()` re-derives
  every balance from the journal.
- **Jobs** use a fenced lease: each claim increments `jobs.fence_token`, and every write
  by a worker is conditional on its token. The reaper bumps the token before settling an
  expired job, so a paused "zombie" worker can never write results or charges.
- **Settlement** is a single idempotent function (`veyra_api.settlement.settle_job`).
  It is used by the worker, by the reaper and by cancellation. The customer pays
  `min(actual + fee, authorized max)`, and any excess is posted to
  `platform:overrun_expense`.
- **Payments** sit behind a provider boundary with Stripe's contract shape (a checkout
  intent, an HMAC-signed webhook with a timestamp, dedup by event ID). A local `dev`
  provider implements it. Credit is posted only from the webhook.
- **Identity**: local/test accept an `X-Veyra-Dev-User` header. Every other environment
  returns 401 until Clerk JWT verification is wired in (W09). Authorization is always
  server-side and resource-first. Cross-tenant access returns 404, and a wrong role
  returns 403.
- **Object storage** goes through an adapter: a local filesystem now, S3 later. Keys
  are built only from server IDs.
- **Engine**: a small in-house bar simulator (`veyra-sim`) is the trusted side of the
  strategy protocol. It is *not* the NautilusTrader/LEAN decision (W05). That benchmark
  is still open, and the SDK protocol is designed so either engine can sit behind it.

## Consequences

- Compute billing in local mode is wall time + the rate card's startup overhead, which
  models Fargate. Production must replace this with supplier-reported usage and
  reconciliation (spec §15.5).
- The quote estimate is an unprofiled heuristic and is labeled as one. W38 replaces it.
- The per-job ceiling defaults to $1.00 (`MAX_JOB_CUSTOMER_USD`), matching sprint
  step 7.
