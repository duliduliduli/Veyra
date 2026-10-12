# Veyra build progress

Updated 2026-10-12, UTC. This record distinguishes implemented behavior from enabled services.

## First slice: Python Studio and reproducible backtest history

- The existing chart-first homepage, colors, fonts and synthetic-data labels remain intact.
- Python Studio supports private device-local strategies when no account is connected. Create a blank strategy, edit multiple existing Python files, save numbered snapshots, duplicate, organize into a flat folder, change name/description, and download source files. Device storage is explicitly labeled and is not database persistence or cloud backup. App writes use an exclusive browser Web Lock; browsers without that protection fail closed. Per-tab drafts are kept separately and older drafts can be downloaded for recovery.
- The editor and a bounded conversation panel share the workspace. The built-in offline helper proposes Python templates and supported parameter changes, shows old/new code before Apply, rejects edits when the source has changed, and supports guarded Undo. It is not a connected AI model and does not execute code.
- Authorized database APIs support private strategy metadata/folders, duplication of full snapshots, and optimistic version checks. Existing private strategy contents are not published.
- Backtest history pages through all available records, grouped by strategy and newest run, with exact loaded/total counts and strategy filtering.
- New reports define percent profitable as winning closed position round-trips divided by all closed round-trips, multiplied by 100, after execution fees. Breakeven is not a win; open positions are excluded. No closed trades means unavailable. Existing reports are not rewritten or assigned invented values.
- HTML, fill CSV and canonical JSON reports remain downloadable. Simulator version advances to 0.1.1 and metrics version to metrics-v2 so new semantics are distinguishable from old reports.

## Safety and remaining integration gates

Production identity remains deliberately closed until an identity provider is connected. No authentication relaxation, credentials, live trades, transfers, payments, external AI calls or newly purchased infrastructure are included.

The current Python worker has resource-limited process separation, not filesystem/network isolation. It is not suitable for untrusted multi-tenant production execution. A properly isolated runtime remains a release gate for that use.

Public sharing, social profiles/feed/chat, collaboration, hosted computers and live execution are not enabled by this slice. They should follow secure identity and persistence foundations, with explicit cost and sharing boundaries.

## Verification

- Verified source baseline: 037fc861715ff6bcdbac7d608124dcc860726540.
- Local dependencies installed from the existing locked Python workspace.
- Pure Python metrics/billing tests, local storage tests, offline-helper tests, JavaScript syntax, Python lint and the existing 30 chart interval checks have passed during development.
- Database integration tests require PostgreSQL; no PostgreSQL server is available in this executor. Run against the existing isolated PostgreSQL CI service before deployment.
- Real browser visual/responsive QA remains unverified under the previously established Chromium launch restriction. DOM tests do not establish visual fidelity.
- First slice deployed: PR #3, merge bf27d30bed4b7d7f15a20f4d386c3374541de638; Railway deployment dbc0f13a-8f4d-47d7-a2db-87a144b3407f succeeded. CI passed 147 backend tests and frontend checks. Live HTTP readback matched all five reviewed assets, health and both synthetic feeds; account access remained closed (401).

## Rollout notes

Migration 0002 adds metadata and indexes only, with a five-second lock wait and sixty-second statement limit so contention fails transactionally. It is not a zero-downtime migration for a large active database. The existing Railway service is API-only; no worker service is deployed. When deploying a worker elsewhere, drain old jobs and requote outstanding 0.1.0 requests before using 0.1.1. Mixed engine versions fail the existing input-integrity check without customer compute charges.


## Second slice: chart studies, recorded fills, and AI boundary

- Chart-local Indicators and Strategy controls keep interval selection separate from chart type and visible date range. RSI 14 uses Wilder smoothing across complete selected-interval history before range cropping, with a synchronized lower pane and warmup blanks. SMA 20 also retains prior history when the range changes.
- Import a Veyra report JSON locally, or view an authorized run's recorded fills on its chart. The importer verifies exact synthetic dataset identity, full-source and run-subset SHA-256 hashes, supported schema and execution model, bounded input, and exact decimal position consistency. Only existing fill records become compact entry/exit markers; inspect a marked candle for details.
- Source integrity is distinct from report authenticity: imported fill claims remain explicitly unverified and all data remains synthetic. Incomplete, no-fill and mismatched reports are handled without invented trades. File contents are never uploaded by chart import.
- Stale asynchronous reads, source hashing, asset switches, dialog cancellation and newer navigation cannot apply an older overlay. Clearing the overlay does not change a strategy or run.
- Backtest parameter overrides default to an empty object so saved Python defaults are not silently overridden by the previous starter parameters.
- A disabled provider-edit adapter now defines explicit selected-file disclosure, immutable snapshot/base hashes, reviewed model/price/privacy policy, admission and cost-reservation boundaries, strict output validation, usage accounting, and proposal review. It has no route, configured transport, credentials, provider call, execution path or apply/save operation. It does not turn the offline helper into connected AI.

