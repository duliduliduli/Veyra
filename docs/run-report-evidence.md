# Recorded backtest evidence in the run view

This bounded client-only slice adds three collapsed, keyboard-operable details sections below the existing equity chart:

- **Source & reproducibility:** the recorded evidence grade, run/report IDs, schema and outcome, strategy version and entrypoint, complete source/input/data/result identifiers, engine and metric versions, parameters, starting cash, resource class, quote and rate version.
- **Execution assumptions:** recorded fidelity, fill timing, order types, position model, taker fee and slippage in basis points, and the recorded effects not modeled. The text distinguishes simulated trading costs from platform compute charges.
- **Data & quality:** recorded dataset/provider/license, inclusive UTC start and exclusive UTC end, expected and processed bars, and quality findings. A bounded first-50 preview points to the existing Report JSON download for the complete list.

All values come from the already-fetched immutable report, except the report ID and independently fetched receipt belonging to the current job. The helper never fetches the current catalog, saved strategy, or other reports to fill gaps. Hashes are labeled **recorded**, not newly recomputed or audited. The view does not establish the absence of overfitting, comprehensive quality checks, or real-market performance. Reports identifying `veyra-synthetic` always carry the full synthetic-development warning, even if recorded prose contains a partial disclaimer.

## Ownership and failure behavior

Before exposing performance, evidence, chart data, or exports, `VeyraReportEvidence.read` requires `report.run_id === job.id === active run ID` and a report ID. When recorded project-version, input-hash or dataset pins are present, they must agree with the fetched job. Present malformed pins fail closed. Missing legacy pins remain explicitly unrecorded.

The report must contain a readable metrics object and an ordered finite equity curve. Decimal/scientific-number forms are supported without accepting hex, binary, whitespace coercion, or impossible calendar dates. Count and percentage bounds, winning/closed relationships, completion/outcome consistency, and processed/total consistency are checked. Legacy omissions remain unavailable rather than being borrowed, computed, or labeled zero.

A rejected/unreadable report leaves the current job's independent receipt accessible and explains that performance is unavailable. A receipt-only result has no old equity heading, chart data, metrics, report details, or enabled report actions. Fresh run loads clear all prior report text and collapse details before awaiting the next job.

Run/poll/report/cancel/chart callbacks are scoped to the route generation, run view, user and organization. A late success or failure cannot replace a newer view. Deliberate artifact downloads remain valid across navigation, as before, but are not delivered after user/organization ownership changes, including while the blob is being read. Recorded-fills source loading has its own ownership-scoped error/finally handling and ignores repeated clicks while pending.

Percent profitable, history grouping, receipts, full-report/JSON/CSV downloads and recorded-fill chart navigation remain available. The legacy `metrics-v1.trade_count` is used as fills only for that metric version; a missing newer fill count is unavailable. Missing closed/winning counts do not render `undefined`.

## Verification

Final local verification on 2026-10-12:

- 424 checks passed across 17 pure-JavaScript/jsdom fixture files.
- Focused evidence/run-lifecycle coverage: 41 checks passed.
- `node --check apps/web/app.js` and `node --check apps/web/report-evidence.js` passed.
- Independent read-only review probes cover decimal compatibility/coercion, numeric bounds, Gregorian dates, malformed identity, synthetic disclaimer protection, inherited quality-label names, sparse legacy state, forced invalid exports, delayed downloads, and stale chart-source errors.

The fixture suites use a preinstalled jsdom dependency. The final broad pass explicitly excludes the existing test named `real Python canonical serialization and digest are accepted by saved and public snapshot views`, keeping the final pass entirely JavaScript. No browser, server, database, remote API, or strategy execution is needed for this slice.

Run the pure helper test:

```sh
node --test tests/e2e/report-evidence.mjs
```

Run the safe frontend fixture set with jsdom available in `NODE_PATH`:

```sh
node --test --test-concurrency=2 \
  --test-skip-pattern='real Python canonical serialization' \
  tests/e2e/approval-recovery-ui.mjs tests/e2e/backtest-approval-ui.mjs \
  tests/e2e/chart-research.mjs tests/e2e/chart-ui.mjs \
  tests/e2e/public-private-copy-ui.mjs tests/e2e/publications.mjs \
  tests/e2e/report-evidence.mjs tests/e2e/run-lifecycle-ui.mjs \
  tests/e2e/strategy-backup-ui.mjs tests/e2e/strategy-backup.mjs \
  tests/e2e/strategy-library-ui.mjs tests/e2e/strategy-settings-lifecycle-ui.mjs \
  tests/e2e/strategy-storage-ui.mjs tests/e2e/studio-assistant.mjs \
  tests/e2e/studio.mjs tests/e2e/version-history-ui.mjs tests/e2e/workspace-store.mjs
```

The parent integrator owns CI wiring; this slice does not modify CI. Add `node --test tests/e2e/report-evidence.mjs` to the intended aggregate check. Existing fixture loaders include the new helper, including the publication fixture's explicit startup sequence. `run-lifecycle-ui.mjs` holds the new integrated report tests.

## Limits

Browser screenshots/layout/native focus behavior, backend/database integration, full Python regression, and production/remote operation were not tested here. The details use existing colors/fonts, native `<details>` semantics, and scoped wrapping for full identifiers; actual rendering still needs browser QA. No backend endpoint, pricing rule, storage format, strategy execution, publication, security configuration, or dependency was changed. There are no commits or remote writes in this deliverable.
