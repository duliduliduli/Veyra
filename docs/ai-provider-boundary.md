# Studio provider boundary and remaining integration gates

Status: tested offline candidate, no provider configured. 2026-10-12.

## Scope and existing contracts

Reviewed the master app spec §13, relevant trust/billing/privacy sections, ADR 0004,
the API authentication and project-snapshot patterns, and the repository instructions.
The change reaches one new module, its unit fixtures/tests, and these documents.
No existing caller, fixture, export, configuration, dependency or endpoint changes.

The current browser offline helper stays separate. A provider proposal must never
be forged into that helper's issuance mechanism. This module does not save/apply
anything, import/compile/run proposed Python, or assert its correctness or safety.

## Small callable contract

`OpenAIEditAdapter(config, admission=..., transport=...).propose(request)` either
returns an immutable `Proposal` or raises a sanitized `BoundaryError` code.
Constructing the adapter with no arguments is safe and disabled. No HTTP transport
implementation or configuration loader is shipped.

- `Snapshot`: tenant, project, immutable version ID, entrypoint and the explicitly
  selected Python files. A selection must include the entrypoint. Its source hash
  uses the app's canonical `{files, entrypoint}` SHA-256 format. A partial selection
  has its own hash; do not confuse it with a larger project's stored content hash.
- `EditRequest`: unique request ID, snapshot/hash, prompt, exact selected model,
  maximum output tokens, nano-USD request budget, recorded consent ID, explicit
  `share_private_source=True`, and permitted editable paths. File creation/deletion
  and edits outside that selected set are not supported.
- `ProviderConfig`: explicit enabled flag, server-maintained model/catalog version,
  opaque secret reference, routing/privacy/region policy versions, reviewed rate
  card and request/rate/time limits. There is no endpoint override. The sole wire
  destination is `https://api.openai.com/v1/responses`.
- `PriceCard`: immutable version, source URL, retrieval/expiry timestamps and
  explicit rates for input, cached input, cache-write input, output and reasoning
  units, in nano-USD per million tokens. Rates have no defaults. An explicit zero
  means a reviewed zero rate; an unknown rate is not zero and must block admission.
- `Proposal`: full contents of changed permitted files, explanation, base hash,
  snapshot identity, selected model/catalog and policy provenance, price version,
  supplier response/request IDs and observed token usage. It requires review.

Strings are UTF-8 byte bounded; selected and resulting files together are capped
at 100,000 bytes and 20 files; prompt at 4,000 bytes; output at 8,192 tokens;
response body at 512,000 bytes. These are implementation ceilings, not a cost quote.
Strict schema generation and local parsing both reject malformed proposals.
JSON duplicate keys, non-finite numbers, unsafe paths, duplicate files, unexpected
tools/output forms, model mismatch, incomplete/refused responses, no-op proposals,
wrong base hashes and oversized/unknown usage are rejected. An optional reasoning
item may accompany the sole assistant message; it is never shown or acted upon.

No arbitrary request fields or model tools are forwarded. The payload sets tools
empty, tool choice none, streaming off, truncation disabled and storage false.
Private identity, consent/budget IDs, policies and credential references are not
sent in the prompt. Selected source/prompt remain untrusted text, not authority.

`validate_edit(raw, request, current_snapshot)` is a pure structural and stale-base
recheck. It checks tenant/project/version identity as well as source bytes. It is
not an issuance or authorization token and must not become a public apply endpoint.

## Required trusted admission/accounting implementation

`Admission.reserve(request, config, payload, request_digest)` must complete all
checks atomically and return a `Reservation` bound to both the request digest and
the exact wire payload digest. The adapter checks those bindings, pinned price,
reserved amount versus approved request cap, and the declared input-token ceiling.
It never treats a browser's declaration as an authorization decision.

The implementation must verify the authenticated principal, actual tenant membership,
source ownership/entitlement and immutable version; look up explicit valid owner
consent bound to this exact selected context/provider/model/policy; enforce secret
exclusion and protected-seller-source restrictions; resolve a supported exact model
version from the reviewed catalog; and confirm provider privacy/region capability.
Consent booleans and IDs in the request alone do not establish any of these facts.
The authenticated route supplies the principal to its trusted admission implementation;
it is not taken from an untrusted browser request or model response.

