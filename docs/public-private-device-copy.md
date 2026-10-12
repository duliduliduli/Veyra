# Copy a published strategy to a private device workspace

The public snapshot viewer offers **Copy to device**. This is a local-only fork of
one immutable published source snapshot, not a cloud duplication or a publication.

## Review and boundaries

- An anonymous, uncached GET rechecks the currently viewed publication before the
  review opens its preview. No cookie or developer identity header is sent.
- The review pins publication ID, public title, publication date, content hash,
  entrypoint and every filename. It shows the exact source byte count.
- The public title supplies a default private name. The user can choose a fresh
  name; an existing local name produces a retryable conflict, never an overwrite.
  Source validation is independent of the name: a public title with 120 emoji can
  exceed the local 120 UTF-16-unit limit but stays visible in full, and the user can
  choose a shorter private name. A title that a single-line input cannot preserve
  leaves that input blank with an explicit explanation; the public title remains
  unchanged in the review.
- Description and folder start blank. This is disclosed rather than truncating a
  public description (which can be longer than local metadata limits). Source
  license notices and headers are preserved, not interpreted or removed.
- The existing portable-snapshot validator rejects unsupported names, paths,
  malformed UTF-8 source, excessive source size or excessive files without
  truncating. Limits are 50 Python files, 256 ASCII bytes per path, 256 KiB total
  UTF-8 source, and 120 UTF-16 units for the private name. Files must use supported relative
  Python paths. CRLF, lone CR, Unicode, empty files and the entrypoint are copied
  unchanged when supported.
- Clicking **Create private device copy** performs another anonymous read and
  checks all pinned identity fields and source strings. A revoked/unavailable,
  changed or failed response makes no copy. A retry performs a new read.
- After that read, the existing `veyra.workspace.v1` Web Lock serializes the one
  synchronous, atomic local store write. No network request holds the shared
  workspace lock, so a slow public read cannot block unrelated local saves.
- Exact route, route generation, public request/snapshot, source selection, review
  identity, current user/organization and submitted name are checked before the read, after the read, and
  inside the lock. Cancellation, public refresh, newer navigation, changed
  selection, account context and a replaced review invalidate queued work. Double submission is
  suppressed. Late completion cannot redirect a newer review.
- Availability is known as of the last successful read. The server and browser
  storage do not share a transaction: revocation after that response cannot
  retract delivered bytes or saved copies, including while waiting for the local
  lock. Cancelling after the synchronous storage write likewise cannot undo a
  copy already written; it does suppress stale UI completion.

## Result

One new private strategy starts at local saved v1, with a fresh local identity.
Every source string and the entrypoint are unchanged. Existing versions and drafts
are untouched. The editor and library links select the device workspace even if a
cloud account is connected. No POST, PATCH, publication, upload, strategy execution,
backtest, charge or migration is part of this flow. History and performance results
are not copied. Copying source neither verifies performance nor grants licensing or
trading permission. Browser storage has no cloud backup and can be cleared by the
browser; portable backup export remains available from the private editor.

The existing public `{files, entrypoint}` JSON payload and filename are unchanged.
Its button is now labeled **Download source JSON** to distinguish it from the full
portable Studio backup. There is no second overlapping download action.

## Offline checks

Run from the repository root:

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/public-private-copy-ui.mjs
```

The named jsdom tests use synthetic API fixtures and local storage only. They cover
anonymous/device and connected-account copies; complete source, CRLF, licensing
headers and entrypoint fidelity; blank metadata; raw download compatibility;
unsafe HTML; unsupported limits and renameable public titles; recheck revocation/identity mismatch; local name
conflict, storage failure, corrupted store and missing locks; network failure;
close/cancel/Escape/navigation; stale success/error and native close; duplicate
submit; queued cancellation; exact guards; account-context changes and fresh reviews; late completion; and cross-tab races.

Native browser modal focus/history, phone layout and real storage quota behavior
still require separately authorized browser QA. No real public or private source,
accounts, databases or strategy runtimes are accessed by these tests.
