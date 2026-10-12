# Offline starter revision: retry until filled and validate overrides

Source candidate only. Reviewed 2026-10-12; no publication or deployment is claimed.

## Contract and compatibility

The first buy-and-hold template intentionally submitted at most one entry intent.
Its ADR documented that a rejected order was never retried. This change introduces a
new template revision rather than changing existing saved strategy behavior:

- New buy-and-hold source submits one intent per closed bar while flat until a buy
  actually fills. `on_fill` marks the entry; submitting an intent does not.
- New buy-and-hold and SMA source reject non-finite/out-of-range allocation overrides
  with `ValueError("require finite 0 < alloc <= 1")` during initialization.
- New SMA source requires integer or integer-string windows (not booleans/floats)
  within `1 <= fast < slow <= 10000`. Its crossover decisions are unchanged.
- The new browser SMA string exactly matches `templates/strategies/sma_cross.py`.
- Private v1 source constants and frozen test fixtures preserve the previous exact
  scaffolds. Numeric-default edits operate on the supplied source, changing only the
  requested default, for both revisions and LF/CRLF source. Custom source stays
  unsupported. No saved source migration was added.
- Explicit create commands propose the new revision for review. Apply changes only
  the draft; Undo restores its exact prior source. Existing saved versions are intact.
  New server-created SMA projects also obtain the new checked-in starter through the
  existing template loader. No API contract or loader code changed.

These are educational examples, not investment recommendations. Gaps, execution fees,
tick/lot rounding, or the end of the dataset can still prevent any fill. In particular,
allocation 1 can keep failing for insufficient cash when fees/slippage apply. An SMA
intent rejected at the next open still waits for a subsequent qualifying crossover;
only the buy-and-hold revision adds retry-until-filled behavior.

## Exact verification performed

From the repository root, using pre-existing tools without dependency installation:

```sh
PYTHONPATH=packages/python-sdk/src:runtimes/simulator/src \
  python -m unittest discover -s tests -p test_studio_templates.py -v
node --test tests/e2e/studio-assistant.mjs
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules \
  node --test tests/e2e/proposal-diff-ui.mjs tests/e2e/studio.mjs tests/e2e/proposal-diff.mjs
/workspace/shared/veyra-python-import-wave/test-venv/bin/ruff check \
  templates/strategies/sma_cross.py tests/test_studio_templates.py
node --check apps/web/studio-assistant.js
```

Results: 14 Python test methods, 12 helper tests, 59 DOM/pure Studio/diff tests pass;
focused Ruff and JavaScript syntax checks pass.

Python checks explicitly compile only the reviewed bundled blank, buy-and-hold, SMA,
and frozen v1 buy-and-hold/SMA source in the test process. A tiny synchronous fake
process drives their SDK callbacks through the real simulator with synthetic `Bar`
and `Context` values. It does not construct `StrategyProcess` or launch strategy
subprocesses; `subprocess.Popen` is patched to raise during tests. No arbitrary,
uploaded, saved-user, or remote source is executed. Standard-library unittest avoids
loading the suite's database fixtures.

The deterministic buy-and-hold gap fixture starts with 100 cash: a 9.5-unit intent
sized from close 10 is rejected at the next open 20; a 4.7-unit retry sized from close
20 fills at the following open 10, then stays held. The same fixture still produces
one rejection and no retry for v1. Additional checks cover repeated rejection, costs,
lot rounding, final expiration, no same-bar fills, SMA buy/sell next-open timing,
invalid overrides before bars, and allocation/window boundaries.

DOM checks run the actual app/helper/diff scripts against jsdom, synthetic storage,
and fake responses. They verify both v1 examples with LF and CRLF source through
parameter preview, Apply, Undo, and explicit new-template replacement, plus the
existing editor/stale-proposal/recovery regressions. They do not send real requests,
run Python, start a server, or open a native browser.

## Skipped checks and remaining risk

No full pytest/database suite, actual strategy subprocess, production isolation,
native browser/layout/accessibility run, provider/model integration, live market or
financial action, credentials/runtime configuration, remote operation, upload, CI,
publication, or deployment was performed. No dependencies were installed. These
synthetic checks establish the stated example behavior only; they are not performance,
investment-suitability, or production-execution evidence. Previously saved v1 source
deliberately retains its old behavior and validation until explicitly replaced.

## Integrated candidate verification

The final combined source candidate additionally passed 664 offline Python tests and
205 subtests, 478 explicit frontend tests, 30 chart-interval checks and full Ruff.
Its 301 HTML IDs/references and nine ordered script assets were checked. The seven
existing trusted bundled-SMA compatibility tests ran against the candidate-specific
SDK environment, including actual child-process equivalence across three file layouts.
The template-focused suite described above still uses only its in-process fixture.

The test environment was copied and relinked offline using pre-existing cached
dependencies; no packages were downloaded. All 179 PostgreSQL cases remain unrun
locally. No native browser, external write, production change or user source execution
was performed. This combined verification does not remove the deployment and isolation
gates listed above.
