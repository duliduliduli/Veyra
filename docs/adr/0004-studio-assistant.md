# ADR 0004: Honest offline Studio assistance and a gated provider boundary

Status: accepted for the offline slice; provider contract proposed · 2026-10-12

## Context

The Studio needs assistance below its Python editor, including reviewable edits. Spec
§13 also requires private-source controls, provider provenance, bounded spending, and
truthful results. No AI provider or credentials are configured. A simulated chat model
would misrepresent capability; a direct browser-to-provider integration would expose
credentials and bypass spending and tenant controls.

## Decision

Ship a deterministic, dependency-free helper in `apps/web/studio-assistant.js`. Label
it **Built-in offline helper** and state that no AI provider is connected. It supports
only a documented command list: generate a blank, buy-and-hold, or SMA starter;
describe the current SDK; and propose an explicit `fast`, `slow`, or `alloc` default
change. It does not explain arbitrary code or claim to be an LLM. Unsupported requests
have an explicit state and do not fall back to fabricated responses.

The module has no DOM, network, storage, credential, logging, or execution access. Its
only state is a weak set of proposals it created, used to reject forged or restored
proposals. It never executes Python and never saves a strategy, creates a quote or job,
spends credit, installs a dependency, publishes a strategy, or deploys live trading.
Existing editor autosave/save behavior remains the responsibility of the application.

### Current browser contract

Browser global: `VeyraStudioAssistant`. CommonJS exports the same object for tests.

- `propose({code, prompt})` returns a frozen object with `kind`, `status`, `message`,
  `source: "built-in-offline"`, exact `base_code`, and `proposed_code`.
- `kind` is `template`, `parameter`, `sdk`, `help`, `input`, or `unsupported`.
- `status` is `proposal`, `info`, `unsupported`, or `invalid`. `proposed_code` is null
  unless status is `proposal`. Blank input returns command help.
- `applyProposal(currentCode, proposal)` returns `{status, code, message}`. Status is
  `applied`, `stale`, or `invalid`. This is a pure return value; the caller updates the
  editor only for `applied`. It accepts only a proposal issued by this module instance.
- `templates` exposes the three starter source strings. `capabilities` identifies
  offline mode, an `unconfigured` provider, null provider/model, no network or code
  execution, and no arbitrary-code explanation capability. `source` and `help` are
  also exported. Capability objects and templates are frozen.

Template replacement must show the complete proposed code and clearly warn that it
replaces editor contents. Parameter previews describe the old and new defaults; run
configuration can override source defaults. The UI must show the proposed change and
require an explicit Apply action. It must use text rendering, never interpret code or
helper messages as HTML. Exact base-source equality is checked at Apply; intervening
editor changes block application. No hash collision can discard edits because this
version compares full strings. The UI should retain one undo snapshot and restore it
only if the editor still equals the applied code. Undo must not discard later edits.
Changing project or signing out must discard proposal/undo state. Serialized proposals
cannot be restored after reload; request a new one.

### Deliberately narrow editing

Commands are whole-input matches, not free-form intent inference. Examples:

```text
create blank
create buy and hold
create SMA crossover
explain SDK
set fast to 12
set slow = 60
set alloc to 0.5
help
```

Parameter changes are limited to exact known scaffolds, with previously edited
numeric defaults and CRLF line endings supported. Custom code, added comments, changed
class names, and ambiguous occurrences are rejected. Matching then reconstructing the
entire scaffold prevents edits inside arbitrary Python comments, strings, or unrelated
expressions without pretending a regular expression can parse Python.

Proposed source-default edits require `1 <= fast < slow <= 10000` and allocation
`0 < alloc <= 1`, at most six decimal places, and no exponent notation. This helper
does not inspect or validate separately supplied run configuration.

Newly created starter source now validates its own runtime overrides at initialization:
both starters require a finite allocation in `0 < alloc <= 1`; SMA requires integer
windows (Python integers or integer strings, excluding booleans/floats) with
`1 <= fast < slow <= 10000`. Invalid values raise a clear `ValueError` before bars or
orders. Runtime allocation accepts Decimal-compatible numeric text; the editor's
six-place/no-exponent restriction applies only to helper commands. The new SMA source
is intentionally identical to `templates/strategies/sma_cross.py`; tests detect drift.

