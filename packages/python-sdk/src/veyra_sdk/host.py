"""Strategy-side half of the observation/intent protocol.

Run as ``python -I -m veyra_sdk.host <strategy_file>`` with the snapshot as cwd.
Speaks JSON lines on the *original* stdout; anything the strategy prints goes to stderr
so user output can never forge protocol messages.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import keyword
import os
import sys
import traceback
from decimal import Decimal
from pathlib import Path

from veyra_sdk.strategy import Bar, Context, Fill, Instrument, Strategy


def _load_strategy(path: str, snapshot_root: Path) -> Strategy:
    root = snapshot_root.resolve(strict=True)
    entry = Path(path).resolve(strict=True)
    if not root.is_dir() or not entry.is_relative_to(root) or not entry.is_file():
        raise RuntimeError("entrypoint must be a file inside the snapshot root")
    if entry.suffix != ".py":
        raise RuntimeError("entrypoint must be a Python source file")
    relative = entry.relative_to(root)
    packages = relative.parts[:-1]
    packaged = bool(packages)
    for index, name in enumerate(packages, 1):
        init = root.joinpath(*packages[:index], "__init__.py")
        if not init.resolve().is_relative_to(root):
            raise RuntimeError("package initializer must be inside the snapshot root")
        packaged &= name.isidentifier() and not keyword.iskeyword(name) and init.is_file()
    if packaged:
        top = packages[0]
        if top in sys.modules or importlib.util.find_spec(top) is not None:
            raise RuntimeError(
                f"snapshot package {top!r} conflicts with a runtime module; rename it")
        name = ".".join(packages + (() if entry.name == "__init__.py" else (entry.stem,)))
    else:
        name = "user_strategy"
    if not packages and entry.name != "__init__.py":
        if entry.stem not in sys.modules and importlib.util.find_spec(entry.stem) is None:
            name = entry.stem
    if not packaged and name == "user_strategy" and (
            name in sys.modules or importlib.util.find_spec(name) is not None):
        raise RuntimeError(
            "reserved entrypoint module 'user_strategy' conflicts with a runtime module")
    names = [name]
    if not packages and entry.name == "__init__.py" and (
            "__init__" not in sys.modules and importlib.util.find_spec("__init__") is None):
        names.append("__init__")
    missing = object()
    previous_modules = {name: sys.modules.get(name, missing) for name in names}
    previous_path = sys.path[:]

    # Keep stdlib/SDK precedence; never add the entrypoint directory or another project.
    sys.path.append(str(root))
    try:
        if packaged:
            spec = importlib.util.find_spec(name)
            if spec is None or spec.origin is None or Path(spec.origin).resolve() != entry:
                raise RuntimeError(f"cannot resolve snapshot entrypoint {str(relative)!r}")
            # Normal import caching handles an __init__.py that imports the entrypoint.
            module = importlib.import_module(name)
        else:
            spec = importlib.util.spec_from_file_location(name, entry)
            if spec is None or spec.loader is None:
                raise RuntimeError("cannot load strategy file")
            module = importlib.util.module_from_spec(spec)
            for alias in names:
                sys.modules[alias] = module
            spec.loader.exec_module(module)
        candidates = {
            v for v in vars(module).values()
            if isinstance(v, type) and issubclass(v, Strategy) and v is not Strategy
            and v.__module__ == module.__name__
        }
        if len(candidates) != 1:
            raise RuntimeError(
                "expected exactly one Strategy subclass defined in the entrypoint, "
                f"found {len(candidates)}")
        return candidates.pop()()
    except BaseException:
        sys.path[:] = previous_path
        for name, previous in previous_modules.items():
            if previous is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
        raise


def main() -> int:
    proto_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())  # raw fd 1 writes go to stderr too
    sys.stdout = sys.stderr  # user prints cannot reach the protocol channel

    def send(msg: dict) -> None:
        proto_out.write(json.dumps(msg, separators=(",", ":")) + "\n")

    try:
        strategy = _load_strategy(sys.argv[1], Path.cwd())
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