Second-slice local checks include 22 pure chart tests, 33 chart DOM integration tests (including the actual bundled chart library with deferred animation frames), the existing 17 Studio tests, 10 offline-helper tests, storage contracts, 30 interval checks and Ruff. Genuine trusted bundled SMA reports cross the real Python simulator/report to JavaScript importer boundary for both synthetic datasets and completed/interrupted/full-range cases. The AI boundary has 22 offline unit methods including 116 subtests. PostgreSQL CI and final deployment evidence must be verified for the final release commit.

This slice adds no database migration, dependencies, identity settings or new paid resources. Browser rendering, responsive visual quality and native focus behavior remain unverified.

## Third slice: explicit public snapshots and private backups (local candidate)

- Discover lists only explicitly published snapshots, with metadata search, real pagination, empty/error states and read-only multi-file source/download views. Public content is rendered as text and never executed. Public reads omit identity headers/cookies and bypass browser caches.
- Share reviews a chosen immutable saved revision, all its files, its canonical source hash and entrypoint. Public title/description are entered afresh, and an explicit confirmation is required. Unsaved edits, private project notes/folder and later versions are not silently included. Production identity is still closed, so no current user strategy has been published.
- Owner receipts use complete bounded keyset pagination. Idempotent retries do not recreate revoked links. Revocation removes subsequent platform reads and discovery; earlier responses and outside copies cannot be recalled.
- Migration 0003 adds an initially empty publication table and immutability guards; no backfill, destructive change, public seed or existing private-strategy exposure occurs. It uses bounded lock/statement timeouts. Its PostgreSQL runtime and concurrency tests still await execution before release.
- All API responses have no-store headers and no cache validators. Unexpected private-route errors return a generic response with security headers instead of exposing internals.
- Download snapshot preserves complete current multi-file Python source, including unsaved edits and untouched CRLF text. Import reads bounded strict UTF-8 JSON locally, previews the files/metadata, and creates only a new private device copy under the existing Web Lock. It never overwrites a strategy or uploads source, even with a connected database account. Earlier version history is not reconstructed by a snapshot import.
- Strict portable backup limits can reject some older metadata or long paths; the error leaves the source unchanged. Downloaded source may contain secrets written into that source and should be kept private.

Local integrated verification: 141 explicit frontend tests, 30 interval checks, 167 non-PostgreSQL backend tests and 116 subtests pass. The 75 PostgreSQL-dependent cases are explicitly deselected locally, including 16 new publication/migration/concurrency cases. No real browser layout/native focus checks are claimed. A broad test selection also reached browser-test imports, which stopped at missing Playwright before any browser was launched; those suites remain unrun.

The reviewed second-slice source upload was denied twice, including one exact evidence-backed retry. No alternate upload/deployment route was attempted. Publication is paused pending explicit approval naming the source changes and existing private repository/branch/deployment destination. The first slice remains the latest verified live version. New local feature tests are not a claim of deployment or enabled authentication, model access, untrusted Python execution, payments or hosted computers.


## Fourth slice: saved-source history and integrity (local candidate)

- Read-only History lists every device-local revision and pages through cloud versions. Each selection verifies its saved identity before displaying every Python file or downloading the complete selected snapshot. Current project metadata is labeled separately from saved source. Current edits and drafts remain untouched.
- Cloud history count and page use one SQL snapshot; older-version cursors remain stable when new versions are saved.
- Private source reads, duplication and public snapshot reads now share strict source shape/type/size, hash and entrypoint validation. Missing, malformed or changed source returns a generic 503, and invalid source cannot create a duplicate. Existing successful API responses and authorization rules are unchanged. No source repair, migration, new role or permission is introduced.
- Independent reviews found no remaining frontend or shared-source integrity blocker in scope.

Combined local checks: 163 explicitly selected frontend tests, 30 interval checks, 227 non-PostgreSQL backend tests and 116 subtests passed; Ruff and JavaScript syntax passed. All 108 PostgreSQL-dependent cases remain unrun locally, including 21 new history cases and 12 new source-integrity cases. The selected offline test filter does not run in CI; CI still runs the full database suite. Native browser layout/focus and authenticated database/object-store integration remain unverified. No further remote write or deployment was attempted.


## Fifth slice: full Python drafts and reliable backtest output (local candidate)

- Studio adds draft-only blank file creation, rename, explicit removal and entrypoint selection. Complete snapshot recovery preserves additions/removals, exact source and CRLF, while older/rejected drafts remain privately recoverable. Clean-state recovery markers use explicit increasing timestamps rather than browser storage enumeration.
- Quotes and duplicates require an explicitly saved clean snapshot. Duplicate requests carry the displayed saved version, with matching local/server conflict checks so another tab cannot silently change the copied source. Existing no-body API calls remain compatible. Late save/quote/assistant responses cannot overwrite newer draft context.
- Report CSV output uses proper quoting, including embedded commas, quotes and CR/LF in valid engine-generated client identifiers, while preserving ordinary bytes and canonical report data. HTML says when only the first 500 fills are shown; complete CSV/JSON remain available.
- Report downloads verify stored byte count and SHA-256 before serving exact bytes. Missing/corrupt artifacts return sanitized 503 and do not rewrite storage. Existing privacy and no-store behavior remain intact.
- Run detail, report responses, polling, cancel completions and downloads are scoped to their originating visit. Fresh history loads no longer show a previous scope on failure; pagination errors preserve loaded rows and retry state.