The revised buy-and-hold example submits at most one entry intent per closed bar
while flat, until an actual buy fill invokes `on_fill`. A rejected next-open order
may therefore be retried with a quantity sized from the next observed close. It stops
submitting after a buy fill. This does not guarantee a fill: gaps, fees, lot rounding,
or the end of the dataset can prevent one. SMA still submits only on crossovers; its
signal behavior has not changed. All templates are examples with no performance evidence.

This is an explicit template revision. Previously issued v1 buy-and-hold source keeps
its documented one-intent/no-retry behavior, and v1 SMA keeps its previous validation.
Both exact v1 scaffolds remain recognized for numeric-default-only edits, including
earlier parameter edits and CRLF endings. Loading saved source never upgrades it.
Only explicit new template creation and review/Apply replaces editor contents;
Undo restores the exact previous source. Existing stored versions remain unchanged.
Input is bounded to 100,000 source characters and 500 prompt characters.

## Future provider adapter contract (not implemented or connected)

Provider capability must remain `unconfigured` until a server-side adapter passes
configuration and policy validation. Do not add an API key field or arbitrary provider
URL field to the browser. A configured adapter must meet these requirements before
network traffic can be enabled:

1. Select a provider and exact model/version from a server-maintained allowed catalog;
   reject unknown IDs, arbitrary endpoints, missing secret references, stale pricing,
   or absent privacy/region policies. Credentials are server-managed and never appear
   in browser bundles, prompts, logs, or exports. Creating persistent credentials or
   changing provider access needs a separate authorized operation.
2. Authenticate the tenant, check source ownership/entitlement and context-sharing
   policy, and obtain the owner's applicable permission before sending private source.
   Never include protected seller source, secrets, unrelated documents, or browser
   history. Source comments and model output cannot change these permissions.
3. Reserve an upper request/session spending bound against a pinned price version
   before dispatch. Bound input, output, retries, and tool counts; no qualifying
   provider means fail closed. Zero configured providers must never silently fall back
   to a paid model. Provider fallback requires approved privacy, region and price limits.
4. A proposal request should contain request ID, project/version, mode (`explain` or
   `propose`), the permitted source context and cryptographic base hash, prompt,
   approved provider/model and price version, context policy, and budget authorization.
   The server derives and validates tenant, access, prices, and authorization; it must
   not trust these claims merely because a client sent them.
5. Return request ID, provider/model/version, routing/privacy/price provenance, bounded
   usage estimate, supplier request ID, plain-text explanation, structured patch or
   full proposed source, base hash, and explicit status. Reconcile actual billed units
   afterward with no customer charge above the approved maximum. Never report a run
   or performance result without an authorized job and its immutable artifact.
6. Treat model output as untrusted data. Validate response size and patch paths, reject
   malformed/stale proposals, display the exact diff, and require user approval before
   editor application. Apply is separate from saving, executing, billing, publishing,
   and deployment. A provider proposal needs its own validated issuance path; it cannot
   be passed through the offline helper's weak-set boundary by fabricating an object.

No endpoint, adapter networking, key collection, billing workflow, or provider
configuration UI is added in this slice. Provider-backed editing needs integration
tests for tenant isolation, context disclosure, cancellation, idempotent retries,
untrusted output, budget reservation/reconciliation, and stale-editor protection.

## Verification and limits

Run `node tests/e2e/studio-assistant.mjs`. Tests cover both CommonJS and the browser
global in a context where DOM, network, storage, and execution-related services throw;
template replacements; supported edits; source preservation; stale/forged proposals;
invalid parameters; and unsupported or instruction-injection-like prompts.

These are dependency-free module contract tests, despite their `tests/e2e` location.
They do not claim full browser UI coverage, Python runtime validation, strategy safety,
investment suitability, model integration, or performance evidence. The separate
`tests/test_studio_templates.py` executes only these reviewed bundled sources in-process
with a tiny synchronous protocol fixture, SDK observations, and the real simulator on
synthetic bars. It covers deterministic rejection/retry/fill timing, final expiration,
SMA entry/exit timing, and override validation, with subprocess creation prohibited.
`tests/e2e/proposal-diff-ui.mjs` also checks saved v1 source preservation through
preview, Apply, Undo, and explicit replacement. Neither check runs arbitrary/user code
or establishes production isolation. See [focused evidence](../studio-template-revisions.md).
