"""Execute only reviewed bundled examples in-process against synthetic observations.

No StrategyProcess, arbitrary/user source, network, database, or provider is used.
Run with SDK/simulator source directories on PYTHONPATH and stdlib unittest to avoid
the repository's database fixtures. These checks do not establish runtime isolation.
"""

import json
import re
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from veyra_sdk import Bar, Context, Fill, Instrument
from veyra_sim import engine

ROOT = Path(__file__).resolve().parents[1]
INSTRUMENT = Instrument("FIXTURE/USD", "USD", Decimal("0.01"), Decimal("0.1"))
ZERO_COST = engine.ExecutionModel(Decimal(0), Decimal(0))
SOURCE = (ROOT / "apps/web/studio-assistant.js").read_text()
LEGACY = json.loads((ROOT / "tests/fixtures/studio_templates_v1.json").read_text())
CURRENT = {
    name: re.search(rf"  const {constant} = `(.*?)`;", SOURCE, re.S).group(1)
    for name, constant in (("blank", "BLANK"), ("buy_hold", "BUY_HOLD"), ("sma_cross", "SMA"))
}


def bundled_strategy(name, *, legacy=False):
    # This fixed repository allowlist is for trusted examples, never supplied source.
    source = (LEGACY if legacy else CURRENT)[name]
    namespace = {}
    exec(compile(source, f"<reviewed-bundled-{name}>", "exec"), namespace)
    return namespace[{"blank": "MyStrategy", "buy_hold": "BuyAndHold", "sma_cross": "SmaCross"}
                     [name]]()


def bars(closes, opens=None):
    opens = opens or closes
    return [Bar(f"2026-01-{i + 1:02d}T00:00:00Z", Decimal(str(open_)),
                Decimal(str(max(open_, close))), Decimal(str(min(open_, close))),
                Decimal(str(close)), Decimal("1"))
            for i, (open_, close) in enumerate(zip(opens, closes, strict=True))]


class BundledProcess:
    """Tiny synchronous protocol fixture; cannot create a strategy subprocess."""

    def __init__(self, strategy):
        self.strategy = strategy
        self.events = []

    def request(self, message):
        kind = message["type"]
        self.events.append(message)
        if kind == "init":
            self.strategy.initialize(message["config"], INSTRUMENT)
            return {"type": "ready"}
        if kind == "bar":
            b = message["bar"]
            bar = Bar(b["ts"], *(Decimal(b[key]) for key in
                                 ("open", "high", "low", "close", "volume")))
            ctx = Context(Decimal(message["cash"]), Decimal(message["position"]), message["seq"])
            self.strategy.on_bar(bar, ctx)
            return {"type": "intents", "seq": message["seq"], "logs": ctx._logs, "intents": [
                {"client_id": intent.client_id, "side": intent.side, "qty": str(intent.qty),
                 "order_type": intent.order_type} for intent in ctx._intents]}
        if kind == "fill":
            fill = message["fill"]
            self.strategy.on_fill(Fill(fill["client_id"], fill["side"], Decimal(fill["qty"]),
                                       Decimal(fill["price"]), Decimal(fill["fee"]), fill["ts"]))
            return {"type": "ack"}
        if kind == "finalize":
            self.strategy.finalize()
            return {"type": "done"}
        raise AssertionError(f"Unexpected fixture event: {kind}")


class StudioTemplateTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        patch("subprocess.Popen",
              side_effect=AssertionError("No strategy subprocess allowed")).start()
        patch("veyra_sim.sandbox.StrategyProcess",
              side_effect=AssertionError("No StrategyProcess allowed")).start()

    def simulate(self, name, source_bars, *, legacy=False, params=None, model=ZERO_COST):
        proc = BundledProcess(bundled_strategy(name, legacy=legacy))
        result = engine.run(source_bars, INSTRUMENT, proc, starting_cash=Decimal("100"),
                            params=params or {}, model=model)
        return result, proc

    def test_current_sma_is_identical_to_repository_starter(self):
        self.assertEqual(CURRENT["sma_cross"],
                         (ROOT / "templates/strategies/sma_cross.py").read_text())

    def test_blank_never_submits_orders(self):
        result, _ = self.simulate("blank", bars([10, 20, 5]))
        self.assertEqual(result.fills, [])
        self.assertEqual(result.rejections, [])
        self.assertEqual(result.positions, [0, 0, 0])

    def test_buy_hold_retries_rejected_gap_then_holds_actual_fill(self):
        source_bars = bars([10, 20, 10, 8])
        first, proc = self.simulate("buy_hold", source_bars)
        repeated, _ = self.simulate("buy_hold", source_bars)
        self.assertEqual(first, repeated, "Same fixture yields deterministic fills/rejections")
        self.assertEqual(first.rejections, [{"client_id": "0:0-0", "ts": source_bars[1].ts,
                                            "reason": "insufficient_cash"}])
        self.assertEqual(len(first.fills), 1)
        fill = first.fills[0]
        self.assertEqual((fill["client_id"], fill["ts"], fill["qty"], fill["price"]),
                         ("1:1-0", source_bars[2].ts, "4.7", "10"))
        self.assertEqual(Decimal(fill["cash_after"]), Decimal("53"))
        self.assertEqual(first.positions, [0, 0, Decimal("4.7"), Decimal("4.7")])
        self.assertTrue(proc.strategy.entered)
        kinds = [message["type"] for message in proc.events]
        self.assertEqual(kinds, ["init", "bar", "bar", "fill", "bar", "bar", "finalize"])

    def test_buy_hold_regular_entry_is_never_a_same_bar_fill(self):
        source_bars = bars([10, 10, 10])
        result, _ = self.simulate("buy_hold", source_bars)
        self.assertEqual(len(result.fills), 1)
        self.assertEqual(result.fills[0]["ts"], source_bars[1].ts)
        self.assertEqual(result.positions, [0, Decimal("9.5"), Decimal("9.5")])

    def test_buy_hold_repeated_rejections_and_final_intent_expiration(self):
        result, proc = self.simulate("buy_hold", bars([10, 20, 40, 80]))
        self.assertEqual(result.fills, [])
        self.assertEqual([r["reason"] for r in result.rejections],
                         ["insufficient_cash"] * 3 + ["expired_at_end"])
        self.assertEqual(result.rejections[-1]["client_id"], "3:3-0")
        self.assertFalse(proc.strategy.entered)
        result, _ = self.simulate("buy_hold", bars([10]))
        self.assertEqual(result.fills, [])
        self.assertEqual(result.rejections, [{"client_id": "0:0-0", "reason": "expired_at_end"}])

    def test_buy_hold_execution_costs_can_prevent_fills_even_without_a_gap(self):
        source_bars = bars([10, 10, 10])
        result, _ = self.simulate("buy_hold", source_bars, params={"alloc": "1"},
                                  model=engine.ExecutionModel())
        self.assertEqual(result.fills, [])
        self.assertEqual([r["reason"] for r in result.rejections],
                         ["insufficient_cash", "insufficient_cash", "expired_at_end"])
        result, _ = self.simulate("buy_hold", source_bars, model=engine.ExecutionModel())
        self.assertEqual(result.rejections, [])
        self.assertEqual(len(result.fills), 1)
        fill = result.fills[0]
        self.assertEqual((fill["ts"], fill["qty"], fill["price"], fill["fee"], fill["cash_after"]),
                         (source_bars[1].ts, "9.5", "10.01", "0.09509500", "4.80990500"))

    def test_buy_hold_skips_held_position_zero_quantity_and_nonpositive_close(self):
        for position, cash, close in ((1, 100, 10), (0, 0, 10), (0, 100, 0), (0, 100, -1),
                                      (0, Decimal("0.01"), 10)):
            with self.subTest(position=position, cash=cash, close=close):
                strategy = bundled_strategy("buy_hold")
                strategy.initialize({}, INSTRUMENT)
                ctx = Context(Decimal(cash), Decimal(position), 0)
                strategy.on_bar(bars([close])[0], ctx)
                self.assertEqual(ctx._intents, [])
                self.assertFalse(strategy.entered)

    def test_only_buy_fill_marks_entry_and_stops_future_entry_intents(self):
        strategy = bundled_strategy("buy_hold")
        strategy.initialize({}, INSTRUMENT)
        for side in ("sell", "buy"):
            strategy.on_fill(Fill("fixture", side, Decimal(1), Decimal(10), Decimal(0), "fixture"))
            self.assertEqual(strategy.entered, side == "buy")
        ctx = Context(Decimal(100), Decimal(0), 2)
        strategy.on_bar(bars([10])[0], ctx)
        self.assertEqual(ctx._intents, [])

    def test_legacy_buy_hold_keeps_its_documented_single_intent_behavior(self):
        result, _ = self.simulate("buy_hold", bars([10, 20, 10, 8]), legacy=True)
        self.assertEqual(result.fills, [])
        self.assertEqual([r["reason"] for r in result.rejections], ["insufficient_cash"])

    def test_sma_crosses_then_fills_buys_and_sells_on_next_opens(self):
        source_bars = bars([10, 10, 10, 8, 12, 16, 6, 4, 4],
                           [10, 10, 10, 8, 12, 16, 15, 5, 4])
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                result, _ = self.simulate("sma_cross", source_bars, legacy=legacy,
                                          params={"fast": 2, "slow": 3})
                self.assertEqual(result.rejections, [])
                self.assertEqual([(f["side"], f["qty"], f["price"], f["ts"])
                                  for f in result.fills],
                                 [("buy", "5.9", "15", source_bars[6].ts),
                                  ("sell", "5.9", "5", source_bars[7].ts)])
                self.assertEqual(result.positions[:6], [0] * 6)
                self.assertEqual(result.positions[6:], [Decimal("5.9"), 0, 0])
                for fill in result.fills:
                    signal = int(fill["client_id"].split(":")[0])
                    self.assertEqual(fill["ts"], source_bars[signal + 1].ts)

    def test_sma_rejected_crossover_does_not_become_buy_until_filled(self):
        result, _ = self.simulate("sma_cross", bars([10, 10, 10, 8, 12, 16, 6, 4, 4],
                                                   [10, 10, 10, 8, 12, 16, 1000, 5, 4]),
                                  params={"fast": 2, "slow": 3})
        self.assertEqual(result.fills, [])
        self.assertEqual([r["reason"] for r in result.rejections], ["insufficient_cash"])

    def test_invalid_allocation_overrides_fail_clearly_before_any_bar(self):
        invalid = ["NaN", "sNaN", "Infinity", "-Infinity", "0", "-0.1", "1.01", "bad", "",
                   None, True, False, [], {}, float("nan"), float("inf")]
        for name in ("buy_hold", "sma_cross"):
            for value in invalid:
                with self.subTest(name=name, alloc=value):
                    proc = BundledProcess(bundled_strategy(name))
                    with self.assertRaisesRegex(ValueError, "require finite 0 < alloc <= 1"):
                        engine.run(bars([10, 10]), INSTRUMENT, proc, starting_cash=Decimal(100),
                                   params={"alloc": value}, model=ZERO_COST)
                    self.assertEqual([event["type"] for event in proc.events], ["init"])

    def test_invalid_window_overrides_fail_clearly(self):
        invalid = [0, -1, 1.5, 2.0, True, False, None, [], {}, "bad", "2.5", "NaN", "Infinity",
                   "1e2", "9" * 5000, 10001, Decimal("2.5"), float("nan"), float("inf")]
        for key in ("fast", "slow"):
            for value in invalid:
                with self.subTest(key=key, value=str(value)[:30]):
                    strategy = bundled_strategy("sma_cross")
                    with self.assertRaisesRegex(ValueError,
                                                "integer windows.*1 <= fast < slow <= 10000"):
                        strategy.initialize({key: value}, INSTRUMENT)
        for params in ({"fast": 40}, {"fast": 50}, {"slow": 10}, {"slow": 9}):
            with self.subTest(params=params):
                with self.assertRaisesRegex(ValueError, "integer windows"):
                    bundled_strategy("sma_cross").initialize(params, INSTRUMENT)

    def test_valid_override_boundaries_and_numeric_strings(self):
        for alloc in ("0.000001", "1", Decimal("0.5"), 1):
            for name in ("buy_hold", "sma_cross"):
                with self.subTest(name=name, alloc=alloc):
                    strategy = bundled_strategy(name)
                    strategy.initialize({"fast": "1", "slow": 10000, "alloc": alloc}, INSTRUMENT)
                    self.assertEqual(strategy.alloc, Decimal(str(alloc)))
                    if name == "sma_cross":
                        self.assertEqual((strategy.fast, strategy.slow), (1, 10000))
                        self.assertEqual(strategy.closes.maxlen, 10000)


if __name__ == "__main__":
    unittest.main()
