from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, Decimal

NANO_PER_USD = 1_000_000_000

_ROUNDING = {"ceil": ROUND_CEILING, "floor": ROUND_FLOOR, "half_even": ROUND_HALF_EVEN}


def to_nano(amount_usd: Decimal | str | int, rounding: str = "ceil") -> int:
    """Convert a USD amount to integer nano-USD.

    Charges round up (``ceil``) so a customer-facing maximum is never understated;
    releases/refunds should round ``floor``.
    """
    if isinstance(amount_usd, float):  # pragma: no cover - defensive
        raise TypeError("float money is not allowed; pass Decimal or str")
    value = Decimal(amount_usd) * NANO_PER_USD
    return int(value.to_integral_value(rounding=_ROUNDING[rounding]))


def usd(nano: int) -> Decimal:
    return Decimal(nano) / NANO_PER_USD


def format_usd(nano: int, places: int = 2) -> str:
    """Customer display. Rounds half-even at the display boundary only."""
    q = Decimal(1).scaleb(-places)
    return f"${usd(nano).quantize(q, rounding=ROUND_HALF_EVEN):,}"
