# Development payment webhook gate

Source-only candidate, 2026-10-12. This does not establish deployment or runtime configuration.

`POST /v1/webhooks/payments/dev` belongs to a separate router, mounted only when the
existing `Settings.dev_auth_enabled` predicate accepts the exact `local` or `test`
environment label. The URL and signed development-event handling are unchanged in
those environments. The local checkout stand-in retains its existing gate.

For every other label, including production, staging, unknown, empty, mixed/upper case
and whitespace-padded values, the webhook has no application route or OpenAPI entry.
Requests cannot reach its dependencies, signature verification, event application,
database transaction or ledger credit. The static-file fallback may return 404 or
405 for an absent POST; rejection status alone is not the security boundary. Existing
API no-store and security headers still apply.

Authentication, dependencies, settings loading, other billing routes and payment-event
semantics are unchanged. This is not a real payment-provider integration and does not
claim that all billing is disabled.

## Verification and release limits

The focused offline tests construct synthetic `Settings` explicitly, use a local
FastAPI `TestClient` without lifespan startup, and substitute fake database/ledger
objects. They assert route/OpenAPI absence, no dependency or payment side effects,
local/test signed-event compatibility, and missing, malformed, wrong, stale and
tampered signature rejection. They do not contact a server, database or provider.

All 26 focused cases pass; against the unchanged baseline, the 14 denied-label
cases fail and the 12 local/test compatibility cases pass. The filtered offline
backend run passes 505 cases and 116 subtests, with 167 PostgreSQL-dependent cases
deselected and chart/report compatibility excluded. Ruff passes. These are local
source checks, not a full integration or deployment pass.

- Production account access remains closed in the current source; that authentication
  boundary alone does not establish the state of an unauthenticated payment webhook.
- The deployed webhook configuration is unverified. This patch has not been uploaded,
  deployed or tested against a live endpoint.
- `APP_ENV` still defaults to `local` when unset, and the development-secret fallback
  remains unchanged. An unset or incorrectly local/test-labeled deployment therefore
  remains a prelaunch deployment-label concern. This guard is not a substitute for
  verifying deployment configuration before release.
- PostgreSQL payment/ledger integration, production identity, approved real payment
  configuration and deployment verification remain separate release gates. Offline
  mocks do not establish database atomicity or real-provider readiness.

No credentials, runtime settings, security permissions, real resources, external
endpoints, provider integrations or deployed secrets were read or changed for this fix.
