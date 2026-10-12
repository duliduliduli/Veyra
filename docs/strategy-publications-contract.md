# Explicit strategy publications: backend candidate

This candidate adds a deliberately public, immutable view of one saved cloud-project version. It does not change private project visibility, publish any existing project, enable authentication, or expose existing snapshots without confirmation. Migration `0003_strategy_publications.sql` creates an empty table and guards; there is no backfill or public seed. The router is mounted in the local integration candidate; deployment is still pending.

## Scope and integration touchpoints

- New `services/control-api/src/veyra_api/api_publications.py` exports `router` with `/v1` prefix.
- New additive migration `0003_strategy_publications.sql` follows the existing private-organization migration `0002`. The existing migration loader discovers it automatically.
- `tests/test_publications.py` exercises the integrated application for database tests and isolated fixtures for pure boundary tests.
- No packages, environment variables, authentication, credentials, object-store APIs, existing project routes, or existing migrations change.
- The new router is included before the static `/` mount. Existing authenticated principal and owner-role checks remain intact. Production identity is still intentionally fail-closed.
- The app now sets `no-store` for all `/v1/` responses, including private project/version endpoints, and removes cache validators. The new router independently sets `Cache-Control: no-store` on its content/state responses and 401/403/404/405/409/422/503 errors. Unexpected pre-response failures are logged internally and return a generic 500 with `no-store`.

## Owner routes

All owner routes use the resource's actual workspace. The caller must currently have its `owner` role. A nonmember receives 404; a member with another role receives 403; missing authentication receives 401. Roles are checked again on retries and soft revocation. Ownership means workspace ownership, not necessarily the original project or publication author.

### POST `/v1/projects/{project_id}/publications`

Required JSON fields, with additional fields forbidden:

- `project_version_id`: exact saved-version UUID belonging to this project and workspace; never `latest`, a version number, or unsaved local contents.
- `title`: explicitly chosen public text, 1–120 characters, trimmed; nonempty and no control characters.
- `description`: explicitly chosen public text, at most 4,000 characters, trimmed; an explicit empty string is allowed. There is no inherited/default private description.
- `confirm_public`: the JSON boolean `true`. Omission, false, numbers, and strings are rejected.

Required `Idempotency-Key` header: 8–128 ASCII letters, digits, underscores, or hyphens. A fresh UUID is suitable. Persist the same key for retries of the same confirmation.

201 returns the lifecycle receipt described below. A repeat of the same normalized version/title/description under the same workspace and key returns 200 and the same publication ID. Conflicting key reuse returns 409. Concurrent requests serialize through the unique constraint. Different workspaces may use the same key independently.

A replay after soft revocation returns that original receipt with `status: revoked`; it never reactivates the link. A new explicit publication requires a new key and gets a new public UUID. Changing metadata or choosing another version also requires a new publication; there is no PATCH or payload update endpoint. Unknown or wrong-project/tenant version IDs return 404.

Before creation, the exact source object is loaded, validated against existing 50-file and 256 KiB UTF-8 aggregate limits, and checked against its hash and entrypoint. Missing, malformed, over-limit, or changed objects fail closed with 503 and no publication created.

### GET `/v1/projects/{project_id}/publications`

Returns `{"publications": [receipt, ...], "has_more": true|false, "next_cursor": string|null}` including active and revoked snapshots. This is an owner-only control view, not a private-source read permission for others.

- `limit`: 1–100, default 20.
- `cursor`: optional opaque string, maximum 512 characters. Pass the previous response's `next_cursor` unchanged to continue. Malformed cursors return 422 with `no-store`.
- Ordering is descending `(published_at, id)` with a strict keyset boundary. Tied timestamps use UUID ordering, so pagination does not duplicate or skip existing rows. Soft revocation does not change this immutable order.
- `has_more` is true only when another row exists beyond this page; only then is `next_cursor` non-null. Continue until `has_more` is false to reach older active links even when newer receipts are all revoked.
- Newer publications inserted between pages appear on a fresh first-page request; they do not shift the continuing sequence. This is not a historical status snapshot: a receipt's current revocation state is read for each page.
- A cursor is a sort boundary, not an access token. Every page rechecks the current owner role and includes the requested project and its actual tenant in SQL. Reusing a cursor across projects cannot return another project's rows.
- The UI must expose continuation and append pages; it must not treat the initial page as the complete active-link list.

