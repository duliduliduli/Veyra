"""Report package (spec §11.1): JSON is canonical; HTML/CSV are derived from it."""

from __future__ import annotations

import hashlib
import html
import json
from decimal import Decimal
from typing import Any

from veyra_sim.metrics import DEFINITIONS

REPORT_SCHEMA_VERSION = 1
RESULT_FIELDS = ("outcome", "bars", "metrics", "execution_model", "quality_findings",
                 "equity_curve", "fills", "rejections", "strategy_logs")


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def digest(obj: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(obj).encode()).hexdigest()


def build(*, run_id: str, outcome: str, manifest: dict, metrics: dict, sim, model: dict,
          quality: list[dict], receipt: dict | None) -> dict:
    body = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "run_id": run_id,
        "outcome": outcome,
        "evidence_grade": "platform-reproduced backtest",
        "evidence_note": ("Synthetic development data. Not market history and not evidence "
                          "of real-world performance." if manifest["dataset"]["provider"]
                          == "veyra-synthetic" else None),
        "complete": outcome == "completed",
        "bars": {"total": sim.bars_total, "processed": sim.bars_processed},
        "metrics": metrics,
        "execution_model": model,
        "quality_findings": quality,
        "equity_curve": [[ts, str(e)] for ts, e in sim.equity],
        "fills": sim.fills,
        "rejections": sim.rejections,
        "strategy_logs": sim.logs[:200],
        "provenance": manifest,
        "receipt": receipt,
    }
    # Identical inputs must yield an identical digest, so it covers the inputs hash and the
    # simulated outputs only - not run/quote IDs or the receipt (wall-clock usage).
    body["result_digest"] = digest({"inputs": manifest.get("run_inputs_hash")} | {
        k: body[k] for k in RESULT_FIELDS})
    return body


def trades_csv(report: dict) -> str:
    cols = ["ts", "client_id", "side", "qty", "price", "fee", "cash_after", "position_after"]
    rows = [",".join(cols)] + [",".join(str(f[c]) for c in cols) for f in report["fills"]]
    return "\n".join(rows) + "\n"


def _svg_line(points: list[tuple[int, Decimal]], w=760, h=220, color="#2563eb") -> str:
    if len(points) < 2:
        return ""
    vals = [v for _, v in points]
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or Decimal(1)
    n = len(points) - 1
    pts = " ".join(f"{i * w / n:.1f},{float(h - (v - lo) / span * (h - 10) - 5):.1f}"
                   for i, (_, v) in enumerate(points))
    return (f'<svg viewBox="0 0 {w} {h}" role="img" preserveAspectRatio="none">'
            f'<polyline fill="none" stroke="{color}" stroke-width="1.5" points="{pts}"/></svg>')


def render_html(report: dict) -> str:
    e = html.escape
    m = report["metrics"]

    def pct(v):
        return "unavailable" if v is None else f"{Decimal(v) * 100:.2f}%"

    def num(v):
        return "unavailable" if v is None else f"{Decimal(v):.2f}"

    eq = [(i, Decimal(v)) for i, (_, v) in enumerate(report["equity_curve"])]
    peak, dd = Decimal(0), []
    for i, v in eq:
        peak = max(peak, v)
        dd.append((i, (v - peak) / peak if peak else Decimal(0)))
    profitable = ("unavailable" if m.get("percent_profitable") is None
                  else f"{Decimal(m['percent_profitable']):.2f}%")
    fills_count = m.get("fill_count")
    if fills_count is None and m.get("version") == "metrics-v1":
        fills_count = m.get("trade_count")
    tiles = [("Percent profitable", profitable),
             ("Closed trades", str(m.get("closed_trade_count", "unavailable"))),
             ("Winning trades", str(m.get("winning_trade_count", "unavailable"))),
             ("Net return", pct(m.get("net_return"))), ("CAGR", pct(m.get("cagr"))),
             ("Max drawdown", pct(m.get("max_drawdown"))), ("Sharpe (rf=0)", num(m.get("sharpe"))),
             ("Volatility (ann.)", pct(m.get("volatility_ann"))),
             ("Fills", str(fills_count) if fills_count is not None else "unavailable"),
             ("Fees", num(m.get("total_fees")))]
    profitable_definition = e(DEFINITIONS["percent_profitable"])
    monthly = "".join(f"<tr><td>{e(k)}</td><td>{pct(v)}</td></tr>"
                      for k, v in (m.get("monthly_returns") or {}).items())
    fills = "".join(
        "<tr>" + "".join(f"<td>{e(str(f[c]))}</td>" for c in
                         ("ts", "side", "qty", "price", "fee")) + "</tr>"
        for f in report["fills"][:500])
    prov = e(json.dumps(report["provenance"], indent=2, sort_keys=True))
    model = e(json.dumps(report["execution_model"], indent=2))
    receipt = e(json.dumps(report.get("receipt"), indent=2)) if report.get("receipt") else "Pending"
    banner = ""
    if not report["complete"]:
        banner = (f'<p class="warn">INCOMPLETE RUN ({e(report["outcome"])}): '
                  f'{report["bars"]["processed"]}/{report["bars"]["total"]} bars. '
                  "This is not a completed performance report.</p>")
    tile_html = "".join(
        f'<div class="tile"><span class="muted">{e(k)}</span><b>{e(v)}</b></div>'
        for k, v in tiles)
    note = f'<p class="note">{e(report["evidence_note"])}</p>' if report["evidence_note"] else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Backtest report {e(report["run_id"])}</title>
<style>
:root{{--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--warn:#b45309}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0f1115;--fg:#e8e8e8;--muted:#9aa;--line:#333}}}}
body{{font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0 auto;
max-width:860px;padding:16px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}}
.tile{{border:1px solid var(--line);border-radius:6px;padding:8px}}
.tile b{{display:block;font-size:18px}} .muted{{color:var(--muted)}}
table{{border-collapse:collapse;width:100%}} td,th{{border-bottom:1px solid var(--line);
padding:4px;text-align:left}} svg{{width:100%;height:220px}}
pre{{overflow:auto;background:rgba(127,127,127,.1);padding:8px}} .warn{{color:var(--warn);
font-weight:600}} .note{{border-left:3px solid var(--warn);padding-left:8px}}
.scroll{{overflow-x:auto}}
</style></head><body>
<h1>Backtest report</h1>
<p class="muted">Run {e(report["run_id"])} · {e(report["evidence_grade"])} ·
result digest <code>{e(report["result_digest"][:23])}…</code></p>
{banner}{note}
<div class="tiles">{tile_html}</div>
<p class="muted">Percent profitable: {profitable_definition}.</p>
<h2>Equity (close-marked)</h2>{_svg_line(eq)}
<h2>Drawdown</h2>{_svg_line(dd, color="#dc2626")}
<h2>Monthly returns</h2><div class="scroll"><table><tr><th>Month</th><th>Return</th></tr>
{monthly}</table></div>
<h2>Fills ({len(report["fills"])})</h2><div class="scroll"><table>
<tr><th>Time (UTC)</th><th>Side</th><th>Qty</th><th>Price</th><th>Fee</th></tr>{fills}</table></div>
<h2>Execution model and limitations</h2><pre>{model}</pre>
<h2>Provenance</h2><pre>{prov}</pre>
<h2>Receipt</h2><pre>{receipt}</pre>
</body></html>"""
