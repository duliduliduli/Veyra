"""Strategy-side half of the observation/intent protocol.

Run as ``python -I -m veyra_sdk.host <strategy_file>`` inside the isolated runtime.
Speaks JSON lines on the *original* stdout; anything the strategy prints goes to stderr
so user output can never forge protocol messages.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import traceback
from decimal import Decimal

from veyra_sdk.strategy import Bar, Context, Fill, Instrument, Strategy


def _load_strategy(path: str) -> Strategy:
    spec = importlib.util.spec_from_file_location("user_strategy", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load strategy file")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    candidates = [
        v for v in vars(module).values()
        if isinstance(v, type) and issubclass(v, Strategy) and v is not Strategy
    ]
    if len(candidates) != 1:
        raise RuntimeError(f"expected exactly one Strategy subclass, found {len(candidates)}")
    return candidates[0]()


def main() -> int:
    proto_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    sys.stdout = sys.stderr  # user prints cannot reach the protocol channel

    def send(msg: dict) -> None:
        proto_out.write(json.dumps(msg, separators=(",", ":")) + "\n")

    try:
        strategy = _load_strategy(sys.argv[1])
    except Exception:
        send({"type": "error", "message": traceback.format_exc(limit=5)[-2000:]})
        return 1

    for line in sys.stdin:
        msg = json.loads(line)
        kind = msg["type"]
        try:
            if kind == "init":
                i = msg["instrument"]
                strategy.initialize(msg["config"], Instrument(
                    i["instrument_id"], i["quote_currency"],
                    Decimal(i["tick_size"]), Decimal(i["lot_size"])))
                send({"type": "ready"})
            elif kind == "bar":
                b = msg["bar"]
                bar = Bar(b["ts"], *(Decimal(b[k]) for k in
                                     ("open", "high", "low", "close", "volume")))
                ctx = Context(Decimal(msg["cash"]), Decimal(msg["position"]), msg["seq"])
                strategy.on_bar(bar, ctx)
                send({"type": "intents", "seq": msg["seq"], "logs": ctx._logs, "intents": [
                    {"client_id": o.client_id, "side": o.side, "qty": str(o.qty),
                     "order_type": o.order_type} for o in ctx._intents]})
            elif kind == "fill":
                f = msg["fill"]
                strategy.on_fill(Fill(f["client_id"], f["side"], Decimal(f["qty"]),
                                      Decimal(f["price"]), Decimal(f["fee"]), f["ts"]))
                send({"type": "ack"})
            elif kind == "finalize":
                strategy.finalize()
                send({"type": "done"})
                return 0
            else:
                send({"type": "error", "message": f"unknown message {kind!r}"})
                return 1
        except Exception:
            send({"type": "error", "message": traceback.format_exc(limit=5)[-2000:]})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
