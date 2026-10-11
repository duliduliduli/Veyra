from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

MAX_INTENTS_PER_EVENT = 16


@dataclass(frozen=True)
class Instrument:
    instrument_id: str
    quote_currency: str
    tick_size: Decimal
    lot_size: Decimal


@dataclass(frozen=True)
class Bar:
    ts: str  # ISO-8601 UTC bar open time
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


@dataclass(frozen=True)
class Fill:
    client_id: str
    side: Literal["buy", "sell"]
    qty: Decimal
    price: Decimal
    fee: Decimal
    ts: str


@dataclass(frozen=True)
class OrderIntent:
    client_id: str
    side: Literal["buy", "sell"]
    qty: Decimal
    order_type: Literal["market"] = "market"


@dataclass
class Context:
    """Read-only portfolio view plus an order-intent sink for the current event."""

    cash: Decimal
    position: Decimal
    seq: int
    _intents: list[OrderIntent] = field(default_factory=list)
    _logs: list[str] = field(default_factory=list)

    def buy(self, qty: Decimal | str | int) -> str:
        return self._submit("buy", qty)

    def sell(self, qty: Decimal | str | int) -> str:
        return self._submit("sell", qty)

    def log(self, message: Any) -> None:
        if len(self._logs) < 32:
            self._logs.append(str(message)[:500])

    def _submit(self, side: Literal["buy", "sell"], qty: Decimal | str | int) -> str:
        if isinstance(qty, float):
            raise TypeError("use Decimal or str quantities, not float")
        q = Decimal(qty)
        if q <= 0:
            raise ValueError("quantity must be positive")
        if len(self._intents) >= MAX_INTENTS_PER_EVENT:
            raise RuntimeError(f"at most {MAX_INTENTS_PER_EVENT} intents per event")
        client_id = f"{self.seq}-{len(self._intents)}"
        self._intents.append(OrderIntent(client_id, side, q))
        return client_id


class Strategy:
    """Base class. Override what you need; every method has a safe default."""

    def initialize(self, config: dict[str, Any], instrument: Instrument) -> None:
        self.config = config
        self.instrument = instrument

    def on_bar(self, bar: Bar, ctx: Context) -> None:
        pass

    def on_fill(self, fill: Fill) -> None:
        pass

    def finalize(self) -> None:
        pass
