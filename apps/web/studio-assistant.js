(function (root, factory) {
  "use strict";
  const assistant = factory();
  if (typeof module === "object" && module.exports) module.exports = assistant;
  else root.VeyraStudioAssistant = assistant;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SOURCE = "built-in-offline";
  const HELP = "Built-in offline helper; no AI provider is connected. Supported commands: " +
    "create blank, create buy and hold, create SMA crossover, explain SDK, " +
    "set fast to 12, set slow to 40, or set alloc to 0.5. " +
    "Parameter edits work only on unchanged built-in templates. " +
    "Proposals stay in this browser and do not execute, save, or run your strategy.";
  const SDK = "Built-in SDK reference, not an AI review of your code. " +
    "Subclass veyra_sdk.Strategy. initialize(config, instrument) prepares state; call " +
    "super().initialize(config, instrument) when overriding it. on_bar(bar, ctx) receives " +
    "a closed bar with ts, open, high, low, close, and volume. ctx.cash and ctx.position " +
    "are portfolio values. ctx.buy(qty) and ctx.sell(qty) submit market-order intents " +
    "that the simulator considers at the next bar's open; fills are not guaranteed. " +
    "Use Decimal, strings, or integers for quantities, never floats. " +
    "instrument.lot_size determines quantity increments. ctx.log(message) adds a bounded log. " +
    "on_fill(fill) receives fills; finalize() ends the strategy. " +
    "This helper has not run or validated your strategy or its performance.";

  const BLANK = `"""Blank strategy scaffold. Does not submit orders."""

from veyra_sdk import Strategy


class MyStrategy(Strategy):
    def on_bar(self, bar, ctx):
        pass
`;
  const BUY_HOLD_V1 = `"""Buy-and-hold starter. An example, not an investment recommendation.

Parameters: alloc (fraction of available cash per entry, str/Decimal).
Orders fill at the next bar's open, subject to the simulator's execution rules.
"""

from decimal import ROUND_FLOOR, Decimal

from veyra_sdk import Strategy


class BuyAndHold(Strategy):
    def initialize(self, config, instrument):
        super().initialize(config, instrument)
        self.alloc = Decimal(str(config.get("alloc", "0.95")))
        if not Decimal("0") < self.alloc <= Decimal("1"):
            raise ValueError("require 0 < alloc <= 1")
        self.entered = False

    def on_bar(self, bar, ctx):
        if self.entered or ctx.position > 0 or bar.close <= 0:
            return
        lot = self.instrument.lot_size
        qty = (ctx.cash * self.alloc / bar.close / lot).to_integral_value(ROUND_FLOOR) * lot
        if qty > 0:
            ctx.buy(qty)
            self.entered = True
`;
  const SMA_V1 = `"""Moving-average crossover template.

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
`;

  const BUY_HOLD = `"""Buy-and-hold starter. An example, not an investment recommendation.

Parameters: alloc (fraction of available cash per entry, str/Decimal).
Retries while flat until a buy fills; next-open fills are not guaranteed.
"""

from decimal import ROUND_FLOOR, Decimal, InvalidOperation

from veyra_sdk import Strategy


class BuyAndHold(Strategy):
    def initialize(self, config, instrument):
        super().initialize(config, instrument)
        try:
            self.alloc = Decimal(str(config.get("alloc", "0.95")))
        except InvalidOperation:
            raise ValueError("require finite 0 < alloc <= 1") from None
        if not self.alloc.is_finite() or not Decimal("0") < self.alloc <= Decimal("1"):
            raise ValueError("require finite 0 < alloc <= 1")
        self.entered = False

    def on_bar(self, bar, ctx):
        if self.entered or ctx.position > 0 or bar.close <= 0:
            return
        lot = self.instrument.lot_size
        qty = (ctx.cash * self.alloc / bar.close / lot).to_integral_value(ROUND_FLOOR) * lot
        if qty > 0:
            ctx.buy(qty)

    def on_fill(self, fill):
        if fill.side == "buy":
            self.entered = True
`;
  const SMA = `"""Moving-average crossover example, not an investment recommendation.

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
`;

  const templates = Object.freeze({ blank: BLANK, buy_hold: BUY_HOLD, sma_cross: SMA });
  // Keep prior source recognizable without migrating saved strategies.
  const knownTemplates = { buy_hold: [BUY_HOLD, BUY_HOLD_V1], sma_cross: [SMA, SMA_V1] };
  const capabilities = Object.freeze({ mode: "offline", provider_status: "unconfigured",
    provider: null, model: null, network_enabled: false, executes_code: false,
    generates_templates: true, edits_template_defaults: true, explains_arbitrary_code: false });
  const parameters = {
    fast: { pattern: /config\.get\("fast", ([1-9]\d*)\)/, initial: "10" },
    slow: { pattern: /config\.get\("slow", ([1-9]\d*)\)/, initial: "40" },
    alloc: { pattern: /config\.get\("alloc", "(\d+(?:\.\d+)?)"\)/, initial: "0.95" },
  };
  const issuedProposals = new WeakSet();

  function reply(kind, status, message, code, proposed = null) {
    const result = Object.freeze({ kind, status, message, source: SOURCE,
      base_code: typeof code === "string" ? code : null, proposed_code: proposed });
    if (status === "proposal") issuedProposals.add(result);
    return result;
  }

  function replaceParameter(code, key, value) {
    return code.replace(parameters[key].pattern, (full, old) =>
      full.replace(old, value));
  }

  function recognizedTemplate(code) {
    // shortcut: exact known scaffolds only; use a Python parser before supporting arbitrary edits.
    const normalized = code.replace(/\r\n/g, "\n");
    for (const name of ["buy_hold", "sma_cross"]) {
      let restored = normalized;
      const values = {};
      for (const key of name === "sma_cross" ? ["fast", "slow", "alloc"] : ["alloc"]) {
        const match = restored.match(parameters[key].pattern);
        if (match) {
          values[key] = match[1];
          restored = replaceParameter(restored, key, parameters[key].initial);
        }
      }
      if (knownTemplates[name].includes(restored)) return { name, values };
    }
    return null;
  }

  function validParameters(values) {
    const alloc = values.alloc;
    if (!/^(?:0|1)(?:\.\d{1,6})?$/.test(alloc) || +alloc <= 0 || +alloc > 1) return false;
    if (values.fast !== undefined) {
      if (!/^[1-9]\d{0,4}$/.test(values.fast) || !/^[1-9]\d{0,4}$/.test(values.slow)) return false;
      if (+values.fast >= +values.slow || +values.slow > 10000) return false;
    }
    return true;
  }

  function propose(input) {
    const code = input?.code, prompt = input?.prompt;
    if (typeof code !== "string" || typeof prompt !== "string") {
      return reply("input", "invalid", "Supply current code and a prompt as text.", code);
    }
    if (code.length > 100000 || prompt.length > 500) {
      return reply("input", "invalid", "The offline helper supports up to 100,000 code characters and 500 prompt characters.", code);
    }
    const command = prompt.trim().toLowerCase().replace(/\s+/g, " ");
    if (command === "help" || command === "") return reply("help", "info", HELP, code);
    if (["explain sdk", "explain the sdk"].includes(command)) return reply("sdk", "info", SDK, code);
    const names = { "create blank": "blank", "create buy and hold": "buy_hold",
      "create buy-and-hold": "buy_hold", "create sma crossover": "sma_cross" };
    const name = Object.prototype.hasOwnProperty.call(names, command) ? names[command] : null;
    if (name) {
      if (code === templates[name]) return reply("template", "info", "The editor already contains this built-in template.", code);
      return reply("template", "proposal", "Built-in template: review the complete replacement before applying. " +
        "This replaces the editor contents. No strategy or backtest has been run.", code, templates[name]);
    }
    const edit = /^set (fast|slow|alloc)(?: to| =) ([^ ]+)$/.exec(command);
    if (!edit) return reply("unsupported", "unsupported", "I can't handle that request with the offline helper. " + HELP, code);
    const current = recognizedTemplate(code);
    const key = edit[1], value = edit[2];
    if (!current || !Object.prototype.hasOwnProperty.call(current.values, key)) {
      return reply("parameter", "unsupported", "That parameter can only be edited in an unchanged built-in template that defines it. " +
        "Your code has been left alone. You can edit it manually or review a fresh template.", code);
    }
    if (!validParameters({ ...current.values, [key]: value })) {
      return reply("parameter", "invalid", "Use whole-number windows with 1 <= fast < slow <= 10000, " +
        "and alloc greater than 0 and at most 1 with no more than 6 decimal places. No code was changed.", code);
    }
    if (current.values[key] === value) return reply("parameter", "info", `${key} already defaults to ${value}.`, code);
    return reply("parameter", "proposal", `Change the built-in ${key} default from ${current.values[key]} to ${value}. ` +
      "Run configuration can override this default. Review before applying; no strategy has been run.",
    code, replaceParameter(code, key, value));
  }

  function applyProposal(currentCode, proposal) {
    if (typeof currentCode !== "string" || !proposal || !issuedProposals.has(proposal)) {
      return { status: "invalid", code: currentCode, message: "No valid offline proposal is available. Request a new one." };
    }
    if (currentCode !== proposal.base_code) {
      return { status: "stale", code: currentCode, message: "The editor changed after this proposal. Request a new proposal to keep your edits." };
    }
    return { status: "applied", code: proposal.proposed_code, message: "Applied to the editor only. Review and save when ready." };
  }

  return Object.freeze({ propose, applyProposal, templates, capabilities, source: SOURCE, help: HELP });
});
