# Build status against the master spec

Last updated 2026-10-12. See [overnight progress](overnight-progress.md) for the new Studio/history slice and verification limits. Phase: **P1/P2 groundwork, sprint 1 (spec §30)**, plus the
first phone app (business synopsis, stage 1).

## Stage 1 journey (business synopsis) on a phone

| Step | Status |
|---|---|
| Open the app, study a market | Done: touch candlestick chart, 3M/1Y/All, source and license shown |
| Develop a strategy | Python Studio: private device-local snapshots without an account, full-file preservation, folder/settings/duplicate, database APIs behind existing authorization |
| Run a paid backtest | Done: price shown next to Approve; reserve, run, settle |
| Understand the report | Closed-trade percent profitable with explicit definition, equity chart, receipt, HTML/fill CSV/JSON downloads; older metrics remain unavailable |
| Return later | Paginated strategy-grouped run history with all runs reachable; device-local strategies persist only in this browser |
| Watch spending | Done: balance, reserved, spent, usage list |
| Ask AI to write or change code | Built-in offline template/parameter proposals with preview/apply/undo; clearly not AI. Real model connection remains blocked (spec A17) |
| Real data, real payments, real accounts | **Blocked on founder**: data contract, Stripe, Clerk |
| Paper trading, live bots, marketplace | Later stages (3–5) |

## Sprint 1 steps (spec §30)

| # | Step | Status |
|---|---|---|
| 1 | Ownership, brand placeholder, eligible market | **Needs founder.** "Veyra" is used as the placeholder name |
| 2 | Commercial data/payment decisions | **Needs founder.** Work continues on synthetic data meanwhile |
| 3 | Repo, environments, account inventory, CI, budget alerts | Repo + CI done. Accounts/alerts need founder (A01–A25) |
| 4 | Canonical strategy/job/quote schemas + synthetic dataset | Done |
| 5 | Org/project authorization, private file snapshots | Done (dev identity; Clerk pending) |
| 6 | Sandbox job without cross-tenant/secret access | Partial. Process-level only, see ADR 0002 |
| 7 | Exact ledger/reservation + $1 max test job in payment sandbox | Done with the local `dev` provider; Stripe test mode pending |
| 8 | Basic report with manifest and compute receipt | Done (JSON/HTML/CSV) |
| 9 | Kill worker mid-run: no double charge, no orphan, correct release | Done, `tests/test_crash_recovery.py` |
| 10 | Engine benchmark (Nautilus vs LEAN) | Not started (W05) |

## Work items touched

W09 (partial), W11 (synthetic only), W16 (partial), W21 (snapshots, no editor), W24,
W29, W30, W31 (dev provider), W32 (API only), W33, W34 (runtime cap), W35 (receipts),
W36, W41 (in-house engine), W42 (fees/slippage only), W44, W46 (HTML/CSV/JSON; no PDF).

## Blocked on the founder (cannot be done in code)

- Legal entity, brand/domain, initial countries (W01, A01–A02)
- A commercial crypto data agreement (W02, A12). No real market data until then.
- Stripe account and business acceptance review (W03, A10)
- Vendor accounts: AWS, Vercel, Clerk, Neon, Modal, Resend (A04–A09, A19)
- Fee/minimum top-up approval (spec §31). The 5% is still a proposal.

## Next engineering steps (no accounts needed)

1. Web app (`apps/web`, Next.js): sign-in stub, project editor (Monaco), quote/approve
   dialog that shows the ceiling next to the button, job progress, report viewer.
2. Engine benchmark harness (W05) against the golden cases in spec §9.1.
3. Outbox dispatcher + SSE job progress channel.
4. Experiments with parent budgets (W37).
5. Container-based strategy runtime image (ADR 0002 production gate), testable locally
   with Docker.