Verified together: 198 explicitly selected frontend checks, 30 interval checks, 328 offline backend cases and 116 subtests, Ruff, JavaScript syntax and all 221 HTML ID/label/ARIA references. The 112 PostgreSQL-dependent cases remain unrun locally. Independent review issues were fixed and tested, including no-body duplicate compatibility and non-string stored artifact keys. Native browser layout/focus, spreadsheet auto-type behavior and authenticated database integration remain unverified. The offline compatibility suite includes actual runs of trusted bundled sample strategies; it does not execute user-supplied strategies or make real trades. No additional upload, merge or deployment has occurred.


## Sixth slice: complete library loading and worker gate (local candidate)

- The strategy library no longer silently stops at 100 cloud projects. Bounded keyset API pages are loaded progressively, with explicit loaded/search counts, folders, real Refresh and honest incomplete states after errors. A 237-strategy fixture proves the oldest project remains discoverable. Device-local behavior remains intact. Concurrent changes may require Refresh; metadata pagination is not a database-wide snapshot.
- Direct Worker construction and CLI worker/all/default modes now accept only exact local/test environment labels. Rejection occurs before database migration/pool creation, object storage or a reaper thread. Reaper-only behavior is unchanged. This gate does not supply filesystem/network isolation or protect against a mislabeled deployment; the existing unset environment default remains local. No production worker or configuration is enabled.

Combined verification: 219 explicit frontend checks plus 30 interval checks, 433 offline backend cases plus 116 subtests, Ruff, JavaScript syntax and 223 HTML ID/label/ARIA checks pass. The 149 database-dependent cases remain unrun locally. Existing offline compatibility tests run only trusted bundled synthetic sample strategies. Browser QA and real authenticated PostgreSQL integration remain gates. The source remains local and publication approval remains pending.


## Seventh slice: private storage views and approval recovery (local candidate)

- Explicit cloud/device Studio views keep local imports discoverable when an account is connected. Search/folders, creation targets and editor return links retain their selected store. No implicit source upload occurs. Deferred page/create/import responses cannot replace newer views.
- Pricing and approval own the exact saved version, inputs, displayed nine-decimal ceiling, account and visit. Approved requests keep their immutable identity across navigation, while stale completions cannot redirect a newer view. Unknown authorization/job failures support only manual same-quote retry; confirmed expiry clears only the matching quote. A confirmed retry removes the obsolete uncertainty warning, and late balance reads cannot overwrite newer balances.
- Unused authorizations have a fixed 15-minute job-claim window. Late unused claims commit a zero-charge full release before returning410, including terminal repeat/reaper-first responses. Existing jobs in every state and their matching-key retries are never released. Source-only bounded reaper batches use the shared authorization lock, a fresh post-lock job check and one transaction per candidate. No schema migration or service enablement occurs.

Verified together: 287 explicit frontend tests, 30 interval checks, 471 offline backend cases and 116 subtests, Ruff, syntax and 227 HTML ID/label/ARIA references pass. Independent reviews found and resolved stale-balance and lost-expiry-response issues. All 167 PostgreSQL cases remain unrun, including 18 new reservation transaction/race gates; mocks do not prove database atomicity. The offline compatibility cases execute only trusted bundled synthetic samples.

The live API-only deployment has no running reaper, so passive recovery remains a separate deployment gate. Durable uncertain-submission discovery after reload/navigation, production identity, isolated untrusted execution, approved billing and connected AI remain unfinished integrations. Real browser layout/focus QA and publication approval are still pending. No new remote write, deployment, live ledger action or configuration change was performed.


## Eighth slice: settings and maintenance resilience (local candidate)

- Private strategy settings have exact dialog/project/route/account ownership. Same-project writes wait for earlier requests across dialog visits; dismissed queued writes are discarded before send and inside the device Web Lock. Unknown cloud outcomes block automatic successor writes, retain values and warn that a separate explicit retry could still race the unconfirmed save. Source files, snapshots, drafts and permissions are unchanged. Cross-tab server write ordering is not supplied by this client guard.
- Reaper maintenance calls handle ordinary failures independently and retry after the existing interval. Failure logs identify only operation and exception class; process-level BaseExceptions propagate. Job/authorization/ledger transactions, batch limits and worker environment gates are unchanged. This does not start a service or add hung-call timeouts or daemon supervision.

Combined local verification: 312 explicit frontend checks, 30 intervals, 485 offline backend cases plus 116 subtests, Ruff, syntax and 228 HTML references pass. Independent settings review added persisted-state reproductions and resolved ambiguous-response ordering. All 167 PostgreSQL cases and real browser/native-focus checks remain unrun. No remote publication, service configuration, production financial action or new access occurred. The next local slice adds authenticated discovery and explicit recovery of the user's previously approved submissions after losing an in-memory browser context.


