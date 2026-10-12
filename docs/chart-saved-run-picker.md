# Saved backtests in the chart Strategy dialog

The chart-local Strategy dialog can read existing workspace runs and display a
chosen report's recorded simulation fills. It keeps local report-file import and
the separate Backtest history link. No new execution or signal generation exists.

## Read contract

- Opening or refreshing the dialog reads `GET /v1/orgs/{org}/jobs?limit=25`.
  Older pages require an explicit button press. At most 20 pages / 500 rows are
  retained per dialog session; there is no background traversal or polling.
- Loaded rows are grouped by strategy, then UTC creation date, newest first.
  Ordering preserves the jobs API's six-digit microseconds, with run ID as the
  equal-timestamp tiebreaker. Labels preserve the recorded creation timestamp;
  it is not presented as a report-save or completion time.
- Page shape, IDs, bounded labels, dates, statuses and cursor consistency are
  checked before appending. Duplicate run IDs, repeated cursors, empty advancing
  pages and malformed pages stop paging without changing existing rows. A
  transient read failure permits explicit retry; access failures clear the list.
- Only a deliberate enabled row choice reads `GET /v1/jobs/{id}`, then its pinned
  `GET /v1/reports/{report_id}/artifacts/report.json`, and the matching catalog
  dataset's bars if not already cached. No report is fetched just to render rows.
- Missing/unsettled reports, unsupported assets and missing recorded ranges are
  visible but unavailable. Legacy, missing, malformed or inconsistent artifacts
  fail visibly without replacing the current chart or overlay.

## Validation and ownership

The selected history row must match the fetched job's organization, run/report
IDs, saved version, outcome, creation timestamp and recorded configuration.
`VeyraReportEvidence.read` checks report/run identity and recorded input pins;
version number and date range must also match. The existing strict schema-v1
`VeyraChartResearch.validateReportJSON` checks supported synthetic daily data,
execution model, fill positions, source bars and both full/subset data hashes.
No performance metric is recomputed.

The current chart/overlay remains visible while a replacement loads and validates.
A validated selection commits its matching supported synthetic asset and fills
synchronously, preserving the selected interval, visible range and chart style.
The displayed version, run, creation timestamp, range and data source identify
what was selected. Recorded fill claims remain unverified; synthetic data is not
market history, live trading or evidence of real-world performance.

Dialog session, account, organization, route generation, asset-load generation
and shared overlay-selection generation own asynchronous completions. Close,
Escape, reopen, route changes, refresh, asset switches, newer rows, file imports
and clearing invalidate older selections. Late success or failure cannot replace
a newer chart, overlay or status. File imports retain their existing validation
and gain matching account/organization/route ownership guards. A separate saved-run
selection generation plus continued row membership invalidates pending saved
selections after history access denial, without cancelling a newer file import.

## Source-only verification

Named JS-only checks use synthetic fixtures and mocked APIs:
`tests/e2e/saved-chart-runs.mjs`, `tests/e2e/chart-ui.mjs`,
`tests/e2e/chart-research.mjs`, `tests/e2e/report-evidence.mjs`, and
`tests/e2e/run-lifecycle-ui.mjs`.

No real browser/server/socket, Python strategy execution, database/service/network
calls, installs or publication were used. jsdom stubs native dialog behavior and
chart rendering; existing vendored chart tests exercise scheduling without a
browser. Responsive layout, native focus trapping and live authenticated service
behavior still require separate browser/integration verification.
