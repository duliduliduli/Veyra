# ADR 0002: Strategy isolation, local versus production

Status: accepted for local development only · 2026-10-11

## Local (implemented)

Strategy code runs in a separate OS process (`python -I -m veyra_sdk.host`). That
process has:

- a scrubbed environment (no secrets or credentials), a private temp working dir, and
  only the snapshot's files;
- rlimits on CPU seconds, address space, file size, and no core dumps;
- `PR_SET_PDEATHSIG=SIGKILL`, so it dies with its supervisor (no orphans), plus its own
  session for group kill;
- the JSON-lines protocol on a duplicated fd, with `sys.stdout` pointed at stderr so
  strategy prints cannot forge protocol messages;
- per-message timeouts bounded by the job's authorized deadline.

The trusted simulator keeps the clock, fills, balances and all bars in *its* memory.
The strategy only ever receives the bar that just closed and returns bounded intents.

## What this does NOT provide (production gates, spec §5.3/§18.2)

- **No filesystem isolation.** The process can read anything the worker's user can
  read. Locally that includes the generator for synthetic data. Production must run the
  strategy in its own Fargate task or Modal sandbox, with no dataset mounted.
- **No network isolation.** Production needs deny-by-default egress.
- **No protection between tenants on the same host.** Each job needs a separate task.

Until those exist, results are fine for private research but cannot earn a
marketplace "verified" evidence badge.
