# Request-validation responses

The source candidate registers one `RequestValidationError` handler in `create_app`.
Rejected non-finite numbers and lone Unicode surrogates previously caused FastAPI's
default error response to fail JSON/UTF-8 serialization, producing HTTP 500.
The handler returns HTTP 422 without serializing rejected values.

The existing OpenAPI `HTTPValidationError` detail-array contract remains intact:

```json
{"detail":[{"loc":["body"],"msg":"Invalid request; check the request schema","type":"value_error"}]}
```

There is at most one static detail per failed request section, in the fixed order
`path`, `query`, `header`, `cookie`, `body`. Unclassified validation errors receive
one `request` detail. Even thousands of errors produce at most five details and a
512-byte response. Rejected inputs, validator messages, exception contexts, and
nested locations are omitted: location components can themselves contain private
dictionary keys. No input is repaired, normalized, or resubmitted by the handler.

The web client already uses its generic "Request was rejected" message for detail
arrays. No frontend or OpenAPI customization is needed. Consumers no longer receive
per-field messages, paths, or error codes for request validation; the request schema identifies
the fields and constraints.

Actual publication routes reach this same handler inside their existing
`NoStoreRoute` wrapper. Both wrappers retain the existing security/no-store headers.
Domain `HTTPException` statuses, details, and headers are unchanged. Invalid UTF-8
request bodies retain their parser HTTP 400. Unexpected exceptions, internal model
validation, and response-model validation still produce generic HTTP 500; this is
not a broad exception-to-422 conversion.

## Verification

`tests/test_request_validation_responses.py` covers real quote, project, publication,
path/query/header, malformed JSON, and top-level-body rejections; adversarial Unicode,
non-finite values, large error sets, custom validators, exact domain status/header
preservation, unchanged successes, and the OpenAPI schema. It uses explicit test
settings, no lifespan, and fail-closed configuration/database/data/store doubles.
No database or stored object can be touched. Run with:

```sh
uv run pytest tests/test_request_validation_responses.py tests/test_api_cache_policy.py
```

Source-only verification does not establish PostgreSQL integration, browser behavior,
or deployment status. No identity, configuration, permission, financial, or execution
boundary changes are included.