## Ninth slice: recover approved runs and gate the dev webhook (local candidate)

- Backtests links to the user's own saved approvals in the current authorized workspace. Every bounded page checks membership and research role, preserves exact saved request/version/hash/ceiling identity, and distinguishes claimable, expired-but-held, released and existing-job states. Stored-input corruption fails closed without partial private data disclosure; no source files are returned. Domain discovery uses SELECT only, while existing local/test identity bookkeeping remains unchanged.
- Recovery reviews immutable inputs and exact ceilings, then submits only on explicit confirmation using the original authorization and quote-derived idempotency key. It never creates another quote/reservation or automatically retries. Existing jobs link directly; expired records cannot submit. Route/account/dialog races, revoked access across newer dialogs and delayed-page clock rollback are covered. Observed availability is advisory; the POST's lock/clock checks remain authoritative.
- Source review found the development payment webhook was mounted outside local/test, while anonymous account access returned 401. The bounded source fix moves only that webhook onto the existing local/test route gate. Auth/config/signature/payment-application code is unchanged. Earlier shorthand that all production billing was disabled was too broad: deployed webhook configuration is unverified, no deployed secret was read, and no live webhook was probed. This guard is not deployed. The unset environment label still defaults to local and must be checked before launch.
- README now distinguishes sequential SDK input from real isolation, and labels the proposed test fee accurately. No production identity, provider, credentials, permission, paid resource or runtime setting was enabled.

Integrated verification: 372 explicit frontend checks, 30 intervals, 588 offline backend tests and 116 subtests, Ruff, syntax and 243 HTML references pass. Independent recovery UI/privacy reviews found and resolved corrupted-consent, access-revocation and stale-clock issues. All 179 PostgreSQL cases remain unrun, including 12 new discovery cases. The 26 webhook-gate tests fail on all 14 non-development labels in the old source and pass on the new source. Trusted bundled compatibility strategies are included in the parent offline suite; an initial scoped webhook-worker selection accidentally included those six trusted cases too, then reran with verified exclusion. No user-supplied strategy was executed.

No upload, merge, deployment, database execution or live financial action occurred. Real browser layout/focus, final PostgreSQL/ledger concurrency, deployment labels, production isolation and approved integration gates remain open. Next: explicit public snapshot to private device-copy editing, with source integrity and no upload or execution.

## 2026-10-12 11:45 UTC: public-to-private device editing

Explicit review now copies an available public immutable snapshot into a fresh
private device strategy, preserving every Python file, entrypoint and license
header. Independent review fixed account-context cancellation and long Unicode
title compatibility; seven additional reviewer probes pass. Two anonymous reads
check availability and exact source identity before the synchronous locked save.
This is not atomic with later server revocation and cannot recall delivered copies.

397 explicit frontend checks, 30 interval checks, 588 offline Python cases and
116 subtests pass. All 179 PostgreSQL cases remain unrun. Ruff, syntax and 256 HTML
ID/ARIA references pass; native browser/mobile visual checks remain unverified.
The live release is unchanged and no additional external write was attempted.

## 2026-10-12 11:58 UTC: private saved research links

Discover now has a device-only Saved links view, with search, flat folders and
reviewed save/move/remove. Stored titles are labeled as saved metadata; links are
loaded anonymously afresh on opening, and revoked source is not cached. Existing
public-copy behavior is preserved. Cross-tab writes use the existing Web Lock;
a persisted monotonic clock prevents stale reviews changing a removed/recreated
link, including fixed or backward wall clocks. Clock saturation fails before
writing, and rerenders restore focus to live controls.

Independent review resolved the clock-boundary and keyboard-focus findings.
428 explicit frontend checks, 30 interval checks, 588 offline Python cases and
116 subtests pass; 179 PostgreSQL cases remain unrun. Ruff, syntax and 278 HTML
ID/ARIA references pass. Real browser/storage-event/layout QA is still unverified.
No source was uploaded, published or deployed; saved links have no cloud backup.

## 2026-10-12 12:07 UTC: report evidence and proposal review

Run results now expose recorded immutable source/input/data identifiers, parameters,
engine/metric versions, execution fees/slippage/limitations and data quality. These
are recorded evidence, not an independent verification. Malformed/mismatched report
identity or required data withholds performance and exports while preserving only
the current job receipt. Legacy omissions remain unavailable; synthetic warnings,
account/navigation ownership and stale chart clearing have explicit tests.

Offline helper proposals now have bounded contextual line diffs, exact full before
and after sources, whitespace/end-of-line labels and a visible warning that Python
indentation changes behavior. Dense comparisons use a clearly labeled complete-source
fallback. Apply still requires the original issued proposal and unchanged draft;
Undo preserves original bytes. No model was connected and no strategy was executed
by either new feature.

