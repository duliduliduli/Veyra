# Private Studio storage

Studio has two separate private libraries. The Storage selector chooses **Cloud
workspace** or **This device**. Connecting an account defaults a fresh `#code`
visit to cloud, but does not upload, copy, migrate or merge device strategies.
Without an authenticated workspace, the device library is selected and cloud is
disabled, including when opening a cloud-library URL directly.

- `#code/cloud` and `#code/device` retain an explicit library context. The editor's
  All strategies link and the Studio tab return to the opened project's store.
- Imported strategy snapshots always become new private device copies, including
  while cloud is selected. Returning from the imported editor opens This device.
- The create button names its destination and uses that selected store. Device
  creation with a connected account uses only the existing local store and lock.
- Search, folders and Refresh operate on the selected library. Switching stores
  clears the filters; refreshing the same store retains them. Cloud paging still
  uses bounded pages, deduplication, cursor validation and visit/account guards.
- Leaving a pending local write before its lock is acquired cancels that queued
  creation. An already-written local copy or already-sent cloud request may still
  complete. Its late response cannot change another library, reset a newer create
  form, show a stale error or redirect a newer visit. Refresh the original store
  to check an already-sent cloud creation before retrying it.

The device library remains browser-local, with no automatic cloud backup. Existing device
execution and public-sharing restrictions are unchanged. No backend, identity,
permissions, storage schema, security configuration or API contract changes are
part of this UI change.

## Offline checks

With the existing jsdom installation:

```bash
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test \
  tests/e2e/strategy-storage-ui.mjs \
  tests/e2e/strategy-library-ui.mjs \
  tests/e2e/strategy-backup-ui.mjs \
  tests/e2e/studio.mjs \
  tests/e2e/version-history-ui.mjs \
  tests/e2e/publications.mjs \
  tests/e2e/run-lifecycle-ui.mjs \
  tests/e2e/chart-ui.mjs
node --check apps/web/app.js
```

These checks use synthetic source as inert text, mocked APIs, synthetic storage
and Web Locks. They do not launch a browser, run strategy source, connect to a
database or write to real APIs. Native select/dialog behavior, visual layout,
real storage permissions and authenticated cloud integration still need separately
authorized QA. CI configuration is unchanged; include the new named storage suite
in release verification. No source publication or deployment is included.

## Explicit saved-version cloud copies

Connecting an account still never uploads device source automatically. From a
device strategy’s History, Review cloud copy shows the selected saved version,
all files, entrypoint, current metadata and verified destination account/workspace.
Only a separate confirmation sends that exact saved source to the existing project
creation API. The new private workspace copy starts at v1; its workspace members
can read it. The original device source, versions and drafts remain unchanged.
No run or public link is created. See [the copy contract](reviewed-cloud-copy-contract.md)
for stale-context, pending/unknown outcome and navigation safeguards. Production
identity remains a separate integration gate.
