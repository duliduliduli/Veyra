# Unpersisted editor navigation

The shared `route()` boundary asks for explicit discard before replacing an editor
whose complete source differs from its saved version and whose latest draft write
failed (`projectDirty(project) && !project.draftStored`). The check precedes route
invalidation, project replacement, dialog dismissal and view changes. It also
protects an explicit same-project `route()` reload. It neither retries storage nor
claims that a failed write, an older draft or a downloaded file is a successful
backup of the current edits. Clean source and stored drafts gain no prompt.

Cancelling retains the same project and review objects, every source string and
file-map change, entrypoint, selected file, textarea selection, open dialogs,
unsubmitted review fields, route generation, actor identity and active URL.

- Ordinary same-document links ask before changing the URL. Approved navigation
  pushes one history entry and invokes the existing router once. The two cloud-copy
  links retain their precise current-review guards and use this same confirmation.
- Modified clicks, middle clicks, other-window targets and downloads keep native
  behavior. Same-hash links remain native no-ops. Full-document departures use the
  native unload mechanism rather than a duplicate in-app confirmation.
- Programmatic hash changes and same-document Back/Forward reach the same boundary.
  The URL can change briefly before `hashchange` runs. Cancellation uses
  `history.replaceState` to restore the active editor URL and its history state in
  the **currently traversed entry**. It does not undo the browser's history index,
  restore a replaced destination entry or remove a newly created hash entry.
  Duplicate editor URLs can therefore remain in Back/Forward history. Repeated
  attempts, stale queued events and same-URL traversal do not clear the editor or
  consume another approval. An indexed router would be needed to preserve exact
  history topology; this patch deliberately does not rewrite the router.
- The existing History API calls belong to the market asset-browser dialog. They
  do not discard editor state and are unchanged. This is not a global override of
  `pushState`/`replaceState`: future code that discards editor state must use the
  shared route boundary. Arbitrary History API calls do not emit `hashchange`.

The accepted route retains its user/workspace identity. A cancelled confirmation
can restore its URL only while that identity still matches, including after the
confirmation returns. An account/workspace change proceeds with privacy clearing
instead of restoring the previous actor. Disconnect clears the old project and
invalidates its in-flight loader. Signout asks once; after approval it releases the
old project and unload handler before requesting navigation/reload. A failed
remembered-account removal continues to show the existing page-only-disconnect
warning and does not reload or silently restore the private session.

## Provisional navigation and responses

A hash change is provisional until the guard accepts it. Responses already in
flight may use the retained editor's accepted hash while it has an unpersisted
dirty draft and still belongs to the same user/workspace. History/source reads,
cloud-copy outcomes, settings responses, Share outcomes and backtest cleanup use
this explicit response-only check. Already-started read-only History/Share lookup
chains can finish; cancelled navigation does not strand them in Loading/Sending.
The usual project/review identity, generation, selected-source and actor checks
still apply. Committed navigation, dismissal or identity change makes them stale.

New actions and queued writes continue to require the raw current hash. A response
cannot authorize a new cloud copy, queued settings save, publication or revocation
while a departure is pending. A blocked queued settings write reports that it was
not saved and reenables its retained controls for a fresh explicit save. There is
no request replay, automatic retry or new API flow. Non-editor origin-hash guards
(libraries/import, public pages, runs and approvals) retain their prior semantics.
Share reviews now retain/check their user and workspace as well as project/visit.

## Browser unload limits

A `beforeunload` handler is registered only while a draft is dirty and unpersisted,
and removed after successful storage, a clean reversion or an accepted departure.
It calls `preventDefault` and sets the legacy `returnValue`; it does not call
`window.confirm`, save source or provide custom native-dialog text. Browsers may
require prior user interaction, suppress the warning, or never deliver this event
(e.g. mobile process termination). Closing/reloading is not guaranteed to be
prevented, and this is not a substitute for downloading a backup. Browser-controlled
wording, native Back/Forward, tab closing, focus and reload UI remain unverified.

## Source-only verification

`tests/e2e/editor-navigation-ui.mjs` uses jsdom, inert source strings and mocked
APIs/storage. It checks the original All strategies loss, exact multi-file state,
link/hash/repeated/same-project navigation, synthetic Back/Forward, unload events,
clean/stored drafts, failed storage, review ownership, approved/disconnected
signout and response-before-hashchange races with new-write suppression. Run it with the preinstalled `NODE_PATH` and an explicit suite filename.
The `counterfactual:` test can read an unchanged source tree through
`VEYRA_NAVIGATION_SOURCE=/absolute/baseline/path`; it fails there because navigation
clears the only in-memory project. No browser/server, Python strategy/backend,
database, real API, installation, source transmission or live publication occurs.