Combined final checks: 472 named frontend tests, 30 chart intervals, 588 offline
Python cases and 116 subtests passed; all 179 PostgreSQL tests remain unrun. Ruff,
syntax, 301 unique HTML IDs/ARIA references and nine present script assets passed.
The integrated fixture loaders include all sibling helper scripts. Independent
reviews passed and native browser/mobile/screen-reader QA remains unverified.
No new external write or deployment occurred. Next: repair saved helper imports
for trusted local development strategies without changing production isolation gates.

## 2026-10-12 12:25 UTC: executable saved helper imports in local development

The trusted local strategy host now imports saved root helpers and explicitly
packaged relative helpers, preserves valid initializer/hyphenated entrypoints and
exact UTF-8 source bytes, and prevents duplicate entrypoint execution. Defined
local Strategy classes are counted once; imported base classes do not create
false ambiguity. Path/materialization failures clean up before launch. The
production worker gate remains byte-for-byte unchanged. Third-party namespace
packages retain ordinary Python precedence and are not a supported dependency
contract; this change provides no filesystem/network/tenant isolation.

SDK package 0.1.1 and runtime fingerprint 0.1.2 distinguish the new loading rules
in the existing quote/report hashes. Mocked preparation tests prove an older
approved runtime fingerprint requires a new quote before execution. Existing
reports and source snapshots are unchanged.

A separate test environment was installed offline from the existing local cache,
then its exact SDK source path was checked under Python -I. The full offline suite
now passes 650 cases and 116 subtests, including the six trusted bundled SMA
subprocess compatibility cases against the candidate host and a new three-layout
check proving identical bundled-SMA results for single-file/root-helper/nested
relative-package loading. 179 PostgreSQL tests
remain unrun. Frontend remains unchanged and all 472 named checks plus 30 intervals
pass; Ruff and the offline lock check pass. No user strategy, live service,
credential, production configuration or external publication action occurred.

## 2026-10-12 12:36 UTC: reviewed Python starter revision

New buy-and-hold source retries a rejected entry while flat until a buy actually
fills; allocation and SMA window overrides fail early when invalid. This is an
explicit new revision, not a silent repair of saved v1 strategies. Exact legacy
source, including CRLF, remains recognized for numeric-default edits and Undo.
Browser and server SMA starter source match. Independent review included 240
randomized valid-input SMA comparisons and found no remaining scoped blocker.

664 offline Python cases and 205 subtests, 478 frontend checks, 30 chart intervals,
Ruff, syntax and 301 HTML references passed. The template suite only compiles
reviewed repository examples in-process; existing trusted SMA child-process tests
also ran against the candidate SDK. All 179 PostgreSQL cases and native browser QA
remain unrun. No user source or external service was executed.

## 2026-10-12 12:43 UTC: backtest parameter integrity

Parameter input now rejects non-finite numbers, integer-valued parsed numbers
outside JavaScript's safe range, invalid Unicode/NUL and excessive JSON depth or
size before requesting a quote. Valid values stay unchanged; errors leave the
user's text available to correct. Editing or failed repricing invalidates the old
quote and disables approval. Strings are recommended for exact decimals and large
integers; normal binary64 rounding and JSON lexical normalization remain explicit.

The API validates the same contract before reading data or inserting a quote,
with safe serializable 422 errors. Saved approvals outside the new contract remain
untouched and unavailable through the existing sanitized 503 path; no automatic
reapproval or data rewrite occurs. Independent tests cover model values, mocked
HTTP boundaries, cycles, escaped characters and quote lifecycle races.

724 offline Python cases and 205 subtests, 518 explicit frontend checks, 30 chart
intervals, Ruff, syntax and 302 HTML references passed. All 179 PostgreSQL cases
remain unrun. Anonymous account access returned 401; exact deployed identity
configuration is unverified. Publication and native-browser QA remain pending. Separate source-only investigations are addressing approved
worker input identity and malformed request-validation response serialization.
No external write, live ledger action, configuration or permission change occurred.

## 2026-10-12 13:04 UTC: approved execution and financial identity

Worker preflight now binds the exact execution config to the saved quote,
authorization, organization, version, ceiling and current engine before any strategy
launch. The original defect was reproduced with six job-only changes that still
passed the old quote hash. Shared saved-source validation also checks the complete
snapshot schema, paths, size, hash and entrypoint.

A shared settlement guard covers both jobs and expired-unused reservations. Altered
financial identities or ceilings stop before ledger posting; transaction errors
propagate so pending attempt/fence/usage changes roll back. Intact reservations can
still zero-settle ordinary runtime-only preflight failures. Nothing repairs or
releases corrupt records automatically. Coordinated rewriting of every consistent
DB record is outside this consistency guard's claim.

Request-validation errors now return bounded safe 422 arrays instead of accidental
500s when rejected values include nonfinite numbers or invalid Unicode. Field-level
errors are intentionally replaced by request-section messages; ordinary domain
errors and actual server failures are unchanged. Actual publication routes, cache
headers and the existing browser error contract are covered.

