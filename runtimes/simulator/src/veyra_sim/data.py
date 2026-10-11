"""Deterministic synthetic market data for development and CI (spec §23: golden data
must be synthetic or licensed). Never presented as real market history."""

from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal

from veyra_sdk import Bar, Instrument

CENT = Decimal("0.01")
QTY = Decimal("0.0001")


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    instrument: Instrument
    start: date
    days: int
    seed: int
    start_price: Decimal
    daily_drift: Decimal
    daily_vol: Decimal
    provider: str = "veyra-synthetic"
    license: str = "synthetic; unrestricted internal/dev use; not market data"


CATALOG: dict[str, DatasetSpec] = {
    "synth-btcusd-1d-v1": DatasetSpec(
        dataset_id="synth-btcusd-1d-v1",
        instrument=Instrument("SYNTH:BTC-USD", "USD", CENT, QTY),
        start=date(2019, 1, 1),
        days=6 * 365,
        seed=20261011,
        start_price=Decimal("4000.00"),
        daily_drift=Decimal("0.0012"),
        daily_vol=Decimal("0.035"),
    ),
    "synth-ethusd-1d-v1": DatasetSpec(
        dataset_id="synth-ethusd-1d-v1",
        instrument=Instrument("SYNTH:ETH-USD", "USD", CENT, QTY),
        start=date(2019, 1, 1),
        days=6 * 365,
        seed=7,
        start_price=Decimal("150.00"),
        daily_drift=Decimal("0.0010"),
        daily_vol=Decimal("0.045"),
    ),
}


def generate_bars(spec: DatasetSpec) -> list[Bar]:
    """Random walk with Decimal rounding. ``random.Random`` is deterministic across
    platforms for a given seed, so the manifest hash is stable."""
    rng = random.Random(spec.seed)
    price = spec.start_price
    bars: list[Bar] = []
    day0 = datetime.combine(spec.start, datetime.min.time(), tzinfo=UTC)
    for i in range(spec.days):
        # Quantize the random draw immediately so no float leaks into prices.
        shock = Decimal(repr(rng.gauss(0, 1))).quantize(Decimal("0.000001"))
        ret = spec.daily_drift + spec.daily_vol * shock
        open_ = price
        close = max((open_ * (1 + ret)).quantize(CENT, ROUND_HALF_EVEN), CENT)
        wick = Decimal(repr(rng.random())).quantize(Decimal("0.000001")) * spec.daily_vol / 2
        high = (max(open_, close) * (1 + wick)).quantize(CENT, ROUND_HALF_EVEN)
        low = max((min(open_, close) * (1 - wick)).quantize(CENT, ROUND_HALF_EVEN), CENT)
        volume = (Decimal(1000) + Decimal(rng.randint(0, 9000))).quantize(QTY)
        ts = (day0 + timedelta(days=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
        bars.append(Bar(ts, open_, high, low, close, volume))
        price = close
    return bars


def to_csv(bars: list[Bar]) -> str:
    rows = ["ts,open,high,low,close,volume"]
    rows += [f"{b.ts},{b.open},{b.high},{b.low},{b.close},{b.volume}" for b in bars]
    return "\n".join(rows) + "\n"


def manifest_hash(bars: list[Bar]) -> str:
    return "sha256:" + hashlib.sha256(to_csv(bars).encode()).hexdigest()


def load(dataset_id: str, start: str | None = None, end: str | None = None) -> list[Bar]:
    """Bars with ``start <= ts < end`` (ISO dates, UTC)."""
    if dataset_id not in CATALOG:
        raise KeyError(f"unknown dataset {dataset_id!r}")
    bars = generate_bars(CATALOG[dataset_id])
    if start:
        bars = [b for b in bars if b.ts[:10] >= start]
    if end:
        bars = [b for b in bars if b.ts[:10] < end]
    return bars


def quality_findings(bars: list[Bar]) -> list[dict]:
    """Minimal §7.4 checks. Findings are reported, never silently 'fixed'."""
    findings = []
    prev_ts = None
    for b in bars:
        if not (b.low <= min(b.open, b.close) and b.high >= max(b.open, b.close)):
            findings.append({"ts": b.ts, "check": "impossible_ohlc"})
        if b.volume < 0:
            findings.append({"ts": b.ts, "check": "negative_volume"})
        if prev_ts is not None and b.ts <= prev_ts:
            findings.append({"ts": b.ts, "check": "nonmonotonic_timestamp"})
        prev_ts = b.ts
    return findings
