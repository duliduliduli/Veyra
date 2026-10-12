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
- Publication/deployment evidence will be recorded after verification; this file does not claim deployed completion.

## Rollout notes

Migration 0002 adds metadata and indexes only, with a five-second lock wait and sixty-second statement limit so contention fails transactionally. It is not a zero-downtime migration for a large active database. The existing Railway service is API-only; no worker service is deployed. When deploying a worker elsewhere, drain old jobs and requote outstanding 0.1.0 requests before using 0.1.1. Mixed engine versions fail the existing input-integrity check without customer compute charges.
