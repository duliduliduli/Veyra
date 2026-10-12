# Build status against the master spec

Updated 2026-10-12. This document describes the current source candidate, not a
claim that every feature is deployed. See [overnight progress](overnight-progress.md)
for verification and publication limits. The latest verified live release is
commit `bf27d30bed4b7d7f15a20f4d386c3374541de638` from PR #3; later changes remain
local and unpublished.

## Functional paths

| Journey | Implemented in source | Current limits |
|---|---|---|
| Study a chart | Phone chart workspace ([details](chart-workspace.md)): symbol sheet with watchlist, timeframe sheet, 17 drawing tools, indicators/metrics/strategies browser with favorites, analysis hub (layouts, settings, compare, alerts, replay, templates, object tree, symbol details, technicals), undo and full screen; recorded report fill overlays from private saved runs or imported reports | BTC/ETH synthetic daily development data only; no subdaily feed or real-market performance claim. Public browsing survives unavailable browser storage |
| Write Python | Multi-file Studio, native symbol-button activation, documented Escape/Tab focus exit, entrypoints, private device drafts/snapshots, explicit device/cloud libraries, folders/settings/duplicate, source-preserving backups/imports, explicit reviewed saved-device-version copies to private cloud, saved-version history and read-only current-draft comparison | Device storage is browser-local; denied/unreadable storage fails explicitly without replacing data; production identity integration remains gated; deployed mode has not been read |
| Import saved helpers | Snapshot-root modules and explicit nested packages in the local development host, exact UTF-8 materialization and single entrypoint execution | Trusted development only; namespace/dependency caveats and production isolation gate remain |
| Ask for edits | Offline built-in template/parameter proposals with bounded exact-source diff review/apply/undo; disabled provider adapter boundary | No connected model, provider transport or paid AI request |
| Prepare a backtest | Immutable version/inputs, validated bounded JSON parameters, quote/ceiling, approval, original-key submission, saved approval discovery and manual recovery | Functional development contracts; production accounts and strongly isolated untrusted compute remain blocked |
| Follow a run | Progress, stop request, receipt, complete paginated strategy/date history | Runtime/reaper deployment is a separate gate; API-only production has no worker/reaper |
| Understand results | Prominent fee-adjusted closed-trade profitability, explicit denominator, equity curve with an exact recorded-values table and bounded paging, synthetic/incomplete/legacy states, verified artifact bytes, recorded provenance/assumptions/quality details and HTML/CSV/JSON downloads | A simulation is not real trading evidence; unknown metrics stay unavailable |
| Share chosen source | Explicit immutable public snapshot, independent public metadata, owner history and revocation | No existing private source is silently published; source already delivered cannot be recalled |
| Save public research links | Private device-only bookmarks, search and folders, guarded move/remove | Stores saved title/link metadata only; availability is checked when opening, no cloud sync or source cache |
| Reuse public source privately | Reviewed exact-source copy to a fresh private device strategy | No cloud upload or performance history copied; availability checked at the successful anonymous read |
| Track usage | Exact reservation/settlement ledger and receipt contracts with a development payment stand-in; bounded unused-reservation recovery and fail-closed approval identity checks | No approved production payment provider, fee schedule or hosted compute purchase |

The frontend is the existing HTML/CSS/JavaScript application, not an implemented
Next.js/Monaco rewrite. Existing fonts, colors and compact controls are preserved.

## Release gates

- **Draft navigation:** a shared pre-mutation discard guard now protects unpersisted dirty edits, with response-only provisional-navigation handling and a native unload warning request. Cancelled hash traversal restores the active URL by replacing the traversed entry, not its history index; duplicate editor URLs can remain. Native history/unload behavior remains unverified. See [the contract](editor-navigation-contract.md).

- **Publication:** later candidates are not uploaded or deployed. New explicit
  approval is pending for `duliduliduli/Veyra` and the existing app deployment branch.
- **Database verification:** 229 PostgreSQL-dependent tests are staged and unrun
  locally. The full normal PostgreSQL CI must pass before merging a candidate.
- **Migration startup:** transaction-local lock/statement limits now precede advisory acquisition. Historical SQL is unchanged; runner upgrade, rollback/retry and contention tests are staged, not executed. Connection acquisition, total startup/commit duration and old-application rollback remain unverified. See [the contract](migration-startup-contract.md).
- **Held-record resilience:** integrity-corrupted financial records stay held for operator review. The source candidate now continues unrelated worker claims and bounded reaper batches, with per-record rollback and process-local scan cursors that progress past held prefixes. Heartbeat now takes the job lock before its matching live attempt, with statement-time renewal. The active reaper now refreshes exact current attempt identity/expiry after the job lock, using refreshed heartbeat data for billing. Real PostgreSQL concurrency remains unverified; see [the contract](held-record-resilience.md).
- **Browser verification:** native browser/mobile layout, focus/history behavior
  and real storage quota checks remain unverified. Named jsdom suites are not a
  substitute for those checks.
- **Identity:** an anonymous deployed `/v1/me` check returned 401. The public schema
  omits local/test development routes, consistent with the retained source gate;
  exact deployed `APP_ENV` has not been read. Source authentication fails closed
  outside local/test until a provider is implemented. No credentials, account
  permissions or deployment configuration were changed for these candidates.
- **Python:** the resource-limited subprocess lacks filesystem/network isolation.
  The new local/test worker guard is source-only and depends on the environment
  being labeled correctly. See [ADR 0002](adr/0002-local-strategy-isolation.md).
- **Payments:** a source-only local/test development-webhook mount guard is ready.
  The deployed public schema still includes the payment webhook; its secret/configuration
  is unverified. An anonymous account 401 does not prove billing endpoints disabled. No live webhook or ledger was changed.
- **AI:** consent, identity, reviewed model/pricing/privacy, durable accounting,
  transport, proposal issuance and provider capability must be integrated and
  tested before a real coding provider is enabled. See [the boundary contract](ai-provider-boundary.md).

## Scope still open

- Real market-data rights and an intraday provider
- Explicitly authorized production identity/provider/payment configuration
- Strong untrusted per-job isolation and deployment of approved compute services
- Paper-trading adapters; live execution requires separate financial authorization
- Profiles/followers, public text feed/likes/comments, collaboration and in-app chat
- Production API authentication and metered hosted virtual computers
- Broader optimization/research pipelines and multi-asset execution fidelity

The master spec's suggested vendors, prices and 5% fee are proposals, not approved
production choices. A local development result or passing mock test does not mark
these integrations complete. No live financial execution is enabled by this work.
