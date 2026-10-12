# Strategy settings lifecycle

Settings still update only private project name, description and folder through the existing metadata validators, device workspace lock or authenticated project PATCH. They do not save a source version, change source/drafts/entrypoint, migrate storage, publish or execute a strategy.

## Ownership and ordering

- Each opening belongs to its exact project object, route generation, project URL, account and organization. Opening or submitting off-route, with a closed dialog, or while its save is pending does nothing.
- Save captures the three reviewed metadata values. Inputs and Save stay disabled during that visit's request; Close and Escape remain available.
- Close, Escape and routing invalidate the visit immediately. A late success, error or cleanup cannot rename a new project, close a reopened dialog, overwrite its status or enable its controls. A queued native close event cannot clear an already reopened dialog.
- Each project has its own in-tab write queue across dialog visits, including leave/revisit. A newer submitted save waits for the earlier request to settle before sending, so successful requests for that project cannot overlap within this tab. Different projects do not block one another. Duplicate submit events do not enqueue extra writes.
- A queued save checks its visit again before sending. Device saves also check inside the exclusive Web Lock before changing storage. Closing, navigating or changing accounts discards a save that has not begun its write.
- If a cloud request has a transport, unknown, timeout or server-error outcome, a queued successor is not sent automatically. That uncertainty propagates past dismissed intermediate visits. The current dialog retains its values, restores controls and warns that a separate explicit retry could race the unconfirmed server write. Known validation/authentication rejection does not block a separately submitted successor.
- Closing cannot retract an already-sent cloud write. The dialog says so. A dismissed request's result is not applied to the newer editor; a fresh strategy read can inspect currently persisted metadata but does not prove that an earlier write has finished. In-tab ordering does not provide cross-tab/server concurrency control or prove the outcome of a failed connection.
- Errors remain in the current dialog's accessible status, retain entered values and restore controls for a retry. Reopening clears the old dialog status. Only a current successful save closes the dialog and announces success.

## Offline verification

Run from the repository root with an existing external jsdom installation:

```sh
NODE_PATH=/path/to/jsdom/node_modules node --test tests/e2e/strategy-settings-lifecycle-ui.mjs
node --check apps/web/app.js
```

The 25 synthetic DOM checks cover delayed saves; dismiss/reopen; immediate and completed routing; account and organization drift; queued native close events; Escape; missing submitter; duplicate clicks; error/retry; per-project serialization and cancellation; unknown cloud outcomes and explicit retry; native name constraints; local name/folder rejection; metadata-only authenticated payloads; exact saved/draft source preservation; missing Web Locks; and device writes waiting on a lock. All fetches are fixture responses and no strategy is executed. Native dialog focus, real-browser rendering and live server/database behavior are not verified by this suite.
