"""Moving-average crossover example, not an investment recommendation.

Uses alloc of available cash on an upward crossover; exits on a downward crossover.
Next-open fills are not guaranteed.
Parameters: fast (int), slow (int), alloc (fraction of cash per entry, str/Decimal).
"""

from collections import deque
from decimal import ROUND_FLOOR, Decimal, InvalidOperation

from veyra_sdk import Strategy


class SmaCross(Strategy):
    def initialize(self, config, instrument):
        super().initialize(config, instrument)
        try:
            fast = config.get("fast", 10)
            slow = config.get("slow", 40)
            if any(type(value) not in (int, str) for value in (fast, slow)):
                raise ValueError
            self.fast, self.slow = int(fast), int(slow)
            if not 1 <= self.fast < self.slow <= 10000:
                raise ValueError
        except ValueError:
            raise ValueError("require integer windows with 1 <= fast < slow <= 10000") from None
        try:
            self.alloc = Decimal(str(config.get("alloc", "0.95")))
        except InvalidOperation:
            raise ValueError("require finite 0 < alloc <= 1") from None
        if not self.alloc.is_finite() or not Decimal("0") < self.alloc <= Decimal("1"):
            raise ValueError("require finite 0 < alloc <= 1")
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
