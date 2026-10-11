"""Moving-average crossover template.

Goes all-in when the fast SMA crosses above the slow SMA; exits when it crosses below.
Parameters: fast (int), slow (int), alloc (fraction of cash per entry, str/Decimal).
"""

from collections import deque
from decimal import ROUND_FLOOR, Decimal

from veyra_sdk import Strategy


class SmaCross(Strategy):
    def initialize(self, config, instrument):
        super().initialize(config, instrument)
        self.fast = int(config.get("fast", 10))
        self.slow = int(config.get("slow", 40))
        self.alloc = Decimal(str(config.get("alloc", "0.95")))
        if not 0 < self.fast < self.slow:
            raise ValueError("require 0 < fast < slow")
        self.closes = deque(maxlen=self.slow)
        self.prev_diff = None

    def on_bar(self, bar, ctx):
        self.closes.append(bar.close)
        if len(self.closes) < self.slow:
            return
        fast = sum(list(self.closes)[-self.fast:]) / self.fast
        slow = sum(self.closes) / self.slow
        diff = fast - slow
        if self.prev_diff is not None:
            if self.prev_diff <= 0 < diff and ctx.position == 0:
                # Size against the close; the fill happens at next open, so leave headroom.
                lot = self.instrument.lot_size
                qty = (ctx.cash * self.alloc / bar.close / lot).to_integral_value(ROUND_FLOOR) * lot
                if qty > 0:
                    ctx.buy(qty)
                    ctx.log(f"enter {qty} fast={fast:.2f} slow={slow:.2f}")
            elif self.prev_diff >= 0 > diff and ctx.position > 0:
                ctx.sell(ctx.position)
                ctx.log("exit")
        self.prev_diff = diff
