# Backtest parameter JSON

Quote input is one JSON object. The browser validates parameter text before sending
`POST /v1/quotes`; the API applies the shared `QuoteIn` validation before loading
bars, reading a project version or inserting a quote. Rejected text stays in the
editor for correction. Repricing or editing invalidates the displayed quote; an
invalid replacement cannot authorize the old quote or restore a stale response.

## Value contract

- Nested objects, arrays, null, booleans, strings and finite numbers are supported.
  Object keys are strings. Python-only values such as tuples, sets and Decimals
  are rejected when constructing the model directly rather than coerced.
- After standard JSON number parsing, integer-valued numbers must be between
  -9007199254740991 and 9007199254740991, inclusive, whether written as integer,
  decimal or exponent notation. This is
  the common exact integer range of JavaScript numbers. Use JSON strings for
  exact decimals and larger integers. Overflow such as `1e999`, and non-JSON `NaN`/`Infinity`
  values accepted by some server parsers, are rejected rather than becoming null.
- Strings and keys must be valid Unicode, without unpaired surrogates or U+0000
  (NUL). PostgreSQL JSONB cannot store NUL. Valid supplementary characters and
  escaped controls such as tab, newline, U+0001 and carriage return are preserved.
  Unescaped JSON control characters remain syntax errors.
- At most 16 nested containers are permitted, counting the root object as one.
  Both objects and arrays count, including empty containers; scalar leaves do not.
  This small bound supports ordinary parameter groups while avoiding recursion
  failures on deeply nested input.
- The serialized object is limited to 8192 bytes (8 KiB) of compact UTF-8 JSON.
  The API's `json.dumps(..., ensure_ascii=False, separators=(",", ":"),
  allow_nan=False)` byte count is authoritative. This replaces the previous
  8192-character limit on ASCII-escaped, spaced JSON. The browser preflights its
  compact JSON serialization; Python and JavaScript can spell the same number
  differently, so a near-limit object may still receive a server 422. In
  addition, browser input text is capped at 32768 UTF-8 bytes before parsing,
  allowing ordinary formatting whitespace while bounding client parsing work.
  These are parameter limits, not a new HTTP request-body-size policy.

The validators reject rather than rewrite values. They do not trim strings,
truncate containers, drop keys, substitute null for nonfinite numbers or coerce
unsafe integers into strings. JSON parsing/serialization still uses the standard
platform number semantics: decimal fractions use binary floating point. For
example, `9007199254740990.9` rounds to `9007199254740991`, and a long decimal
fraction may round to the nearest representable binary64 value before validation.
Lexical number spelling, whitespace, duplicate-key spelling and negative-zero
spelling are not an exact-source preservation format. Use strings for exact
decimal values or numeric text. No arbitrary-precision parser is added.

## Immutable quotes and saved approvals

Valid values still follow the existing request serialization, quote digest and
immutable approval identity. The safe validator errors use explicit HTTP 422
string details instead of echoing rejected values: the default FastAPI validation
error response itself cannot serialize a rejected infinity or unpaired surrogate.
This is deliberately scoped to the parameter validator.

Saved approval discovery validates the original parameter values before encoding,
then applies the same complete `QuoteIn` model validation. Its envelope limit
remains 16384 bytes, now counted on compact UTF-8 JSON so a valid 8 KiB Unicode
parameter object is discoverable. An old stored request outside the new contract
is left untouched and reported through the existing generic 503
`authorization inputs unavailable`, with no partial page, unsafe content, writes,
automatic repricing or new approval. This change does not migrate or repair older
stored values. Discovery now fails closed for them.

## Local verification

- `node --test tests/e2e/backtest-params.mjs`
- With jsdom installed, `node --test tests/e2e/backtest-approval-ui.mjs
  tests/e2e/studio.mjs tests/e2e/approval-recovery-ui.mjs`
- `pytest tests/test_quote_params.py tests/test_authorization_discovery.py`

The checks use pure values, synthetic DOM fetch responses and in-process FastAPI
routes with mocked data/database boundaries. They cover integer and UTF-8
boundaries, depth, invalid Unicode, controls, rejection before quote effects,
unchanged valid request/hash inputs, saved discovery failures and stale/current
quote invalidation. No strategy source, actual StrategyProcess, PostgreSQL,
network service, native browser or production account is used. Real PostgreSQL
and browser QA, normal database-backed CI and publication remain separate gates.
