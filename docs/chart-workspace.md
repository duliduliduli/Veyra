# Chart workspace (Markets home)

The home page is a phone-first chart workspace. Everything beyond the chart sits behind one
toolbar row and bottom sheets (dark menus over the light chart, drag handle, dimmed backdrop).

| Where | What |
|---|---|
| Header | Asset icon, symbol and pair, source, price, dollar and percent change (colored, ▲/▼). Tap the symbol for the symbol sheet (search, all assets, watchlist with stars) |
| Toolbar | Timeframe · Draw · ƒx indicators · Trade · ⋯ analysis hub · Undo · Full screen |
| Chart | Green/red candles (or mono), current-price line, symbol label on the price scale, grid, UTC time axis, alert and backtest-fill event markers. Zoom, reset and log scale below the chart; 3M/1Y/All range |
| Draw sheet | Search, Lines / Forecasting & measurement / Geometric shapes. Trend, horizontal, long and short position, position forecast, bars pattern, ghost feed, sector, anchored VWAP, fixed-range and anchored volume profile, price/date/date-and-price range, rectangle, triangle, circle |
| ƒx sheet | Search; Favorites (search, All/Indicators/Strategies, star, remove); My scripts; built-in technicals (Volume, SMA 20/50/200, EMA 20/50, Bollinger, RSI, MACD); fundamentals; community Editors' picks / Top / Trending |
| Hub | Layout setup, manage, new, save, open · indicators, templates, compare, alerts, bar replay, object tree, settings · symbol details, technicals, financials, forecast · broker, strategy on chart, Python editor, watchlist |

Math and drawing geometry live in `apps/web/chart-tools.js` (`tests/e2e/chart-tools.mjs`).
The phone UI is covered by `tests/e2e/chart-workspace-ui.mjs`.

## Honest limits

- **Device only:** layouts, templates, favorites, alerts and the watchlist are saved on this
  device. Drawings are temporary and reset with the asset, range or interval.
- **Alerts** mark past crossings in this historical data. There are no live notifications
  without a live feed.
- **Not available yet:** financials and forecast (shown disabled), fundamentals, editors'
  picks, top rankings, broker trading, and multi-chart grids. Trending lists the newest
  published strategies until usage data exists.
- **Python editor instead of Pine Editor:** Veyra strategies are Python, edited in Studio.
- **Not possible:** Siri shortcuts need a native iOS app.
- **Favorites from another app** (for example TradingView scripts) cannot be imported. Recreate
  them in Studio or import their Python.
- **Deleting personal scripts:** strategies have no delete (versions back recorded backtests).
  The delete control in Favorites removes the script from favorites.
- **Technicals** are factual readings (above/below averages, RSI zone), never a buy/sell rating.
- **Bars pattern and ghost feed** are illustrations, not predictions.
