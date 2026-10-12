# Browser-storage failure boundaries

The public chart, discovery and published-source routes do not require browser
storage. A throwing `localStorage` getter or remembered-user read starts the page
anonymously and displays a persistent notice. No replacement persistence or
permission change is attempted.

Workspace and saved-link factories may be constructed without storage, but their
operations fail with `STORAGE_UNAVAILABLE`. Existing read, corruption and atomic
write errors keep their existing contracts. Denied reads never become an empty
library; rejected writes never produce a saved result. These stores retain their
existing formats, keys, device-only scope and Web Locks coordination.

Draft enumeration includes length, key and content reads in its error boundary.
If any read fails, the editor stays unavailable rather than assuming there are
no drafts and replacing unreadable recovery data. Existing draft contents are
left untouched. Failed draft writes retain edits only in page memory; failed
cleanup of a clean draft warns that a retained draft may return on reopening.
Exact-source, version and quote guards remain in place.

## Remembered development identity

Normal signout still removes only `veyra.user` and reloads. If removal fails,
this page clears its active development identity and account state, invalidates
private reviews/actions, clears its active editor/report/overlay displays, and
returns to public navigation without reloading. A separate notice says the
remembered identity remains and a manual reload may reconnect it. This is not
persistent signout, credential revocation, a security-setting change or a claim
that all previously loaded bytes have been erased from memory.

Late identity, source, duplicate, quote, authorization, balance and top-up
responses cannot restore the signed-out account UI or continue the next
account-dependent operation. Already-sent requests are not cancelled; an
already-created authorization may remain available for later recovery. Ordinary
route changes retain the existing approved-job submission semantics.

If the active draft has unsaved edits whose device recovery was not stored,
signout first asks whether to discard them and suggests downloading a snapshot.
Cancelling leaves identity, source and selection unchanged. Confirming permits
those in-page edits to be discarded. Persisted device strategies, links and
drafts are not deleted by signout.

## Offline verification

Run the focused synthetic suite with the existing jsdom installation:

```sh
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/browser-storage-access-ui.mjs
```

It exercises getter/read denial, quota/permission write failures, unreadable
draft enumeration, draft removal failure, both 401 cleanup paths, normal draft
restoration/signout, explicit discard cancellation, and held-response signout
races. Chart rendering, native confirmation and navigation are stubbed; no
browser, actual storage-policy changes, network, database, strategy execution,
credential operations or publication occurs. Real-browser storage policies,
confirmation UX and reload behavior still require separately authorized QA.
