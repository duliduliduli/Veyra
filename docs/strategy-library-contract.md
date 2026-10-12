# Strategy library pagination

## Private project API

GET `/v1/orgs/{org_id}/projects` returns the existing project metadata list plus a
bounded pagination envelope:

```json
{"projects": [], "has_more": false, "next_cursor": null}
```

- `limit` defaults to 100 and accepts integers from 1 through 100.
- `cursor` is optional and at most 512 characters. Pass the previous response's
  `next_cursor` unchanged. Malformed base64/JSON, invalid timestamps or UUIDs, and
  timestamps without a timezone return 422 for an authorized member.
- Order is descending `(updated_at, id)`, with UUID ordering breaking timestamp
  ties and a strict keyset boundary. The query reads at most `limit + 1` rows and
  returns at most `limit` rows. There is no offset or hidden 100-project cutoff.
- `has_more` is true only when the query finds another row beyond the returned
  page. Only then is `next_cursor` non-null, encoding the last returned row's
  `(updated_at, id)`. Empty and terminal pages return false/null.
- Every page authenticates and checks the caller's current organization
  membership and read role (owner, researcher, billing admin, or viewer). The SQL
  always scopes the page to the requested organization. A cursor is a boundary,
  not an access token; reusing another tenant's cursor cannot expose that tenant.
- Rows retain `id`, `name`, `description`, `folder`, `visibility`, `created_at`,
  `updated_at`, `latest_version_id`, and `latest_version_no`. Listing reads
  metadata only, never source objects. The existing organization/update index
  supplies the ordering; no schema or permissions change is needed.

## Live ordering and refresh

Pages are live reads, not one immutable snapshot. Tied timestamps do not duplicate
or skip unchanged rows. New projects and edits/saves that move a project ahead of
the current boundary are discovered by starting again without a cursor. In
particular, an unseen project edited while paging can move above the boundary and
be absent from the remaining pages. An already-returned project edited later does
not repeat in the older pages. A terminal page means no more rows below that
boundary at read time; it does not promise a current organization-wide total.

Clients should keep loaded counts honest and provide a fresh-list/refresh path.

## Verification

`tests/test_project_library.py` has offline HTTP/SQL-contract coverage for query
bounds, malformed and timezone-aware cursors, the default 100-row page and terminal
pages, metadata compatibility, strict tuple ordering, tenant query parameters,
authentication, all read roles, and membership rechecks on later pages.

PostgreSQL cases are staged for 135 projects with tied timestamps, a new project
between pages, latest-version metadata, metadata-only reads, cross-tenant cursor
reuse, membership removal, and edits/saves moving projects ahead of the boundary.
They require the normal isolated test database and are not part of offline runs.

## Studio library

Studio automatically follows each bounded metadata page, without a project-count
cutoff. The existing first request remains `/v1/orgs/{org_id}/projects`; later
requests pass the returned cursor with URL encoding. No source files are fetched.
Loaded IDs are deduplicated, keeping the first metadata seen for each project.

- The scope line reports unique strategies loaded and the number shown by the
  current name/description search and folder filter. Filters operate only on
  loaded metadata. While paging, new folders and matches appear progressively;
  zero matches is not presented as an empty or fully searched library.
- All pages loaded means the server returned a terminal page, not that the list
  is an immutable snapshot or an exact current organization total. A visible
  note explains that changes during loading may require Refresh. Refresh and
  reopening Studio restart at the first page and clear the prior rows/counts.
- Refresh is disabled during a load. An initial or later read failure reports an
  incomplete list and an explicit retry path. Later-page failures preserve the
  previously loaded rows for search and inspection; Refresh restarts the scan.
- A chosen folder is preserved while later pages might still contain it. Empty
  folders are removed after a successful terminal response, as before.
- Each request chain belongs to its specific route visit, URL, account/workspace
  identity and load generation. Leaving, revisiting or refreshing invalidates
  stale responses and errors; abandoned chains cannot start subsequent pages or
  enable the current load's Refresh button. An already-sent read is not aborted.
- Missing/malformed page metadata, oversized pages, cursor loops and continuing
  pages that add no unique IDs fail visibly. Old API servers without pagination
  metadata must be upgraded with the client; their first 100 rows are never
  silently presented as a complete library.
- Device-local workspaces retain their complete existing list behavior, local
  storage format, search/folders and source safeguards. Reading or refreshing
  them performs no cloud project requests and does not change local storage.

`tests/e2e/strategy-library-ui.mjs` uses synthetic responses in jsdom: 237 cloud
projects, 105 local projects, late folders and the oldest strategy, partial/empty
loads, failures and fresh retries, deduplication, malformed/repeated pages,
repeated clicks, workspace changes and interrupted/same-URL navigation.
Existing Studio, sharing, backup, history, run and chart fixtures mirror the
additive page envelope. CI explicitly invokes the new suite.

No editor, file management, saved history, publication, backup, execution,
billing, authentication, schema or visual theme behavior is changed. Real browser
layout/accessibility behavior and live PostgreSQL/API integration remain separate
release gates. Metadata loading and DOM filtering scale with the whole library;
for substantially larger libraries, consider server-side search and a virtualized
list instead of introducing an undisclosed client cap.
