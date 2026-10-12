"""Profitable trades are fee-adjusted, closed position round-trips, never fills."""

from copy import deepcopy
from decimal import Decimal

import pytest
from veyra_sim import metrics, report
from veyra_sim.engine import SimResult


def fill(side, qty="1", price="100", fee="0"):
    return {"ts": "2021-01-01", "client_id": "test", "side": side, "qty": qty,
            "price": price, "fee": fee, "cash_after": "0", "position_after": "0"}


def compute(fills, *, end="1000"):
    return metrics.compute([("2021-01-01", Decimal(end))], Decimal("1000"), fills)


@pytest.mark.parametrize("fills", [[], [fill("buy")], [fill("buy", "2"), fill("sell")]])
def test_no_closed_trades_is_unavailable(fills):
    result = compute(fills)
    assert result["percent_profitable"] is None
    assert result["closed_trade_count"] == result["winning_trade_count"] == 0
    assert result["trade_count"] == 0
    assert result["fill_count"] == len(fills)


@pytest.mark.parametrize(("exit_price", "fee", "winning"), [
    ("110", "1", 1),
    ("90", "0", 0),
    ("100", "0", 0),
    ("101", "0.6", 0),  # profitable before fees, losing after both entry/exit fees
    ("102", "1", 0),  # exactly breakeven after fees
    ("100.000000001", "0", 1),  # classify before presentation rounding
])
def test_winners_require_strictly_positive_net_pnl(exit_price, fee, winning):
    result = compute([fill("buy", fee=fee), fill("sell", price=exit_price, fee=fee)])
    assert result["closed_trade_count"] == result["trade_count"] == 1
    assert result["winning_trade_count"] == winning
    assert Decimal(result["percent_profitable"]) == winning * 100
    assert Decimal(result["total_fees"]) == Decimal(fee) * 2
    assert result["fill_count"] == 2


def test_partial_exits_and_additional_entries_count_as_one_round_trip():
    fills = [fill("buy", "2", "100", "1"), fill("sell", "1", "110", "1"),
             fill("buy", "1", "80", "1"), fill("sell", "1", "90", "1"),
             fill("sell", "1", "100", "1")]
    result = compute(fills)
    assert result["percent_profitable"] == "100.00000000"
    assert result["closed_trade_count"] == result["winning_trade_count"] == 1
    assert result["fill_count"] == 5
    assert result["total_fees"] == "5.00000000"


def test_profitable_partial_exit_does_not_hide_losing_round_trip():
    result = compute([fill("buy", "2"), fill("sell", "1", "110"),
                      fill("sell", "1", "80")])
    assert result["closed_trade_count"] == 1
    assert result["winning_trade_count"] == 0
    assert Decimal(result["percent_profitable"]) == 0


def test_percentage_counts_only_closed_trades_and_is_not_net_return():
    fills = [fill("buy"), fill("sell", price="120"),
             fill("buy"), fill("sell", price="90"),
             fill("buy"), fill("sell", price="100"),
             fill("buy", "10", "20"), fill("sell", "1", "30")]
    result = compute(fills, end="1500")
    assert result["version"] == "metrics-v2"
    assert result["net_return"] == "0.50000000"
    assert result["percent_profitable"] == "33.33333333"
    assert result["closed_trade_count"] == result["trade_count"] == 3
    assert result["winning_trade_count"] == 1
    assert result["fill_count"] == 8


def test_decimal_breakeven_has_no_float_residue():
    result = compute([fill("buy", "0.3", "0.1", "0.01"),
                      fill("sell", "0.3", "0.2", "0.02")])
    assert Decimal(result["percent_profitable"]) == 0
    assert result["closed_trade_count"] == 1
    assert result["winning_trade_count"] == 0


def test_empty_equity_preserves_zero_counts_and_unavailable_metrics():
    result = metrics.compute([], Decimal("1000"), [])
    assert result["net_return"] is None
    assert result["percent_profitable"] is None
    assert result["closed_trade_count"] == result["winning_trade_count"] == 0
    assert result["fill_count"] == 0


@pytest.mark.parametrize("fills", [
    [fill("sell")], [fill("buy"), fill("sell", "2")],
    [fill("short")], [fill("buy", "0")], [fill("buy", "-1")],
    [fill("buy", price="0")], [fill("buy", price="-1")],
    [fill("buy", fee="-0.01")], [fill("buy", "NaN")],
    [fill("buy", price="Infinity")], [fill("buy", fee="sNaN")],
    [fill("buy", "invalid")], [fill("buy", qty=0.1)], [fill("buy", fee=True)],
    [{"side": "buy"}],
])
def test_invalid_or_short_fills_cannot_produce_misleading_statistics(fills):
    with pytest.raises(ValueError):
        compute(fills)


def test_zero_ending_equity_does_not_define_trade_profitability():
    result = compute([fill("buy")], end="0")
    assert result["net_return"] == "-1.00000000"
    assert result["percent_profitable"] is None
    assert result["closed_trade_count"] == 0


def make_report(result):
    return report.build(run_id="test", outcome="completed",
                        manifest={"dataset": {"provider": "veyra-synthetic"}},
                        metrics=result, sim=SimResult(), model={}, quality=[], receipt=None)


def test_report_prominently_distinguishes_profitable_trades_from_net_return():
    result = compute([fill("buy"), fill("sell", price="110")], end="900")
    page = report.render_html(make_report(result))
    assert page.index("Percent profitable</span><b>100.00%") < page.index("Net return")
    assert "Net return</span><b>-10.00%" in page
    assert "Closed trades</span><b>1" in page
    assert "Winning trades</span><b>1" in page
    assert "Fills</span><b>2" in page
    assert "partial exits and execution fees" in page
    assert "breakeven does not" in page
    assert "open positions excluded" in page


def test_historical_metric_absence_is_unavailable_without_mutating_report():
    old = make_report({"version": "metrics-v1", "trade_count": 12, "net_return": "0.6"})
    original = deepcopy(old)
    page = report.render_html(old)
    assert "Percent profitable</span><b>unavailable" in page
    assert "Closed trades</span><b>unavailable" in page
    assert "Fills</span><b>12" in page
    assert old == original
