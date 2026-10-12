# Report download integrity

Inline and downloaded JSON, HTML and CSV artifacts are read only after existing organization membership checks. The stored artifact receipt must name a string object key and contain an exact integer byte count and matching SHA-256. Exact verified bytes are returned with the existing content type, download name, sandbox CSP and nosniff headers. API responses retain no-store headers and no cache validators.

Missing objects, invalid receipt keys, altered byte counts or mismatched hashes return only a 503 report artifact unavailable. The server does not expose partial bytes, repair storage or rewrite report receipts. Historical valid bytes are unchanged. Schema, financial metrics and canonical result digest semantics are unchanged.

Offline regressions use mocked authorization/SQL plus real temporary ObjectStore and production HTTP middleware, without entering application lifespan or connecting a database. Three stored-corruption integration cases are staged for PostgreSQL CI and remain unrun locally. Native browser/spreadsheet behavior and untrusted production execution are outside this verification.
