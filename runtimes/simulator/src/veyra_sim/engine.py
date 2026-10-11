"""Bar-based simulation. The engine, not the strategy, owns time, fills and balances.

Fill model (declared in every report):
- An intent emitted after bar *t* closes fills at bar *t+1* open. No same-bar fills,
  so a strategy cannot trade on a close it has only just observed.
- Market orders only; price = open adjusted by ``slippage_bps`` against the trader,
  rounded to tick against the trader. Taker fee on notional.
- Spot, long-only, no leverage: buys need cash for notional + fee; sells need position.
  Infeasible intents are rejected and reported, never resized silently.
- Intents still pending after the final bar expire unfilled.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, localcontext
from typing import Any

from veyra_sdk import Bar, Instrument
from veyra_sdk.strategy import MAX_INTENTS_PER_EVENT

from veyra_sim.sandbox import StrategyError, StrategyProcess

BPS = Decimal(10_000)
FEE_Q = Decimal("0.00000001")


@dataclass(frozen=True)
class ExecutionModel:
    taker_fee_bps: Decimal = Decimal("10")
    slippage_bps: Decimal = Decimal("5")

    def describe(self) -> dict[str, Any]:
        return {
            "fidelity": "daily-bar",
            "fill_timing": "next bar open",
            "order_types": ["market"],
            "taker_fee_bps": str(self.taker_fee_bps),
            "slippage_bps": str(self.slippage_bps),
            "position_model": "spot long-only, no leverage",
            "not_modeled": ["partial fills", "queue position", "market impact",
                            "funding", "borrow", "latency", "intrabar path"],
        }


@dataclass
class SimResult:
    equity: list[tuple[str, Decimal]] = field(default_factory=list)
    positions: list[Decimal] = field(default_factory=list)
    fills: list[dict[str, Any]] = field(default_factory=list)
    rejections: list[dict[str, Any]] = field(default_factory=list)
    logs: list[dict[str, Any]] = field(default_factory=list)
    bars_total: int = 0
    bars_processed: int = 0
    stopped_early: bool = False
    final_cash: Decimal = Decimal(0)
    final_position: Decimal = Decimal(0)


def _validate_intents(raw: Any, seq: int) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) > MAX_INTENTS_PER_EVENT:
        raise StrategyError("malformed intents")
    out = []
    for item in raw:
        if not isinstance(item, dict):
            raise StrategyError("malformed intent")
        side, qty, cid = item.get("side"), item.get("qty"), item.get("client_id")
        if side not in ("buy", "sell") or item.get("order_type", "market") != "market":
            raise StrategyError(f"unsupported intent {item!r}")
        if not isinstance(cid, str) or len(cid) > 64:
            raise StrategyError("invalid client_id")
        try:
            q = Decimal(str(qty))
        except Exception as e:
            raise StrategyError(f"invalid qty {qty!r}") from e
        if not q.is_finite() or q <= 0:
            raise StrategyError(f"invalid qty {qty!r}")
        out.append({"client_id": f"{seq}:{cid}", "side": side, "qty": q})
    return out


def run(
    bars: list[Bar],
    instrument: Instrument,
    proc: StrategyProcess,
    *,
    starting_cash: Decimal,
    params: dict[str, Any],
    model: ExecutionModel,
    should_stop: Callable[[], bool] = lambda: False,
    on_progress: Callable[[int, int], None] = lambda done, total: None,
    progress_every: int = 50,
) -> SimResult:
    res = SimResult(bars_total=len(bars), final_cash=starting_cash)
    cash, position = starting_cash, Decimal(0)
    pending: list[dict[str, Any]] = []

    proc.request({"type": "init", "config": params, "instrument": {
        "instrument_id": instrument.instrument_id, "quote_currency": instrument.quote_currency,
        "tick_size": str(instrument.tick_size), "lot_size": str(instrument.lot_size)}})

    with localcontext() as ctx:
        ctx.prec = 34
        for seq, bar in enumerate(bars):
            if should_stop():
                res.stopped_early = True
                break
            # 1) Fill intents from the previous bar at this bar's open.
            for intent in pending:
                cash, position = _fill(intent, bar, instrument, model, cash, position, res, proc)
            pending = []
            # 2) Strategy observes the completed bar.
            reply = proc.request({"type": "bar", "seq": seq, "cash": str(cash),
                                  "position": str(position), "bar": {
                                      "ts": bar.ts, "open": str(bar.open), "high": str(bar.high),
                                      "low": str(bar.low), "close": str(bar.close),
                                      "volume": str(bar.volume)}})
            if reply.get("type") != "intents" or reply.get("seq") != seq:
                raise StrategyError("protocol violation: unexpected reply")
            pending = _validate_intents(reply.get("intents"), seq)
            for line in (reply.get("logs") or [])[:32]:
                if len(res.logs) < 1000:
                    res.logs.append({"ts": bar.ts, "message": str(line)[:500]})
            res.equity.append((bar.ts, cash + position * bar.close))
            res.positions.append(position)
            res.bars_processed = seq + 1
            if res.bars_processed % progress_every == 0:
                on_progress(res.bars_processed, len(bars))

        for intent in pending:
            res.rejections.append({"client_id": intent["client_id"], "reason": "expired_at_end"})
        if not res.stopped_early:
            proc.request({"type": "finalize"})

    res.final_cash, res.final_position = cash, position
    on_progress(res.bars_processed, len(bars))
    return res


def _fill(intent, bar, instrument, model, cash, position, res, proc):
    qty: Decimal = intent["qty"]
    if qty % instrument.lot_size != 0:
        res.rejections.append({"client_id": intent["client_id"], "ts": bar.ts,
                               "reason": "qty_not_multiple_of_lot"})
        return cash, position
    slip = model.slippage_bps / BPS
    if intent["side"] == "buy":
        price = (bar.open * (1 + slip) / instrument.tick_size).to_integral_value(
            ROUND_CEILING) * instrument.tick_size
    else:
        price = (bar.open * (1 - slip) / instrument.tick_size).to_integral_value(
            ROUND_FLOOR) * instrument.tick_size
    notional = price * qty
    fee = (notional * model.taker_fee_bps / BPS).quantize(FEE_Q, ROUND_CEILING)
    if intent["side"] == "buy":
        if notional + fee > cash:
            res.rejections.append({"client_id": intent["client_id"], "ts": bar.ts,
                                   "reason": "insufficient_cash"})
            return cash, position
        cash, position = cash - notional - fee, position + qty
    else:
        if qty > position:
            res.rejections.append({"client_id": intent["client_id"], "ts": bar.ts,
                                   "reason": "insufficient_position"})
            return cash, position
        cash, position = cash + notional - fee, position - qty
    fill = {"client_id": intent["client_id"], "ts": bar.ts, "side": intent["side"],
            "qty": str(qty), "price": str(price), "fee": str(fee),
            "cash_after": str(cash), "position_after": str(position)}
    res.fills.append(fill)
    proc.request({"type": "fill", "fill": {k: fill[k] for k in
                                           ("client_id", "side", "qty", "price", "fee", "ts")}})
    return cash, position
