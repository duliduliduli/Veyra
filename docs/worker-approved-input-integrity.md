# Worker approved-input integrity

The source-only worker preflight now checks the exact request it will execute
against the saved quote and its authorization before starting a strategy process.
Previously it hashed the quote request but executed the separate job config:
changing only job parameters, cash, fees, slippage, runtime or resource class could
pass the approved hash check.

The worker now requires:

- The job, authorization, quote and version to agree on IDs and organization; the
  version lookup also joins its owning project and organization.
- A reserved authorization with the same input hash and maximum amount as the quote.
- The complete job config to match the quote request plus its pinned quote ID,
  input hash, rate version and current engine. Canonical hashes distinguish JSON
  booleans, integers, floats and strings without depending on object key order.
- An available rate card and resource class, the shared saved-source validator's
  exact schema/path/size/hash/entrypoint checks, and the existing recomputed
  code/data/current-engine/rate/request hash.

No transport model is used to normalize saved execution inputs. Existing numeric
JSON values remain valid when unchanged in both approved request and job. Old
engine fingerprints still require a fresh quote. Existing source and reports are
not rewritten, and the worker does not repair mismatched inputs automatically.

Runtime and decimal conversions happen after preflight, inside the worker's
platform-fault handler and before process launch. Preflight failures retain zero
billed seconds rather than being classified as customer strategy failures.

## Verification and limits

The targeted tests use intercepted database/object reads and inert source text.
They cover job-only input drift, nested JSON type changes, legacy numeric values,
identity and organization mismatches, source integrity, stale engine/data hashes,
and zero-billing classification. Source, strategy processes, simulations and live
PostgreSQL are not executed by these checks. Full PostgreSQL lifecycle and settlement
verification remain required before release.

Unknown or corrupted persisted billing rate/resource metadata still requires
operator repair: the existing settlement path cannot safely finalize such a job.
The worker refuses execution and classifies it as a platform fault, but supplies
no fallback rate and does not alter the ledger or claim successful settlement.
The combined candidate adds the shared [settlement identity guard](settlement-integrity-guard.md)
before financial posting, covering both jobs and unused reservations. Corrupted
authorization amounts or organizations are held for operator review; they are not
repaired or automatically released. Scheduler progress around held records remains
a separate resilience gate.
The local/test environment gate and production-isolation limitations are unchanged.
This is an unpublished source candidate, not a deployed runtime change.
