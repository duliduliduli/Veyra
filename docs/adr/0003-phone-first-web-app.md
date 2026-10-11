# ADR 0003: Phone-first web app without a framework (for now)

Status: accepted · 2026-10-11

## Context

The business synopsis puts the whole core journey on a phone: study a market, edit
Python, price and approve a backtest, read the report, watch spending. The spec proposes
Next.js on Vercel (§5.1). For the six screens stage 1 needs, that adds a build toolchain,
hundreds of packages and a second deployment.

## Decision

- `apps/web` is plain HTML, CSS and JavaScript, served by the control API. One origin, so
  there is no CORS, and a strict CSP: scripts and styles from `'self'` only.
- One dependency: TradingView Lightweight Charts 4.2.0. It is the library the spec names,
  is vendored with its Apache-2.0 license and NOTICE, and shows the required attribution
  (chart logo plus footer link). Its single injected style is allowed by hash.
- Hash routing (`#run/<id>`), so the back button and reloads return to the same place.
  Runs are server-side, so closing the app never stops or loses them.
- The editor is a plain textarea plus a symbol bar. Monaco and similar editors work badly
  on phone keyboards. Drafts autosave on the device, and saving creates an immutable
  version. Getting a price saves first, so the quote always covers the code on screen.
- The app holds no money logic. It formats the server's nano-USD integers exactly
  (BigInt, half-even like `format_usd`).

## Revisit when

- Screens need shared state or components beyond what one file stays readable with.
  That is the point to adopt a framework, not before.
- Real accounts: replace the dev sign-in header with Clerk sessions (W09), and replace the
  dev payment completion with Stripe Checkout (W31).
- Traffic: move static files to a CDN.
