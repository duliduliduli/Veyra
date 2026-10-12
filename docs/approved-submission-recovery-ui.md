# Saved approval recovery UI

This is a local source candidate. It does not deploy or enable production recovery,
billing, a worker, or a passive reaper. Discovery is a server-record read; it is not
browser-stored consent, a new authorization, or a change to account permissions.

## Entry and discovery

Backtests links to `#approvals`, retaining an optional project scope as
`#approvals/{project_id}`. Only entering this route or clicking its explicit Refresh
or Load older controls reads
`GET /v1/orgs/{org_id}/authorizations?limit=50[&project_id=...][&cursor=...]`.
Existing Backtests, project, quote and run routes do not gain approval reads.

The API returns only the authenticated user's approved submissions in an authorized
workspace, newest creation time and ID first. The UI consumes every bounded keyset
page on demand, deduplicates IDs and preserves loaded rows after a page failure.
Cursor loops and malformed envelopes fail safely. Each record labels its own server
snapshot timestamp; the overall timestamp describes only the latest fetched page.
A mutable project name is explicitly labeled current, separately from its immutable
saved version. The UI never fetches source, project versions, or a new quote.

The exact saved request, version ID/number, source and input hashes, original quote
and authorization IDs, nine-decimal approved ceiling, approval time, fixed 15-minute
claim deadline, and snapshot time are available in the review. UTC timestamps are
explicit. Text and JSON parameters render through text nodes, never HTML. Unsafe
integer ceilings and inconsistent saved identities/states are rejected rather than
rounded or reconstructed.

## States and confirmation

- An existing job always becomes a direct run link, even after the claim deadline.
- An unused claimable snapshot can open a review. Only the explicit confirmation
  button posts `/v1/jobs` with the saved authorization ID and original
  `quote-{quote_id}` idempotency key. It sends no new parameters, source or ceiling.
- `expired_pending_release` has no submission control. It says the reservation was
  still held at the observed snapshot and is awaiting server recovery. Reading or
  refreshing the view never releases a hold and does not imply a reaper is live.
- `released` alone says the unused reservation was released. No resubmission control
  is shown. Neither state calls a release endpoint or posts a job to induce release.
- Server `as_of` plus monotonic elapsed time can disable a now-expired claim in an
  open view. The browser wall clock does not establish claim eligibility. All
  discovery snapshots remain advisory; the existing POST checks expiry under lock.
  Delayed pages and same-view refreshes cannot move the effective server clock
  backward and re-enable a claim whose deadline already passed.
- An unknown/network/5xx or unverified job response may conceal a committed run.
  There is no automatic retry. Before the displayed claim deadline, a user may
  explicitly retry the same authorization/key or refresh discovery. After the
  deadline, only discovery is offered, avoiding a new expired-unused claim just to
  induce its lazy release. An existing job found by refresh opens directly.
- HTTP 410 is terminal for that submission and offers discovery for reservation
  status. A generic 409 retains its actual rejection and suggests refresh to find a
  job submitted elsewhere. Neither condition creates a new quote or authorization.

## Ownership and interruptions

A successful job response must include the exact saved authorization, workspace,
version and safe-integer reserved ceiling, plus a valid job identity. Missing or
mismatched response metadata remains uncertain and never navigates to a run.

List, pagination, review and submission work is scoped to route visit, exact route,
account, workspace, request and dialog identity. HTTP 401/403/404 access failures clear approval
records and invalidate an in-flight page, including when the denied request belongs
to an older dialog in the same still-current view. Later route visits and accounts
remain isolated from that denial. Confirming after navigation or account
change does nothing. A pending submission locks its identity across dialog close
and reopen; repeated clicks cannot duplicate a POST.

Closing or navigating after explicit confirmation does not cancel the sent request.
A late success/error may record the outcome in ephemeral account-scoped UI state,
but cannot navigate away, change another dialog's status, unlock another submission,
or refresh another account's balance. On explicit reopen/refresh, a known confirmed
run becomes a link. None of this ephemeral state is persisted to browser storage;
a reload discovers the server's current record again.

The existing in-memory quote/authorization flow and global latest-owned
`refreshBalance` helper are unchanged. Successful recovery uses that helper with an
additional destination/account predicate, matching the existing approval path.

## Checks

Run the named DOM-only suites with synthetic HTTP:

```sh
node --check apps/web/app.js
NODE_PATH=/workspace/shared/veyra-overnight/test-tools/node_modules node --test tests/e2e/approval-recovery-ui.mjs tests/e2e/backtest-approval-ui.mjs tests/e2e/run-lifecycle-ui.mjs
```

Recovery coverage includes explicit-navigation-only reads, project scope, reload
record discovery, all request details/exact ceilings, safe text rendering, no source
reads or automatic writes, empty/signed-out/closed-auth states, keyset pagination and
page retry, expiry versus returned holds, existing jobs, server-relative expiry,
explicit confirmation identity, unknown response/manual retry, 410/409 distinction,
Cancel/reopen and duplicate click handling, account/route/dialog ownership, stale
pages and completions, and access closure during pagination. The existing suites
cover the unchanged quote flow and shared balance ordering, plus run ownership.

Not checked: native browser layout/focus behavior or a real browser journey; browser
launch is outside this local verification. No live API/database, Python execution,
billing action, auth/config/resource/credential change, deployment or external write
was performed. Database concurrency/tenancy integration and passive reaper operation
remain separate verification and deployment gates.
