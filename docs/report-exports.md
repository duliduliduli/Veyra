# Report export integrity

Report JSON remains canonical. Derived HTML/CSV generation does not change report
values, metrics, the report schema, or the result digest.

## Fill CSV

The columns remain, in order:

`ts,client_id,side,qty,price,fee,cash_after,position_after`

- Python's standard CSV writer quotes commas, quotation marks, and line breaks.
- Record separators remain LF, including the final newline. Empty and ordinary
  exports are byte-compatible with the previous output.
- Embedded CR, LF, and CRLF are preserved. Rows containing CR use full quoting
  because an LF-only CSV terminator would not otherwise quote a bare CR.
- Every fill is exported, even when the HTML preview is limited.

The engine prefixes client IDs with the numeric bar sequence (`7:example`). Valid
IDs containing formula-like text therefore remain prefixed text in one CSV cell;
quoting prevents their commas/newlines from creating additional cells/records.
Export does not prepend apostrophes, strip characters, or otherwise change values.
This is not a general spreadsheet sanitizer for arbitrary hand-crafted reports.
Use a CSV reader with newline preservation when exact embedded newlines matter.

## HTML preview

HTML displays at most the first 500 fills. With more than 500 fills, the existing
muted text style explicitly states how many are shown and the total, and points to
CSV/JSON for the full list. A 500-fill report is complete and has no truncation
notice. Text continues to be HTML-escaped. Historical `metrics-v1` reports keep the
existing fill-count fallback and unavailable closed-trade metrics.

## Verification boundary

`tests/test_report_exports.py` exercises actual engine intent validation and fill
creation with an in-memory notification sink; it does not launch strategy code,
workers, browsers, or a database. Coverage includes special IDs, exact CSV schema
and normal/empty bytes, mixed-record round trips, 500/501 preview boundaries,
HTML escaping, old metrics, and canonical JSON/digest/metrics non-mutation.
Existing stored report artifacts are not rewritten by this change. Spreadsheet-app
import behavior and visual browser rendering were not tested.
