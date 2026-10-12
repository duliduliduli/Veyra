# Reviewed device-to-cloud strategy copy

A saved private device strategy, including an imported snapshot or a public snapshot
previously copied to the device, can be copied through **History → select a saved
version → Review cloud copy → Confirm private cloud copy**. This is a source-only
operation using the existing `POST /v1/orgs/{org}/projects`; there is no backend,
schema, authentication or execution change.

## Review and payload

- The existing saved-history preview supplies the exact version identity, entrypoint,
  complete file list and selectable read-only source for every file. No source is
  sent by opening History, changing selections, comparing, downloading or reviewing.
- Review reads `/v1/me` and shows the actual destination subject, user ID, workspace
  name and workspace ID. Only `owner`/`researcher` membership enables confirmation;
  the server still authorizes the POST if membership changes afterward. Disconnected
  users see an explanation, and cloud-source history does not offer this device-copy
  action. There is no new workspace picker or automatic account/workspace creation.
- Private cloud copies are readable by destination workspace members. The review
  states this explicitly; private does not mean account-only visibility.
- The user can choose a new name. Description and folder are current project metadata
  loaded when History opened, not historical source metadata. Cloud folder whitespace
  is collapsed to single spaces as required by the existing API and displayed before
  confirmation; an empty folder becomes `null`.
- The portable snapshot validator checks source paths, UTF-8, file count/byte limits
  and metadata. Its conservative limits apply (50 files, 256 KiB, 256-character ASCII
  paths, 120-character names, 2,000-character descriptions, 80-character folders).
  Unsupported legacy values must be fixed or backed up separately, never silently
  truncated. Additional outer Unicode whitespace that the cloud would trim is rejected.
- The request includes only reviewed name, description, folder, all exact source
  strings, entrypoint, `visibility: "private"`, and `template: null`. CRLF, lone CR,
  tabs, Unicode, empty files and final-newline state are preserved. No device IDs,
  original/public provenance, account credentials in the body, earlier history,
  unsaved drafts, run results or publication settings are transferred.
- Immediately before sending, a local read rechecks the saved version identity,
  complete source and project metadata against the review. A newer saved version
  does not replace the explicitly reviewed older one.

## Ownership and outcomes

The active history visit, user, workspace, route generation, project object, selected
version and review identity must still match. A changed/closed review cannot send,
repopulate a newer review, redirect, clear drafts or overwrite newer inputs. Source
browsing remains read-only; confirmation never saves or alters the device strategy.

The expected creation response is a new private cloud project in the reviewed
workspace with matching metadata, `created_by` matching the retained reviewed
`/v1/me.user_id`, and a valid saved-v1 identity/entrypoint/hash.
Success leaves the editor and drafts open and unchanged, and offers an explicit
link to the new cloud project. Users may then choose the existing backtest or share
paths. The copy workflow never runs source, requests a quote/job, incurs compute
charges, publishes a link or automatically navigates away from unsaved work.
Both new navigation links ask before leaving dirty edits whose device persistence
failed. Cancel preserves the original source, selected version, review and link
destination. Explicitly acknowledged navigation may proceed. Modified/new-tab
activation keeps native link behavior without clearing the original editor.

The confirmation is disabled synchronously. An in-memory attempt record also blocks
a second submission for the same user/workspace/device-version while its request is
pending, including across closed/reopened reviews. Closing, cancellation, Back or
navigation do not cancel an already-sent request, and the UI says so.

There is no server idempotency contract and no automatic retry or rename. Explicit
4xx rejections (except 408) remain errors, including name conflicts and lost write
permission. Transport errors, 408, 5xx, unreadable JSON and invalid success responses
are **unknown outcomes**, not proof of failure. Inspect Cloud workspace before
another copy; it may already exist. The current-page guard survives review dismissal.
After checking, a separate acknowledgement starts a fresh review without sending;
a further explicit confirmation is still required. These in-memory guards cannot
provide cross-tab/reload deduplication or exactly-once creation.

## Source-only verification

`tests/e2e/reviewed-cloud-copy-ui.mjs` uses jsdom, inert source strings and intercepted
APIs. It covers payload/privacy boundaries, role/identity failures, unchanged drafts,
invalid data, pre-send local rechecks, stale contexts, dismissal/reopening, double
submits, rejected requests and ambiguous outcomes. Run with the preinstalled jsdom
path, explicitly naming this suite. No Python, backend, database, live API, browser,
server, strategy execution, source transmission or publication is part of these tests.
Native modal focus/layout, real authentication, backend/object-store round trips and
cross-tab behavior still require separately authorized integration QA.
