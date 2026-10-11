# Daily run and Bollinger extension

Two compact readouts sit under **LAST**, outside the chart. **Controls → Daily
run / BB readouts** turns them on/off and remembers the choice. They are on
by default. They use space inside the existing price cell; candle, volume and
RVOL pane dimensions do not change. Experimental 5D RVOL remains off by default.

| Readout | Meaning |
| --- | --- |
| DAY ↑3D* | Three consecutive close-to-close up days, including today's developing price |
| DAY ↓4D* | Four consecutive down days, including today |
| DAY ↑3+D* | At least three up days; the loaded history ends before the run does |
| DAY FLAT | Current price equals the preceding close, ending the run |
| BB ↑2.4% | Current price is 2.4% above the upper daily Bollinger band |
| BB ↓2.4% | Current price is 2.4% below the lower daily band |
| BB IN | Current price is inside or exactly on the daily bands |
| — | Price/history is unavailable or insufficient |

Three or more days and extension outside a band are highlighted in yellow.
Arrows carry direction. Hover the values for the definitions and band prices.
The asterisk marks today's unfinished session, including premarket prices.

The developing **BB(20,2)** uses 19 completed daily closes plus the current
session's **LAST**, a simple average, and population standard deviation
(divisor 20). Percent extension is `100 × (LAST / breached_band − 1)`.
It measures distance beyond the band, not distance from the SMA or %B.
Close-to-close comparisons include gaps; candle body color is not the rule.
A flat close ends a run, and an opposite move starts a new run at one day.

Both values reuse the Daily Map's completed-history loader and selected data
source. Massive and IBKR use the same arithmetic, with each source's existing
daily-history/adjustment conventions. No new API keys or subscriptions are
required. A missing current-session LAST stays unavailable; yesterday's last
trade is not passed off as today's developing candle. Missing history adds no
invented bars or zero readings. No extra chart overlay is drawn.

Replay uses its own clock and prior daily cutoff. Current/future daily bars are
excluded, as are prices beyond the replay clock. Ticker changes and history
responses retain the existing cancellation and identity checks. While live
rewind covers the minute pane, these header readouts follow the live LAST,
just like the other header metrics.

The formula matches DaiDai's daily-context ranking factors. Provider and split
adjustment differences can still produce different prices between applications.

Checks: `node scripts/daily-extension-check.mjs`, `node scripts/day-map-check.mjs`
and the full-page `scripts/cumulative-rvol-browser-check.mjs` (four viewports,
Massive/IBKR modes, missing history and remembered toggle).
