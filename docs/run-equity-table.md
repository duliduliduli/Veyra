# Recorded equity table

The run report now includes a collapsed native **Equity values** details section beside its other recorded-evidence sections. It uses the same fetched, validated report as the existing chart. No new API request, data source, metric computation, export, execution or persistence is added.

## Data and display contract

- `VeyraReportEvidence.read` adds `equityRows` during the existing validated equity-point pass. Each row contains the original timestamp string and `String(recordedValue)`; its separate `equity` chart projection is unchanged.
- Recorded numeric strings remain exact, including decimal precision, trailing zeroes, exponent spelling and negative zero (`"-0"`). Legacy JSON numbers are displayed from their already-parsed JavaScript value. Original numeric-token formatting or precision cannot generally be recovered from parsed JSON; `String(value)` also normalizes a parsed numeric `-0` to `0`. The UI explicitly distinguishes exact strings from parsed numeric values.
- Values are labeled **quote units**. No currency is inferred from the selected chart or current catalog, and no performance is recomputed.
- Timestamp strings with a time/offset are displayed in UTC, retaining the recorded zero, one, two or three fractional-second digits. Date-only strings stay dates and explicitly say **date only**, without inventing a time of day. Existing timestamp validation and second-level chart ordering are unchanged.
- Each page renders at most 50 rows, with global row numbers and explicit visible-row/total-row and page/total-page counts. Every validated row remains reachable with native Previous page and Next page buttons; out-of-bounds page requests are ignored.
- Native details/summary, table/caption, column and row headers, a polite page-status announcement, and native buttons preserve keyboard and assistive-technology semantics. Opening/closing does not reset the selected page or fetch data. The section starts collapsed for each run visit.
- Empty validated curves show **No equity values were recorded in this report (0 rows)**. Legacy unknown-completion and incomplete-run caveats remain visible. A missing/malformed curve still rejects the report; it is not converted to an empty success.

## Ownership and clearing

Table rows and page belong to the existing run view. Rendering and paging require its current route generation, run ID, account and organization. Fresh run loads, leaving the run route, and account disconnect clear report data, table rows/counts, page controls and expansion. A stale page action fails closed. Late report success/failure cannot repopulate a departed or replaced view, including a same-URL revisit. Invalid reports and receipt-only runs retain the independent current-job receipt without old performance data.

The existing deliberate-download behavior and recorded-fills chart handoff remain unchanged. The chart handoff captures and validates its report before navigating; clearing the departed run does not remove its selected overlay.

## Verification

Final selected JavaScript/jsdom verification: **105 checks passed, 0 failed, 0 skipped** across:

- `tests/e2e/report-evidence.mjs` (18)
- `tests/e2e/run-lifecycle-ui.mjs` (32)
- `tests/e2e/chart-ui.mjs` (33)
- `tests/e2e/browser-storage-access-ui.mjs` (22)

The first two suites include nine new tests covering exact strings, unchanged chart values and validation, UTC precision, complete forward/backward paging and boundaries, native semantic/focus properties, empty/legacy/incomplete states, stale runs/accounts, repeated navigation and synchronous signout clearing. Existing tests also cover invalid-report clearing, stale same-URL responses, and the recorded-fills chart handoff.

Run only these explicitly selected JS-only suites with the preinstalled jsdom dependency:

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test \
  tests/e2e/report-evidence.mjs tests/e2e/run-lifecycle-ui.mjs \
  tests/e2e/chart-ui.mjs tests/e2e/browser-storage-access-ui.mjs
```

Syntax checks of both changed JavaScript sources and both changed tests also passed. No dependency, backend, service, credential, network, database or publication change is included. Native browser layout, actual keyboard/assistive-technology operation, Python/backend integration and production execution remain unverified; jsdom verifies semantics and focus properties, not real browser input behavior. No browser, server or socket listener was launched, and no Python strategy or backend tests ran.