988 offline Python cases and 205 subtests, 518 explicit frontend checks, 30 chart
intervals and Ruff pass. All 196 PostgreSQL tests remain unrun, including 17 new
rollback/concurrency cases. Parent review corrected staged HTTP expectations and
verified the real middleware boundary with mocks; this is not PG execution evidence.
Native browser QA and publication remain blocked. The next bounded resilience slice
will let healthy work proceed around held records: the current worker can stop on
an integrity hold, and a held reaper row can delay the existing batch. No production
financial action, config/security change, credential access or remote write occurred.

## 2026-10-12 13:26 UTC: held-record progression and deployment evidence

The scheduler now preserves integrity-held jobs/reservations while continuing
unrelated healthy work. Each bounded reaper selection has its own transaction;
only the specific integrity exception is contained after rollback. Process-local
cursors progress past more held records than one batch, then wrap on a later call.
No fallback rates, corruption repair or automatic release of held money is added.

1,054 offline Python cases and 205 subtests, 518 explicit frontend checks, 30 chart
interval checks and Ruff passed. All 211 PostgreSQL-dependent cases remain unrun,
including 15 new database-backed progression/rollback gates. Candidate-specific
isolated imports resolve SDK 0.1.1 and engine 0.1.2 from this source. The parent
compatibility suite executes only reviewed bundled strategies and trusted fixtures.
One worker accidentally used that broader inherited suite before returning to its
mock-only allowlist; no user/remote strategy source or database was used.

The first release remains the latest successful Railway deployment, commit
`bf27d30bed4b7d7f15a20f4d386c3374541de638`, verified again at 13:25 UTC. Earlier
wording that production account access was proven closed was too strong. The
retained anonymous `/v1/me` check returned 401; the public schema read at 13:20
omits `/v1/dev/` routes, which is consistent with non-local/test mode under the
retained source gate. Exact deployed APP_ENV and payment-webhook configuration
remain unverified. The payment webhook is still in the public schema. No dev
identity probe, deployed secret/configuration read or mutation was performed.

Heartbeat currently takes attempt then job locks while settlement/reaping take job
then attempt locks. This source-level inversion is the next narrowly scoped fix;
no real database deadlock or concurrency success is claimed. Publication and
native browser/mobile QA remain pending.

## 2026-10-12 13:34 UTC: heartbeat lock order

Heartbeat now locks and verifies the authoritative running job before updating its
matching live attempt. Missing, ended, foreign or fenced identities mark the claim
lost without progress writes. Cancellation comes from the freshly locked job. The
existing expired-but-unreaped renewal behavior remains; renewal uses statement time
after the job-lock wait rather than transaction-start time. This does not promise
freshness after unrelated direct attempt-lock contention or commit delay.

1,077 offline Python cases and 205 subtests, 518 frontend checks, 30 intervals and
Ruff passed. All 222 PostgreSQL-dependent cases remain unrun, including 11 new
lock-order, cancellation, heartbeat/finish/reaper and identity gates. Source and
staged tests were independently inspected; mocks cannot prove real lock behavior.
The worker's strict harness blocked unrelated TestClient thread creation in an
initial allowlist, then passed 326 explicit cases with zero forbidden-boundary
calls. The parent separately ran the broader trusted-fixture compatibility suite.

A separate source review identified stale joined attempt data in active reaper
discovery: a heartbeat can commit after the selection snapshot and before its job
lock. Refreshing that attempt after the job lock, before financial writes, is next.
No live deadlock or stale reaping was reproduced against a database. No external
write, production configuration or credential change occurred.

## 2026-10-12 13:45 UTC: saved/draft comparison and fresh recovery leases

Studio History now offers an explicit read-only comparison of a selected saved
version with the current in-memory draft. It captures all exact file strings and
the entrypoint, identifies added/removed/modified/unchanged files (including empty
versus absent), and reuses the bounded whitespace/line-ending diff with complete
source fallback. Explicit recompare refreshes the capture; browsing never saves,
restores, runs or overwrites the draft. Account/organization guards supplement the
existing route/project/modal/selection guards.

Active recovery now rereads the exact selected/current live attempt after acquiring
the job lock. Renewed, ended, missing or nonmatching attempts produce no financial
writes or recovered result. Eligible billing uses refreshed timestamps. Bounded
scan progression advances only after successful transaction exit, including no-op
and empty scans. Existing transaction-start expiry cutoff is preserved; this
assumes default READ COMMITTED and normal job-first attempt writers.

1,097 offline Python cases and 205 subtests, 539 named frontend checks, 30 interval
checks, Ruff, syntax and 323 HTML IDs/ten script assets passed. All 224 PostgreSQL
cases remain unrun. Two new staged advisory-gated cases check the exact snapshot
race and later healthy recovery; static review caught and corrected two fixture
expectations. Four guarded counterfactual tests fail against the old reaper as
expected; mocks establish source behavior, not actual PostgreSQL concurrency.
Native browser/mobile and assistive-technology behavior are unverified.

