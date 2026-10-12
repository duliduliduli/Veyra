# Saved Python version history

Studio's History dialog presents a private, read-only source view of saved revisions.
It uses the existing typography, colors, dialog, metadata and source-view styles.
Inspection does not execute, change, restore, delete or publish source. A separate
review and confirmation can copy a selected device version into a new private cloud
project, as described below; it never changes the original revision.

## Source and editor separation

- The device workspace already retains every saved version newest first. History
  reads that complete list without a 50-version cap or a new storage schema.
- Cloud history starts with 50 metadata rows and offers Load older versions.
  Existing project details and the editor's latest-version flow remain compatible.
- The server uses one shared validated source loader for private version reads,
  duplication, and public snapshots. It requires exactly files and entrypoint,
  strict source types and existing source limits, and verifies both the stored
  content hash and entrypoint before returning source. Missing, malformed, or
  changed objects return only a sanitized 503 snapshot unavailable response.
  Objects are never repaired or changed, and duplication fails before creating
  any new project when source validation fails.
- Selecting a revision fetches its immutable source by version number. The source
  response must match the selected version ID, project ID, number, content hash,
  entrypoint, and exact saved timestamp before display or download is enabled.
- Version number, ID, timestamp, entrypoint, hash, and file count are visible.
  Device versions explicitly say that a content hash was not recorded.
- Every file is listed and accessible through the read-only source selector,
  including nested paths and empty files. Source is rendered as text, never HTML.
- Opening History, selecting files/versions, pagination, downloads, failures,
  retries, and dismissal do not change the editor, saved revisions, or drafts.
- Close, Escape, and navigation invalidate pending history work immediately.
  Earlier page/selection responses cannot replace a newer selection or reopened
  dialog. A queued native close event cannot clear an already reopened dialog.

## Selected revision download

Download selected saved snapshot uses the existing strict portable backup format,
with all files and the selected entrypoint, and has_unsaved_changes set to false.
It exports directly from the saved file map, preserving CRLF and other exact
source text rather than reading a textarea. The filename includes the selected
version number; no source IDs, hash, revision history, or run history are embedded
in the portable backup.

Project name, description, and folder are fetched when History opens and shown in
a distinct Current project details section. They are explicitly current project
metadata, not historically versioned source metadata. The download includes those
displayed details. New saves and later metadata changes appear after reopening.

Unsupported older metadata or paths may fail existing strict backup validation.
The dialog shows the error and preserves the complete source for inspection; it
never truncates metadata or source to make an export pass. Downloaded source is
private and may contain secrets, so the UI warns to keep it private.

To use a selected revision as a separate strategy, the user can import its backup
through the existing Studio flow and choose a new name. That explicitly creates
a private device-local copy beginning at saved v1. History does not offer an
in-place restore, overwrite, deletion, or automatic copy.

## Compare a saved version with the current draft

After a verified saved snapshot loads, **Compare with current draft** opens a
read-only comparison within History. It works for device and cloud versions,
including older loaded pages. Comparison makes no service requests or storage
writes and never saves, applies, restores, validates or executes strategy source.

- The saved side is the selected immutable version. Its complete version ID,
  timestamp, hash and entrypoint remain in the existing identity block.
- The draft side is an exact copy of the current in-memory file map and entrypoint
  at the click, labeled **Current draft at comparison**, with the draft's base
  saved version and whether it includes unsaved edits. It is not read from a
  textarea or reloaded from storage. Even an unpersisted dirty draft can be reviewed.
- This is a capture, not a live view. File selection and whitespace toggles keep
  the same captured source. Clicking Compare again includes newer draft edits and
  keeps the selected comparison file when available. A separate in-flight save
  finishing cannot mutate the capture or newer editor edits.
- The file selector lists the union of both file maps, with Added file, Removed
  file, Modified or Unchanged labels and whole-snapshot file totals. A rename is
  shown as a removed and an added path; rename inference is intentionally omitted.
  Empty added/removed files are explicitly distinguished from absent files even
  when both have zero line additions/removals.
- Saved and draft entrypoints are always shown separately; changing only the
  entrypoint remains visible even when every source string is unchanged.
- The existing bounded proposal-diff helper supplies exact line tokens, contextual
  changes, whitespace markers, ending badges, source ending totals and full-source
  fallback. The same text-only line renderer and existing CSS now serve both views.
  Full source retains CRLF, CR, LF, Unicode and final-newline state; nothing is
  trimmed or truncated. Replacement-block fallback counts are not claimed to be a
  minimal diff. Whitespace-only changes are not a safety assertion.
