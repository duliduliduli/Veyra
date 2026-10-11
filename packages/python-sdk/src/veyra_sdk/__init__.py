"""Veyra strategy SDK.

A strategy is ordinary Python that subclasses :class:`Strategy`. It never sees the
dataset, the clock, or the portfolio ledger directly: the trusted simulator sends one
observation at a time and receives bounded order intents back (spec §5.3, §9.2).
"""

from veyra_sdk.strategy import Bar, Context, Fill, Instrument, OrderIntent, Strategy

__all__ = ["Bar", "Context", "Fill", "Instrument", "OrderIntent", "Strategy"]