### DELETE `/v1/publications/{publication_id}`

Soft-revokes a publication and returns its receipt with `status: revoked` and a server timestamp. The audit record and immutable snapshot reference remain. Repeated revocation returns the same receipt. The same workspace's current owners may revoke; owners of unrelated workspaces receive 404. A revoked UUID is never reactivated or reused.

### Lifecycle receipt fields

`id`, `public_path`, `title`, `description`, `content_hash`, `entrypoint`, `published_at`, `project_version_id`, `version_no`, `status` (`published` or `revoked`), `revoked_at` (timestamp or null).

The receipt contains no workspace, author, email, object-store path, idempotency key, private folder, or private project description. `public_path` is a relative API path, not an assumed deployed web-page URL.

## Anonymous routes

### GET `/v1/public/strategies/{publication_id}`

For an active publication only, returns this exact allowlist:

`id`, `public_path`, `title`, `description`, `content_hash`, `entrypoint`, `published_at`, `files` (a filename-to-source-string object).

The public version exposes **all files of the exact explicitly selected snapshot**. It does not expose source project/version IDs, version numbers, tenant/author identity, folder, object-store key, or other private project metadata. Deliberately selected code and filenames may themselves contain sensitive text; this feature does not promise sanitization or secret detection.

Missing and revoked links are indistinguishable 404s, including for the owner on this public route. Public reads require no sign-in but always recheck the publication row and pinned content identity. The publication row stores only its chosen public metadata and immutable-version reference; it does not duplicate private code into a public object-store area or expose an object URL.

The API holds a publication row lock through the content read so that revocation serializes with concurrent reads. Requests already served or in flight before revocation can have received the previous public snapshot. Once revocation completes, subsequent direct requests and discovery/search requests exclude it. `no-store` prevents normal client/proxy response caching; previously downloaded or copied content cannot be recalled.

### GET `/v1/public/strategies?q=&limit=&offset=`

Returns `{"strategies": [metadata, ...]}`, newest first. Each result has the same allowlist as direct read **without `files`**. Only active rows qualify. No private project/version table contents or user information are searched.

- `q`: case-insensitive literal substring of the chosen public title or description, trimmed; maximum 120 characters, no control characters. SQL wildcard characters are escaped.
- `limit`: 1–100, default 20.
- `offset`: 0–10,000, default 0.

This intentionally small implementation scans the chosen text fields; no search service or cached index is introduced. New requests consult current publication state. Corrupted/missing source objects make source reads unavailable but do not mutate the selected public title/description or silently switch to a newer source version.

## UI requirements before enabling

- Distinguish local-only, private cloud projects, and independently published snapshots. A private project remains private even if a chosen historical version has a public snapshot.
- Show the exact selected saved revision and all files being shared. Explain that all source files, chosen title, and chosen description become readable and discoverable by anyone. Show a deliberate Publish confirmation; do not prefill confirmation or trigger it from Save, navigation, import, or project creation.
- Require explicit public title/description selection; avoid copying private folder, project notes, account email, or local state into a publication request automatically.
- Treat `revoked` replay receipts as revoked. Never claim a retry republished them. Publishing changed content or metadata creates a new link after a new confirmation.
- Render public text/code as text. Do not execute source code or render it as HTML. Do not cache public-source or lifecycle responses in the application/service worker, and do not put them into public static build assets.
- Explain that Unpublish removes platform access and discovery but cannot recall third-party copies. Do not label it permanent data deletion.

## Verification

Local focused checks cover strict input/confirmation, metadata allowlists, content hashes, malformed/changed source, file limits, title-only/description-only discovery SQL, literal search escaping, and no-store success/error responses. The Postgres suite additionally covers exact archived-version immutability after later edits, role/tenant boundaries, ownership changes, no duplicate object copies, discovery/private-metadata isolation, retry/revocation lifecycle, barrier-forced duplicate/conflicting inserts, a row-lock-observed read/revoke race, more than 100 mixed active/revoked receipts with tied timestamps and intervening inserts, cross-project cursor isolation and role rechecks, DB-level immutability, missing storage, and empty additive migration behavior.

Run with the repository's normal environment:

`uv run ruff check services/control-api/src/veyra_api/api_publications.py tests/test_publications.py`

`uv run pytest tests/test_publications.py`

The full publication suite requires the existing PostgreSQL test fixture. No migration, API publication, credentials, public seed, or remote/production write was performed for this candidate.
