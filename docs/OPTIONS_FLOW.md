# Options Flow — lower panel

**OPTIONS FLOW** is the default lower panel. The picker also offers **KRONOS FORECAST**,
**TICK CHART**, and **BLANK**. Reset restores Options Flow. Older saved Kronos
defaults upgrade to Options Flow; later manual choices remain remembered.
The saved lower-panel choice is independent of the
ADR panel. This panel requires a live stock tape and a configured local options
gateway; the normal demo and historical stock replay do not query live options.

Read the panel from top to bottom:

- The large **▲ BULLISH FLOW** / **▼ BEARISH FLOW** headline describes the
  current 15-second options lean. **Green = bullish; red = bearish.** Each
  horizon's background, left edge, arrow, and label repeat that meaning.
- The **amber ⇄ TAPE OPPOSES** badge means stock tape and options disagree.
  **✓ TAPE AGREES** uses their shared directional color. Read the tape chip
  below to see which way the stock is trading. Amber is disagreement, not an
  entry signal. Gray means mixed, building, thin, stale, or unavailable.
- Arrows and labels repeat every color, so the panel can also be read without
  distinguishing red from green. Colors are steady; nothing flashes.
- **15s / 60s / 5m NET** is bullish minus bearish premium in completed one-second
  buckets. A partial window shows how many seconds have been observed. Weak
  samples remain gray and say **THIN**.
- **BULL / BEAR FLOW ↑ FASTER / ↓ SLOWER** compares the leading side's premium in the current
  15 seconds against the immediately preceding 15 seconds (±25% threshold).
- The quality row shows classified premium as a percentage of all observed
  premium, the print count, and last-trade age. Unknown premium is included in
  the denominator. Hover a horizon for its gross bull/bear/unknown totals.
- **60s DETAIL** shows call ask/bid, put ask/bid, unknown premium, and the number
  of classified prints worth at least $25,000. Click **BACK TO FLOW** to return.

Premium = option price × contracts × 100. Bull = call ask + put bid. Bear = call
bid + put ask. A 20% imbalance of classified premium is required for a lean.
A window must be complete, contain at least five classified prints and $10,000
classified premium, and classify at least 60% of total premium. Stock tape
comparison also requires a complete 15-second window, ten prints, at least 60%
classified shares, and a stock trade no older than ten seconds. These are
explicit quality heuristics, not thresholds calibrated for trading returns.

The gateway's default universe is at most 80 standard contracts (40 calls and
40 puts), expiring in 0–14 calendar days, with strikes within 10% of the spot
price when tracking starts. Earliest expiries and then closest strikes lead.
The footer marks a capped universe. This is **observed flow in a selected
subset**, never a claim to represent the entire chain or all market activity.
The universe refreshes after ten minutes, with new warmup windows.

Classification uses only contemporaneous option NBBO: quote time at or before
trade time, at most two seconds old, positive quoted sizes, unlocked/uncrossed
market, and spread no more than 20% of midpoint. Prices must match bid or ask
within half a cent. Midpoint/outside-market trades, unknown conditions, and
complex/auction prints stay unclassified. Gateway v1 classifies only Massive
conditions 209 (Automatic Execution) and 219 (Intermarket Sweep Order), using
Massive's condition reference. ISO does not prove a linked cross-exchange sweep;
the panel does not label sweep clusters or infer opening/closing positions.

Real-time [Massive options trades](https://massive.com/docs/websocket/options/trades)
and [quotes](https://massive.com/docs/websocket/options/quotes) are the source.
The implementation preserves provider event time and deduplicates trade sequence
IDs server-side. A quote received after a trade is not used to revise it. Quotes
and trades share millisecond timestamp resolution; matching is an estimate.
Missing, delayed, stale, disconnected, or unavailable data clears the headline's
directional styling. There is no Unusual Whales dependency, LLM, order entry,
GEX estimate, or claim that option buys predict the underlying's next move.

## Local adapter

The existing `TAPE_OPTIONS_GATEWAY_URL` / `TAPE_OPTIONS_GATEWAY_TOKEN` settings
are reused (or the configured market-data gateway settings). The browser calls
only `/api/panel-data/options-flow?symbol=...`; the server validates the active
symbol, stock freshness, live mode, and response. Credentials remain server-side.

The adapter implements `GET {base}/options-flow?symbol=...&spot=...`, returning
schema version 1 with server milliseconds, window totals, observation lengths,
quality flags, and connection state. See the Go `flowReply`/`flowWindow` types for
the complete small wire schema. This route is independent of the snapshot route
in [OPTIONS_GATEWAY.md](OPTIONS_GATEWAY.md). An older adapter reports
**UPDATE GATEWAY**, not fabricated flow. Non-loopback URLs and redirects are
rejected. Inactive/hidden panels stop polling; the adapter releases the socket
after ten seconds without a poll. Multiple browser views of the same stock can
share its session; different stocks share one slot, so use one active symbol.

Gateway optional raw journals are an audit source for future replay. Existing
stock recordings and reconstructed volatility archives do **not** contain actual
options transactions. Until a matching flow replay reader exists, this panel
shows **NO FLOW REPLAY** during replay and never substitutes present-day options.

## Verification

```sh
go test -race ./internal/server
node scripts/panel-host-check.mjs
node scripts/options-flow-check.mjs
CHROME=/path/to/chrome node scripts/options-flow-browser-check.mjs
```

The browser fixture is synthetic and exercises the full dashboard, laptop
layouts, divergence, panel switching, unavailable data, ticker races, and replay
isolation. Screenshots go to `/tmp/options-flow-ui` by default.