- Keyboard-focusable full-source and diff regions have named headings and labels.
  Compare moves focus to the comparison heading. Whitespace toggles preserve an
  expanded full-source view. All rendering uses text nodes, including source that
  resembles HTML or scripts.
- Selecting another saved version immediately clears and disables comparison while
  source is loading. Source failure or mismatched metadata keeps it disabled.
  Pagination preserves the selected capture. Close, Escape, navigation and reopen
  clear captured source and invalidate stale asynchronous responses. Account,
  organization, project and route identity must still match for history responses
  or comparison actions to take effect.

The existing selected-snapshot download remains saved-source-only; a comparison
never adds unsaved draft files to that download or changes its backup format.

### Comparison verification

The history suite adds 21 comparison cases covering exact source and line endings,
Unicode whitespace, added/removed empty and nonempty files, rename and entrypoint
changes, repeated comparison, source/view selection, inert rendering, bounded
fallback, stale async responses, pagination, account/organization/project changes,
Close/Escape/reopen, storage failure and a separate pending save. Existing snapshot
identity-mismatch cases also assert that comparison stays disabled.

The explicit offline regression command passed 221 tests:

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test \
  tests/e2e/version-history-ui.mjs tests/e2e/proposal-diff-ui.mjs \
  tests/e2e/proposal-diff.mjs tests/e2e/studio-assistant.mjs \
  tests/e2e/studio.mjs tests/e2e/workspace-store.mjs \
  tests/e2e/strategy-storage-ui.mjs tests/e2e/strategy-backup-ui.mjs \
  tests/e2e/strategy-settings-lifecycle-ui.mjs tests/e2e/strategy-library-ui.mjs
```

No backend, endpoint, persistence schema, dependency or CI change is included.
No browser was launched, no strategy source was executed, and no upload or
publication was attempted. Native dialog layout/focus, actual screen-reader output
and authenticated live-server/object-store behavior remain unverified release gates.

## Cloud API

GET /v1/projects/{project_id}/versions is authenticated and uses the existing
ROLES_ALL membership rules, including owner, researcher, viewer, and billing_admin.
The server resolves the project's organization and checks membership before any
version listing. Nonmembers and missing projects both return 404.

- limit: integer from 1 through 100, default 50
- before_version: optional positive integer through 2147483647, exclusive
- versions: metadata only (id, version_no, content_hash, entrypoint, created_at),
  ordered by immutable version_no descending
- total_count: exact project-wide revision count at that request's SQL snapshot,
  including versions newer than the requested cursor
- has_more: determined by fetching limit + 1 rows
- next_before_version: last returned version number when another page exists,
  otherwise null

Count and bounded page are read in one SQL statement so concurrent saves cannot
make the returned count smaller than the current page. Project and organization
filters apply to both queries. No source object is fetched by the listing route.
Saves between requests do not shift the older-version cursor or repeat rows. The
UI labels its loaded count separately from the latest total and asks users to
reopen History for newer saves. POST versions and GET versions/{version_no} are
unchanged. No database migration, new role, authentication flow, or permission is
introduced.

## Verification and remaining gates

The new isolated jsdom suite covers 73 device revisions, cloud pagination beyond
50, concurrent-save continuation, exact CRLF/full-file downloads, unchanged
unsaved multi-file drafts, stale selections and dialog/page responses, retry
failures, metadata identity mismatch, text-only rendering, and unsupported legacy
backup values. Existing Studio, backup, sharing, and chart suites are run together.

Backend offline tests exercise authentication, read roles, bounds, tenant-filtered
queries, metadata-only output, and empty/terminal pages. Shared-source regressions
cover exact multi-file CRLF, unchanged successful response shapes, corrupted
hashes/entrypoints, malformed or missing objects, unknown metadata-injection
fields, strict types/limits, and safe duplication. The existing publication
loader import remains an alias of the shared loader. No backup-only path limit
is imposed on previously accepted saved sources. PostgreSQL tests for real
paging, tenant boundaries, compatibility, in-request concurrent insertion, and
source corruption/duplication are staged but not run. No database was connected, no browser was launched, and no
strategy source was executed. Native browser layout/focus and authenticated
PostgreSQL/object-store integration remain release verification gates.

## Deliberate device-to-cloud copy

Opening or browsing History remains read-only. A separate Review cloud copy action
for device versions can now show a verified destination and explicit confirmation.
Only that confirmation posts the exact selected saved version to a new private
cloud project, with workspace-member visibility disclosed. Existing source and
unsaved edits are untouched; copying does not run or publish a strategy. See
[the copy contract](reviewed-cloud-copy-contract.md) for lifecycle and uncertainty
limits. The copy’s navigation links confirm before discarding dirty edits whose
device recovery could not be stored. Native navigation remains unverified.
