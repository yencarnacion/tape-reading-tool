# Auto trendlines

## Use

Open the ordinary **1 MIN** market chart. **TRENDLINES ON / OFF**, beside the
1 MIN / 90 DAY buttons, toggles automatic support/resistance lines. First use is
ON; the browser remembers OFF/ON under `tape-reading-tool.auto-trendlines.v1`.
Reset Controls restores ON. The toggle is hidden in the daily view.

Support is green; resistance is orange. Large lines are solid, small lines are
dashed, and broken lines are faded. Hover the button for the status and legend.
No qualifying lines is a legitimate result, not necessarily an error.

The overlay does not change candle capacity, price autoscaling, daily pivots,
VWAP, moving averages, order/position levels, the tape, audio, ADR panels, the
90-day chart, the tick chart, or the Live Rewind view. It uses existing loaded
one-minute bars, not an additional feed or HTTP history request.

## Algorithm and provenance

This is independent code inspired by TradingView's public Auto Trendlines
specification, **not TradingView source and not an exact clone**:
<https://www.tradingview.com/support/solutions/43000741165-auto-trendlines/>

The engine uses Wilder ATR(14), confirmed 5/5 and 25/25 pivots, and alternating
ZigZag swings exceeding 2 and 5 ATR respectively. ATR thresholds use the first
swing anchor. The touch tolerance is half the average ATR of the two anchors.
3/3 pivots count touches. Candidate lines span same-side ZigZag anchors (with an
opposite ZigZag pivot between them). Bases cannot span a three-close break or
pierce a same-side pivot beyond the ATR tolerance. An equally strong or stronger
interior touch rejects the base.

A break requires **three consecutive closed candles** strictly beyond the line;
an intervening close on the safe side resets the count. Ranking is by touches,
length, second-pivot strength, then ATR-normalized absolute slope. Same-side
nearby/crossing lines with more than 30% base overlap compete. Small lines inside
a selected large line's touch area are suppressed. An extension older than two
base lengths becomes base-only; otherwise an unbroken line projects to the
chart's right edge, while a broken extension stops at its confirmed break.

### Deliberate approximations

TradingView does not publish every tie-break/filter implementation detail.
This implementation uses the rightmost equal-price pivot, skips an ambiguous
first outside-bar pivot, and uses the opposite swing for subsequent outside
bars. It interprets the interior-pivot filter conservatively and the overlap
rule as a **geometric, same-side** conflict, not temporal overlap alone. Touches
use a symmetric ATR tolerance to admit small wick overshoots. Slope is normalized
by ATR rather than a screen-dependent angle.

For bounded work, only the most recent **24 ZigZag anchors per side per size**
are paired, not every historical pivot. Up to three lines per side/size are
retained (12 total), with large-line exclusion processed first. Lines ending
before the latest 180 closed bars are omitted because the existing one-minute
canvas displays at most 180 candles. These choices intentionally trade exact
TradingView parity for low CPU, low memory, and a readable small-screen chart.

## Confirmation and replay

Only closed history is analyzed. The **newest candle is always held out until a
subsequent candle arrives**. This avoids dependence on wall-clock time and keeps
paused and accelerated replay deterministic. The final candle of an idle/closed
session is consequently not analyzed until another candle arrives. Small pivots
need five completed bars on the right; large pivots need 25. Lines can change as
new pivots are confirmed. This is not a non-repainting trading signal or a
validated predictive edge. Historical line origins precede their confirmation.

All geometry uses candle indexes, not elapsed minutes, so overnight/no-trade
gaps match the chart. A ticker change, history replacement, replay mode switch,
backward seek, or history trim drops previous results and invalidates in-flight
work. Late prints revising a completed minute explicitly invalidate the cache.
A result computed for an old history is never installed on a newer history.

## Performance and memory

- At most 5,000 loaded **closed** bars are analyzed; existing history limits
  (usually 2,000/2,200 bars) are not expanded and no extra history is downloaded.
- At most 1,104 pairs are evaluated and 12 lines retained. ATR/pivot extraction
  is linear; the bounded candidate checks scan at most the retained history.
- One module worker per active chart, one in-flight job, one coalesced pending
  request. Repeated ticks in the forming candle reuse cached results.
- A normal stream recalculates when a new minute candle arrives. Fast replay and
  corrections are throttled to at most one dispatch per second within a data
  context. Explicit context changes/toggles may run immediately.
- Candle transfers contain four Float64 values per bar: **160,000 bytes maximum**.
  The buffer is transferred, not duplicated for each queued request. This is the
  input payload size, **not total browser/worker memory**.
- OFF, hidden tabs, the daily view, hidden charts, Live Rewind, and pagehide stop
  the worker and clear pending timers/results. pageshow restores normal redraw
  behavior. Worker failures leave the chart working and require a toggle or
  context change to retry, rather than entering a restart loop.
- Drawing uses the chart's existing coordinates, saves/restores canvas state,
  and clips to the price pane. There are no extra canvases or permanent render
  loops, and no patches to fetch, WebSocket, or canvas prototypes.

## Verification

Run from the repository root with Node 22 or newer:

```sh
node --test scripts/auto-trendlines.test.mjs
node --expose-gc scripts/bench-auto-trendlines.mjs
node --check internal/server/web/app.js
go test ./...
```

The deterministic tests cover ATR, pivot confirmation, plateaus, swing filtering,
three-close breaks/reset, base rejection, extension aging, overlap filtering,
resource limits, replay prefixes, invalid input, gap-aware drawing, settings,
intrabar caching, queue coalescing, late corrections, stale responses, worker
failure, hidden pages, bfcache restoration, and disposal.

The benchmark reports 200 warmed runs at 500, 2,000 and 5,000 bars, input bytes,
candidate/line counts, and post-GC retained-memory changes. Those are synthetic
Node measurements, not a worst-case latency guarantee or a MacBook/browser
memory measurement. Initial local 5,000-bar testing on Node 22 / AMD EPYC 9V74
measured roughly 1.0 ms median and 1.2 ms p95. Re-run on the target machine.

Browser console diagnostics, without exposing another candle copy:

```js
window.__tapeReadingAutoTrendlines()
```
