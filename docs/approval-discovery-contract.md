# Personal approved-backtest discovery

Local source candidate only. Nothing here deploys, migrates, starts a worker, changes
configuration, or enables production billing/recovery. The existing production
identity boundary remains closed (HTTP 401).

## API and scope

`GET /v1/orgs/{org_id}/authorizations` requires existing authentication, current
organization membership and `CAN_RESEARCH` (owner or researcher). Even owners see
only authorizations whose `approved_by` is their own principal. Viewer and billing
admin roles receive 403; missing membership receives 404. Every page rechecks these
permissions. Organization, project and cursor parameters never broaden visibility.

Query parameters:

- `limit`: integer 1–100, default 50. The implementation reads at most limit + 1 rows.
- `cursor`: optional URL-safe base64 JSON `[created_at, id]`, at most 512 characters.
  Timestamp must be timezone-aware; IDs must be UUIDs. Malformed cursors receive 422.
- `project_id`: optional UUID filtering the original saved version's project. A
  nonexistent or other-tenant project returns an empty page, without an extra lookup.

Response envelope: `authorizations`, `next_cursor` (string or null), `has_more`
(boolean), and `as_of` (server PostgreSQL timestamp). Rows are ordered by immutable
`created_at DESC, id DESC`, with a strict tuple boundary. Follow `next_cursor` while
`has_more`; history is not truncated to the first 100 approvals. A new approval
inserted above an existing cursor appears after refreshing from the beginning, not
in the older continuation. Tied timestamps remain deterministic by UUID order.
Cursors are navigation boundaries, not capabilities or a historical snapshot.

Each row contains exactly:

- `id`, `quote_id`, `project_id`, `project_version_id`, `version_no`
- `project_name`: the project's **current name**, which clients must label as current
- `content_hash`: original immutable version content hash
- `input_hash`: original authorization/quote input identity
- `request`: exact saved values for `project_version_id`, `dataset_id`, `start`, `end`,
  `starting_cash`, `params`, `resource_class`, `max_runtime_seconds`, `taker_fee_bps`,
  and `slippage_bps`. Decimal strings retain their saved precision. The existing
  quote validator bounds serialized params to 8 KiB; discovery also bounds the
  allowlisted request to 16 KiB and uses the existing model's strict JSON parser
  nesting limit. It does not fill defaults, normalize saved values,
  return unknown fields, or substitute current editor/version inputs.
- `reserved_nano`: exact approved integer nano-USD ceiling, without display rounding
- `created_at`, `claim_expires_at` (original creation plus the fixed 15-minute window)
- `status`: original `reserved` or `settled`
- `job`: null or only `{id, state}`
- `recovery_state`: one of the four states below

No source files, source code, storage keys/objects, project descriptions/folders,
other users' identities, provider credentials, job configuration, or billing receipts
are joined into the response. `params` contains the user's saved backtest parameters;
clients should display it as plain text, like other user-controlled strings.
Missing, malformed, oversized or excessively nested saved request data, a saved
request/version mismatch,
or a quote/authorization input-hash mismatch fails the page with sanitized HTTP 503
`authorization inputs unavailable`. No partial consent is presented as resumable.

## Recovery meaning

`as_of` is PostgreSQL's `statement_timestamp()` selected in the same statement as
nonempty rows, giving one statement observation for the row metadata and deadline
classification. An empty page uses a standalone PostgreSQL wall-clock read. It is
an advisory observation, never an extension or guarantee of claimability: subsequent
commits and time can change the state before the response arrives or the user acts.

- `used`: any job exists, regardless of its state, authorization status or age.
  This wins over all other states. Link to that job; do not submit it again.
- `released`: no job and authorization status `settled`; the unused reservation has
  already been closed by the existing recovery flow.
- `expired_pending_release`: no job, status `reserved`, and claim deadline at or
  before `as_of`. Consent has expired, but reserved credit can still be held. Merely
  opening or refreshing this page never releases it.
- `claimable`: no job, status `reserved`, and claim deadline after `as_of`.

Only an explicit Resume uses the existing `POST /v1/jobs` with the original `id` as
`authorization_id` and canonical `quote-{quote_id}` idempotency key. Do not authorize
again, create another quote, silently retry a financial action, or send current
editor inputs. The POST's existing lock, clock and idempotency checks remain
unchanged and authoritative. A concurrent job claim can yield an existing job or
409; a late unused claim can yield terminal 410. Refresh discovery to resolve
uncertain or conflicting results. An expired or released approval requires a new
price and new explicit consent through the ordinary approval flow.

## Read-only boundary and limitations

The discovery handler and its membership check execute SELECTs only. They do not
lock for mutation, reserve, release, settle, renew, create jobs/events/audit entries,
read source objects, or execute strategies. Existing local/test `authenticate()`
performs its pre-existing `users` upsert; that identity bookkeeping is explicitly
outside this discovery-domain read-only guarantee. Authentication code and all
financial/write endpoints are byte-for-byte unchanged by this feature.

Existing `/v1/` middleware supplies `Cache-Control: no-store`, removing validators
for successes and errors. No migration or index was added. Page size bounds returned
rows, not database scanning/sorting work; large approval histories require query-plan
measurement before scale claims. Discovery alone does not deploy passive release:
the API-only deployment still has no separately enabled recovery scheduler.

## Verification and release gates

`tests/test_authorization_discovery.py` uses only synthetic rows, clock values,
SQL/ledger doubles and in-process HTTP. It covers exact identity and field allowlists,
all four recovery states and every job state, roles/membership, principal/tenant
query scope, request corruption, strict cursor validation, tied pagination beyond
100, concurrent newer insertion, no write calls, production identity rejection and
no-store middleware. These are offline contracts, not PostgreSQL proof.

`tests/test_authorization_discovery_postgres.py` stages disposable-database cases for
exact saved identity after rename/new-version/quote expiry, unchanged domain snapshots
on repeated reads, all job states, expired versus actually released credit, personal
and tenant isolation, role rejection/revocation, tied keyset traversal with a concurrent
writer, project filtering, and a canonical original-authorization resume with one
reservation. They are deliberately deselected by `-p no_db`, not marked passing.
Running those cases against an approved disposable database, plus the existing
reservation race suite, remains a release gate. No live database, real browser,
worker, financial action, deployment or remote write was exercised here.
