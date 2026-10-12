"""Derived exports preserve canonical report data without launching strategy code."""

import csv
import html
import json
from copy import deepcopy
from decimal import Decimal
from io import StringIO
from types import SimpleNamespace

import pytest
from veyra_sdk import Bar, Instrument
from veyra_sim import engine, metrics, report

COLUMNS = ["ts", "client_id", "side", "qty", "price", "fee", "cash_after", "position_after"]
HEADER = "ts,client_id,side,qty,price,fee,cash_after,position_after\n"
CLIENT_IDS = [
    "", "normal", "comma,value", 'say "hello"', "line\nbreak", "carriage\rreturn",
    "windows\r\nline", 'all,\"three\r\ncharacters', "日本語 🐈", " space ", "x" * 64,
    "=1+1", "+1+1", "-1+1", "@SUM(1,1)", "\t=1+1", "\r=1+1", "\n=1+1",
    "name,=1+1", 'name\",=1+1', "name\n=1+1",
]


def engine_fill(client_id="order", seq=0):
    intent, = engine._validate_intents(
        [{"side": "buy", "qty": "1", "client_id": client_id}], seq)
    bar = Bar("2021-01-02T00:00:00Z", *([Decimal("100")] * 4), Decimal("10"))
    instrument = Instrument("TEST-USD", "USD", Decimal("0.01"), Decimal("1"))
    sim = engine.SimResult()
    engine._fill(intent, bar, instrument, engine.ExecutionModel(), Decimal("1000"),
                 Decimal("0"), sim, SimpleNamespace(request=lambda _: {}))
    fill, = sim.fills
    return fill


def make_report(fills, *, legacy=False):
    sim = engine.SimResult(fills=fills, equity=[("2021-01-02", Decimal("1000"))],
                           bars_total=2, bars_processed=2)
    result_metrics = metrics.compute(sim.equity, Decimal("1000"), sim.fills)
    if legacy:
        result_metrics = {"version": "metrics-v1", "trade_count": len(fills)}
    return report.build(
        run_id="test-export", outcome="completed",
        manifest={"dataset": {"provider": "veyra-synthetic"}, "run_inputs_hash": "test-inputs"},
        metrics=result_metrics, sim=sim, model=engine.ExecutionModel().describe(), quality=[],
        receipt=None,
    )


def test_empty_csv_has_exact_existing_schema_and_lf_terminator():
    text = report.trades_csv({"fills": []})
    assert text == HEADER
    reader = csv.DictReader(StringIO(text, newline=""))
    assert reader.fieldnames == COLUMNS
    assert list(reader) == []


def test_normal_csv_remains_byte_compatible():
    fill = engine_fill()
    text = report.trades_csv({"fills": [fill]})
    assert text == (
        HEADER + "2021-01-02T00:00:00Z,0:order,buy,1,100.05,0.10005000,"
        "899.84995000,1\n"
    )


@pytest.mark.parametrize("client_id", CLIENT_IDS)
def test_engine_client_ids_roundtrip_without_extra_cells_or_rows(client_id):
    fill = engine_fill(client_id, seq=7)
    original = deepcopy(fill)
    text = report.trades_csv({"fills": [fill]})
    rows = list(csv.reader(StringIO(text, newline=""), strict=True))
    assert rows == [COLUMNS, [str(fill[column]) for column in COLUMNS]]
    assert rows[1][1] == f"7:{client_id}"
    assert not rows[1][1].startswith(("=", "+", "-", "@", "\t", "\r", "\n"))
    assert fill == original


def test_multiple_csv_records_preserve_every_value_and_column_order():
    fills = [engine_fill(client_id, seq=seq) for seq, client_id in enumerate(CLIENT_IDS)]
    reader = csv.DictReader(StringIO(report.trades_csv({"fills": fills}), newline=""))
    assert reader.fieldnames == COLUMNS
    assert list(reader) == [{column: str(fill[column]) for column in COLUMNS} for fill in fills]


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("count", [0, 1, 500, 501])
def test_html_discloses_only_truncated_fill_tables_and_exports_stay_complete(count, legacy):
    fill = engine_fill()
    fills = [fill | {"price": str(100 + i)} for i in range(count)]
    result = make_report(fills, legacy=legacy)
    page = report.render_html(result)
    section = page.split(f"<h2>Fills ({count})</h2>", 1)[1].split("</table>", 1)[0]
    assert section.count("<tr>") == min(count, 500) + 1
    for item in fills[:500]:
        expected = "<tr>" + "".join(f"<td>{html.escape(str(item[key]))}</td>" for key in
                                    ("ts", "side", "qty", "price", "fee")) + "</tr>"
        assert expected in section
    if count > 500:
        assert 'class="muted">Showing first 500 of 501 fills.' in section
        assert "CSV and JSON exports include all fills." in section
        assert "<td>600</td>" not in section
    else:
        assert "Showing first" not in section
    assert len(list(csv.DictReader(StringIO(report.trades_csv(result), newline="")))) == count
    assert len(result["fills"]) == count
    assert f"Fills</span><b>{count}" in page
    if legacy:
        assert "Closed trades</span><b>unavailable" in page
        assert "Percent profitable</span><b>unavailable" in page


def test_html_escapes_displayed_report_strings():
    unsafe = '<script>alert("&")</script>'
    result = make_report([engine_fill(unsafe)])
    result.update(run_id=unsafe, evidence_grade=unsafe, evidence_note=unsafe,
                  complete=False, outcome=unsafe, provenance={unsafe: unsafe},
                  execution_model={unsafe: unsafe}, receipt={unsafe: unsafe})
    result["metrics"]["monthly_returns"] = {unsafe: "0.1"}
    result["fills"][0].update({key: unsafe for key in ("ts", "side", "qty", "price", "fee")})
    page = report.render_html(result)
    assert unsafe not in page
    assert "<script>" not in page
    assert f"<title>Backtest report {html.escape(unsafe)}</title>" in page
    assert f'<p class="note">{html.escape(unsafe)}</p>' in page
    assert f"INCOMPLETE RUN ({html.escape(unsafe)})" in page
    assert f"<td>{html.escape(unsafe)}</td>" in page
    assert f"<pre>{html.escape(json.dumps({unsafe: unsafe}, indent=2))}</pre>" in page


@pytest.mark.parametrize("legacy", [False, True])
def test_exporting_preserves_canonical_json_digest_and_metrics(legacy):
    result = make_report([engine_fill('comma,\"quote\"\r\n=1+1')], legacy=legacy)
    original = deepcopy(result)
    encoded = report.canonical_json(result)
    expected_digest = report.digest({"inputs": "test-inputs"} | {
        field: result[field] for field in report.RESULT_FIELDS})
    assert result["result_digest"] == expected_digest
    report.trades_csv(result)
    report.render_html(result)
    assert result == original
    assert report.canonical_json(result) == encoded
    assert result["result_digest"] == expected_digest
    assert result["metrics"] == original["metrics"]
