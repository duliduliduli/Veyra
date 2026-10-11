# Veyra

Coding rules: follow @AGENTS.md (Ponytail: the smallest complete change; never cut
validation, security, money correctness or tests for risky logic). Use
`/ponytail-review` before pushing and `/ponytail-audit` for repo-wide checks.

Project rules that win over brevity:
- The master build spec is the source of truth; `docs/status.md` maps work to it.
- Money is integer nano-USD. No floats. Ledger changes go through `veyra_api.ledger`.
- Every worker write is fenced by `jobs.fence_token`; settlement goes through
  `veyra_api.settlement.settle_job` only.
- Strategy output is untrusted input: validate it at the engine boundary.

Check before pushing: `uv run ruff check . && uv run pytest` (needs Postgres:
`./scripts/dev-db.sh`).