The next Studio fix addresses native keyboard activation of symbol buttons and a
discoverable forward focus exit from Tab-indenting code. No external publication,
production operation, new credentials or configuration change occurred.

## 2026-10-12 13:56 UTC: Studio keyboard controls

The symbol row now uses native button activation, with meaningful accessible names
and disabled loading/unavailable states. Primary pointerdown preserves selection
without editing; completed click inserts once through existing exact-source draft
tracking. Stale/cancelled pointer contexts and hidden/missing/disabled editors are
rejected. Ordinary Tab indents; visible textarea help documents Escape, then Tab
to leave forward, and Shift+Tab to leave backward. The one-use exit state resets
on input, blur, composition, file context and navigation; modified keys are intact.

562 named frontend checks, 30 intervals, 1,097 offline Python cases and 205 subtests,
Ruff, JS syntax and 324 HTML IDs/ten assets passed. The new 23-case suite is listed
explicitly in CI. Three original-bug checks fail on the old source and pass here.
All 224 PostgreSQL cases remain unrun. jsdom dispatches native-click outcomes and
checks uncancelled Tab; it cannot prove real keyboard/touch focus or screen-reader
behavior. Native browser QA remains unverified, and no launch was retried.

Release review separately confirms 0003 is the only pending migration and does not
publish existing private source. The inherited startup advisory wait precedes its
SQL timeout statements; a bounded source-only runner guard and upgrade verification
are next. No database, deployed setting or external publication was changed.

## 2026-10-12 14:10 UTC: bounded migration startup

One runner statement now sets the existing 5-second transaction-local lock limit
and 60-second statement limit before the advisory migration lock. Historical SQL,
transaction/ledger ordering and single-commit semantics are unchanged. Eleven
mocked contracts and five staged dedicated-database gates cover ordering, repeated
startup, 0002→0003 preservation, failure/rollback/retry and advisory/ledger contention.
Connection acquisition, cumulative migration/commit duration and old-application
rollback compatibility are not newly guaranteed.

1,108 offline Python cases and 205 subtests, 562 named frontend checks, 30 intervals
and Ruff pass. All 229 PostgreSQL-dependent test bodies remain unrun. The first
parent offline run incorrectly selected five new migration-specific fixtures: their
localhost connection setups were refused, so no connection or SQL/migration ran.
That path was stopped. The local-only selector now excludes both database fixture
families and PostgreSQL modules, with connection/pool sentinels before collection.
The corrected offline run passed; this is not a successful database verification.
The component worker independently stayed within its 11 mocked cases throughout.

The source migration still creates an empty publication table; no existing private
strategy is exposed. Native browser QA and publication remain blocked. Next local
UI work keeps public chart/discovery usable when browser storage is denied, while
private device/draft operations remain explicit failures without fake persistence.
No deployed database, setting, security permission, credential or external source
publication was changed.

## 2026-10-12 14:18 UTC: unavailable browser storage

Public chart/discovery/source browsing now starts when the browser denies storage
access or remembered-user reads. A persistent notice distinguishes anonymous page
access from device persistence. Storage factories defer unavailable errors to their
operations; denied reads never become empty libraries, and rejected writes never
claim success. Unreadable draft enumeration leaves editing unavailable, preserving
existing recovery data. No replacement storage or permission change is attempted.

Failed remembered-identity removal clears this page's account actions/displays and
stays without reload, while warning that stored identity remains and manual reload
may reconnect it. Stale responses cannot chain account-dependent work or restore
private UI. Already-sent requests may still finish. Dirty edits without stored
recovery require explicit discard confirmation before signout; cancellation leaves
source, selection and identity untouched. Persisted strategies/drafts are not deleted.

584 named frontend checks, 30 intervals, 1,108 guarded offline Python cases and
205 subtests, Ruff, JS syntax and 325 HTML IDs/ten script assets pass. All 229
PostgreSQL test bodies remain unrun. The 22 new storage cases use synthetic getter,
read, write and removal failures; both initial bootstrap regressions fail against
the old source. Real browser storage policies, native confirmation/reload, mobile
layout and assistive technology remain unverified.

App and changed helper cache keys plus the explicit new CI test entry are updated.
No actual browser/storage permission, production identity, server authorization,
payment behavior, deployed configuration or external publication changed.

## 2026-10-12 14:42 UTC: readable recorded equity values

A collapsed Equity values section now complements the run chart. It reads the
same validated report, renders at most 50 exact recorded-value rows per page and
keeps every row reachable. Numeric strings retain their original representation;
legacy JSON numbers use their parsed value. Times are normalized to UTC at recorded
precision; date-only rows do not invent a time of day. Quote units are explicit.

Native details/table/button semantics, row/page counts and empty/legacy/incomplete
states are covered by synthetic DOM tests. Leaving the route, changing runs or
signing out clears the table. The existing run-to-chart recorded-fill handoff is
unchanged. No new request, computation, export, backend or persistence is added.

