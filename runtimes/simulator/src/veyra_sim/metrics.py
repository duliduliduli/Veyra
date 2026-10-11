"""Versioned metric dictionary (spec §11.2). Undefined metrics are ``None``, never 0."""

from __future__ import annotations

from datetime import date
from decimal import Decimal, localcontext

METRICS_VERSION = "metrics-v1"
Q = Decimal("0.00000001")

DEFINITIONS = {
    "net_return": "ending_equity / starting_equity - 1; no external cash flows in backtests",
    "cagr": "(1 + net_return) ** (365 / calendar_days) - 1; unavailable below 30 days",
    "volatility_ann": "sample stdev of daily equity returns * sqrt(365) (crypto trades daily)",
    "sharpe": "mean(daily return) / stdev * sqrt(365); risk-free rate 0; unavailable if stdev=0",
    "max_drawdown": "largest peak-to-trough decline of close-marked equity, as a fraction",
    "max_drawdown_days": "longest calendar span below a prior equity peak",
    "exposure": "fraction of bars ending with a non-zero position",
}


def _s(v: Decimal | None) -> str | None:
    return None if v is None else str(v.quantize(Q))


def compute(
    equity: list[tuple[str, Decimal]], starting: Decimal, fills: list[dict],
    positions_by_bar: list[Decimal] | None = None,
) -> dict:
    with localcontext() as ctx:
        ctx.prec = 34
        out: dict = {"version": METRICS_VERSION}
        if not equity:
            return out | {"net_return": None, "cagr": None, "volatility_ann": None,
                          "sharpe": None, "max_drawdown": None, "max_drawdown_days": None}
        end = equity[-1][1]
        net = end / starting - 1
        days = (date.fromisoformat(equity[-1][0][:10]) -
                date.fromisoformat(equity[0][0][:10])).days + 1
        cagr = None
        if days >= 30 and end > 0:
            cagr = (end / starting) ** (Decimal(365) / Decimal(days)) - 1

        series = [starting] + [e for _, e in equity]
        rets = [series[i] / series[i - 1] - 1 for i in range(1, len(series)) if series[i - 1] > 0]
        vol = sharpe = None
        if len(rets) >= 2:
            mean = sum(rets) / len(rets)
            var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
            sd = var.sqrt()
            ann = Decimal(365).sqrt()
            vol = sd * ann
            sharpe = (mean / sd * ann) if sd > 0 else None

        peak, peak_ts, mdd, mdd_days = starting, equity[0][0], Decimal(0), 0
        for ts, e in equity:
            if e >= peak:
                peak, peak_ts = e, ts
            else:
                mdd = max(mdd, (peak - e) / peak)
                mdd_days = max(mdd_days, (date.fromisoformat(ts[:10]) -
                                          date.fromisoformat(peak_ts[:10])).days)

        monthly: dict[str, Decimal] = {}
        prev_month_end = starting
        for i, (ts, e) in enumerate(equity):
            month = ts[:7]
            last_of_month = i + 1 == len(equity) or equity[i + 1][0][:7] != month
            if last_of_month:
                monthly[month] = e / prev_month_end - 1 if prev_month_end > 0 else None
                prev_month_end = e

        fees = sum((Decimal(f["fee"]) for f in fills), Decimal(0))
        out |= {
            "starting_equity": _s(starting), "ending_equity": _s(end),
            "net_return": _s(net), "cagr": _s(cagr), "calendar_days": days,
            "volatility_ann": _s(vol), "sharpe": _s(sharpe),
            "max_drawdown": _s(mdd), "max_drawdown_days": mdd_days,
            "trade_count": len(fills), "total_fees": _s(fees),
            "monthly_returns": {k: _s(v) for k, v in monthly.items()},
        }
        if positions_by_bar is not None and positions_by_bar:
            out["exposure"] = _s(Decimal(sum(1 for p in positions_by_bar if p != 0)) /
                                 len(positions_by_bar))
        return out