Use the existing transactional billing ledger, not a second in-memory money system.
Count or conservatively bound the **entire exact payload** including schema/prompt
and provider overhead using a verified model-specific contract. Compute a safe
upper cost against the pinned rate card without double-counting cached/reasoning
subsets. Reserve it within the approved request and parent-session caps, enforce
the configured rate limit, and atomically grant a **one-time dispatch claim**. Reject
every replay or concurrent duplicate, including a request with identical contents.
Simply returning an existing reservation is unsafe here: it would cause another
supplier dispatch. An API may return a previously persisted completed result outside
this adapter. There are
no tool charges because tools are absent; if the provider introduces another billed
category, the pricing contract must be reviewed before use.

Before returning, durably journal the potential supplier dispatch with reservation,
payload/request hash, tenant/budget and selected model/catalog/routing/privacy/region/
price provenance. A crash or invalid reservation after this point must remain
recoverable and pending; do not automatically release or redispatch it. The test
admission is only a fixture, not a production implementation of these controls.

`Admission.record(UsageEvent)` is called once after every attempted transport call,
including HTTP failure, timeout, malformed response and refusal. If recording fails,
the adapter withholds the proposal with `accounting_pending`; the pre-dispatch
journal supplies the recovery anchor. Keep the reservation pending until supplier
reconciliation in every case, including success. Never interpret validation failure
as proof that the supplier did not bill, retry automatically, or release unknown cost.

Input/output totals, cached input, cache-write input and reasoning counts are observed
supplier usage, not billed invoice amounts. Missing optional unit details remain
`None`, not invented zeroes. Usage retained from an invalid proposal is still available
to reconciliation. Unknown/malformed usage remains pending with no inferred charge.
No customer debit, rate arithmetic, vendor invoice reconciliation, refund, price
guarantee or automatic reservation release is implemented in this boundary.

## Remaining gates before live use

1. Production authentication stays fail-closed. Add an authenticated route only after
   tenancy, context/consent, safe error/status mapping and source ownership tests pass.
2. Separately authorize provider account, applicable terms, credential/access setup
   and cost exposure. Supply reviewed current pricing and model/catalog selections.
3. Implement and test the admission/ledger contract above, especially concurrent
   budget/rate limits, consent revocation, crash recovery, cancellation, idempotency,
   supplier reconciliation and customer ceilings. The adapter alone is not a cap.
4. Supply an audited transport that resolves only the server credential reference,
   verifies TLS, pins the exact official endpoint, refuses redirects/proxies to
   arbitrary destinations, enforces the deadline and response byte cap while reading,
   and performs no retries. The in-memory parser limit cannot cap a live socket read.
5. Persist a tenant-bound issued proposal record. UI must display exact full source
   or diff as text, show model/provider and estimates truthfully, and require explicit
   Apply. Reload fresh source, validate issuance and authorization, then perform the
   stale-base recheck atomically with application. Serialized client proposals alone
   must never authorize an edit. Saving/running/publishing/deploying remain separate.
6. Test live provider capability and model-specific response behavior in a separately
   approved test before describing this as a connected AI coding assistant.

Provider model output can still contain mistaken, unsafe or misleading code/prose.
Schema/path validation is not a Python sandbox, secret detector, strategy audit,
investment recommendation, proof of performance, or proof that no charge occurred.

## Official API references checked

The request/response wire shape was checked against current official documentation
on 2026-10-12, after reading the local OpenAI guidance:

- [Responses create reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create)
- [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)

The implementation uses a strict `text.format` JSON schema and handles incomplete
responses/refusals without accepting an edit. `max_output_tokens` also bounds reasoning
tokens. `store=False` is a request setting, not a zero-retention or regional-processing
guarantee. No real model ID, price, account access or provider privacy assurance was
inferred from these docs, and no provider request was made.