The final candidate passed 593 checks across the 24 explicitly named frontend
suites, 30 interval checks, 1,108 guarded offline Python cases plus 205 subtests,
Ruff, changed-JavaScript syntax and all 333 HTML IDs/ten script assets. All 229
PostgreSQL-dependent bodies remain unrun. Nine focused tests are new; independent
review also passed UTC/numeric edge assertions. It caught a documentation detail:
parsed numeric -0 exists, but String(value) normalizes it to 0. That wording is fixed.

Native layout, keyboard/screen-reader operation and full PostgreSQL CI remain
unverified. No external publication, browser launch, database or production action
was performed. Source publication still needs the outstanding explicit approval.

## 2026-10-12 15:00 UTC: deliberate saved-device-version cloud copy

Saved version history now offers a separate destination/source review and explicit
confirmation for a private cloud copy. It verifies account/workspace membership,
discloses workspace-member readability and transfers only the chosen saved files,
entrypoint and reviewed metadata through the existing creation API. Device source,
versions and drafts remain unchanged. Success stays in the editor with a link; no
backtest, quote or public publication is triggered.

In-memory pending/unknown outcome guards prevent automatic retries, survive review
close/reopen and require a fresh review after inspecting the cloud library. They
cannot provide reload/cross-tab exactly-once creation. The source copy has not been
transmitted to a real service in this work; production identity is still gated.

Independent review reproduced and fixed two issues before integration: new links
could drop unpersisted edits, and a creation receipt could identify a different
creator in the same workspace. Both links now protect those edits, and the response
must match the reviewed account ID. Seventy-five focused cases are new. Final
aggregate checks: 668 frontend tests across 25 named suites, 30 intervals, 1,108
guarded offline Python cases plus 205 subtests, Ruff, syntax and 347 HTML IDs/ten
assets pass. All 229 database bodies and native browser QA remain unrun.

A separate diagnostic reproduced inherited loss of unpersisted drafts through the
ordinary All strategies link. That shared-routing guard is the next source-only
slice; this candidate's new cloud-copy links are protected. No browser launch,
database/service action, configuration change or external publication occurred.

## 2026-10-12 15:24 UTC: preserve unpersisted drafts during navigation

The shared router now checks for dirty source whose latest device draft write
failed before changing route generation, project state, dialogs or views. Cancel
preserves complete source/file maps, selection, open reviews, ownership and active
URL. The two cloud-copy links use the same guard. Clean/recoverable drafts do not
prompt; approved signout clears the prior project without a second prompt. A
conditional native beforeunload handler requests a browser warning, not a backup.

Independent review reproduced a response-before-hashchange race in the first
patch: cancelled navigation could leave retained reviews stuck Loading/Sending.
The superseding patch explicitly allows already-started responses and read-only
continuations to use the retained editor identity until navigation commits. New
sends and queued writes still require the raw current route; identity changes and
real route commits invalidate old responses. Nothing is replayed automatically.

The final candidate passes 731 tests across 26 named frontend suites, 30 intervals,
1,108 guarded offline Python cases plus 205 subtests, Ruff, syntax and all 347 HTML
IDs/ten assets. Sixty-three navigation cases are new. Independent final checks
passed 150 cases including 12 boundary assertions. Original data-loss and three
response-race counterfactuals fail against the respective superseded source and
pass against this candidate. All 229 PostgreSQL bodies remain unrun.

Native browser keyboard/focus/dialog/history/unload behavior is still unverified.
The legacy hash-router cancellation restores the active URL by replacing the
traversed history entry rather than its index; duplicate editor URLs can remain.
Browsers can suppress unload warnings. No service, database, credential, permission,
production setting, source publication or deployment was changed.

## 2026-10-12 15:49 UTC: select saved backtests on the chart

The chart Strategy dialog now lists existing private workspace runs in explicit
25-row pages, grouped by strategy and UTC creation date. Exact microsecond ordering
and a 500-row session bound avoid misleading order and unbounded background reads.
Each deliberately chosen run must match its report, version, recorded date range,
organization and synthetic dataset; the report reader and existing source/subset
hash validation run before atomically replacing the chart asset and recorded fills.
Failed or unsupported selections preserve the prior chart. No run, quote, execution,
publication or financial write is started by the picker.

Account, organization, route, dialog, market and selection generations reject stale
completions. Independent review reproduced a pending saved selection completing
after history access denial. The corrected saved-only generation and row-membership
check cancel that selection without invalidating a newer local file import. Existing
file import and run-to-chart handoff remain covered. Native dialog, layout and focus
behavior and live authenticated service integration remain unverified.

The combined candidate passed 754 frontend checks across 27 named suites, 30 chart
interval checks, 1,108 guarded offline Python cases and 205 subtests, Ruff, changed
JavaScript syntax and static HTML/asset integrity. All 229 database-dependent cases
remain unrun. One initial aggregate failure was a storage-signout test injecting an
incomplete internal overlay; its fixture now includes the validator-required range
and metadata, with the clearing assertions unchanged. Independent component review
passed 106 checks including ten independent cases. No browser launch, service or
configuration action, credential access, payment, trade or publication occurred.
