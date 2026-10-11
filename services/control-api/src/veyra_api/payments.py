"""Payment-provider boundary. ``dev`` is a local stand-in for Stripe test mode with the
same contract: checkout intent -> signed webhook -> credit exactly once (spec §14.3).
A browser redirect is never proof of payment."""

from __future__ import annotations

import hashlib
import hmac
import time

SIGNATURE_TOLERANCE_S = 300


class BadSignature(Exception):
    pass


def sign(secret: str, body: bytes, ts: int | None = None) -> str:
    ts = int(time.time()) if ts is None else ts
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={ts},v1={mac}"


def verify(secret: str, body: bytes, header: str | None, now: float | None = None) -> None:
    if not header:
        raise BadSignature("missing signature")
    try:
        parts = dict(item.split("=", 1) for item in header.split(","))
        ts = int(parts["t"])
        given = parts["v1"]
    except (ValueError, KeyError):
        raise BadSignature("malformed signature") from None
    now = time.time() if now is None else now
    if abs(now - ts) > SIGNATURE_TOLERANCE_S:
        raise BadSignature("timestamp outside tolerance")
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, given):
        raise BadSignature("signature mismatch")
