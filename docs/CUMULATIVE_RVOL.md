# Experimental 5-day cumulative RVOL

Enable **5D RVOL** in the one-minute chart toolbar or **CONTROLS → DISPLAY**.
It is off by default. The histogram occupies its own compact pane beneath the
existing volume pane; it never draws over candles, VWAP, moving averages,
trendlines, or reference levels. Its time positions match the visible candles.
The yellow **1×** reference remains visible both below and above normal volume.
The most recent completed-minute multiple appears on the right.

**VOL** independently hides/shows the existing one-minute volume bars and
large candle/day-volume readouts. Hiding a pane returns its space to price.
Both choices persist in browser settings. Switching RVOL off restores the
original price/volume geometry. Daily charts, tape analytics, Live Rewind, and
the existing median-based **RVOL PACE** retain their separate behavior.
In very short stacked layouts, the daily-map inset temporarily hides while
RVOL is on so it cannot cover price and spill into volume/RVOL. Enlarging the
chart or switching RVOL off restores it with its existing selection.

## Calculation

For a completed minute ending at time `t` in New York:

`RVOL(t) = today's cumulative RTH volume through t / mean(cumulative RTH volume through t for each of the 5 prior sessions)`

- RTH is **09:30 through 16:00 America/New_York**. Premarket and after-hours
  volume are excluded. This differs intentionally from the existing day-volume
  readout, which starts at 04:00.
- Use exactly five prior sessions with returned regular-session aggregates,
  never five calendar days or a mean of individual minute ratios. The current
  session is excluded from the baseline. Weekend/holiday dates without RTH
  bars do not count. A newly listed or continuously halted symbol with fewer
  than five represented sessions shows an insufficient-history state.
- Compare the same ET minute, including across daylight-saving changes.
  Empty intervals within a successfully fetched range have zero added volume;
  the cumulative sum carries forward. This experiment uses the fixed
  09:30–16:00 window on every session date; it does not detect early exchange
  closes, so that window can include post-close prints on half-days.
- Both numerator and denominator use the **selected provider's historical
  one-minute aggregates**. IBKR live prints are not added to IBKR history;
  Massive trades are not combined with an IBKR baseline. Providers can report
  different RVOL values because of differences in volume filtering.
- The forming minute is excluded. A **10:15 ET** as-of time includes the
  completed **10:14–10:15** bar. The initial request runs when enabled; subsequent
  refreshes allow five seconds after the minute boundary for finalized data.
  The current session's prefix is refreshed so late/revised aggregates can be
  included. It is a completed-minute indicator, not tick-by-tick projected RVOL.
- Histogram colors follow each minute candle's direction; they do not classify
  buying/selling volume. The right-hand value describes the latest returned
  RTH minute even when after-hours candles have moved the RTH bars off screen.
- A zero baseline yields no ratio. An unavailable provider or incomplete
  five-session baseline shows a message and no fabricated multiple. Hover the
  RVOL button for the as-of time and baseline dates. Before the first completed
  RTH minute (and on weekends), the study waits.

## Data and lifecycle

The existing recording database must be enabled (the normal default). It holds
the aggregate cache; detailed historical ticks are not required. Both IBKR
live mode and Massive mode are supported, including the configured Massive
gateway. IBKR uses its existing live history connection; current-session
refreshes are limited to a one-day TRADES request. Massive uses its existing
REST/gateway configuration and subscription. No additional API key is introduced.

The study fetches today's completed RTH prefix and enough fully covered prior
history for five sessions, in paced weekly chunks bounded to 28 calendar days.
Only aggregate rows are read. Provider/source isolation, coverage checks, and
an exclusive upper time boundary prevent mixing partial recordings with full
historical volumes. It shares the background-history gate so it does not add
concurrent bulk history downloads. Same-minute requests share a cached result;
completed prior-session history persists on disk.

The endpoint is `POST /api/cumulative-rvol?symbol=SYMBOL`, restricted to the
active ticker and same-origin browser requests. Loading is asynchronous and
does not modify the chart's bar store or the streaming feed. Disabling RVOL,
hiding the chart/tab, entering Live Rewind, changing ticker/provider, or
reloading cancels/invalidates requests. Late responses cannot restore a stale
number. Provider errors are sanitized and retried with a delay.

Historical replay with an explicit IBKR or Massive provider uses the replay
clock, never wall time, and excludes forming/future minutes. A mixed-provider
replay and demo mode show an unavailable state instead of synthetic RVOL.

Provider references:

- [IBKR historical bars and volume filtering](https://interactivebrokers.github.io/tws-api/historical_bars.html)
- [Massive minute aggregates and empty intervals](https://www.massive.com/docs/rest/stocks/aggregates/custom-bars)

## Verification

```sh
go test -race ./...
go vet ./...
node scripts/cumulative-rvol-check.mjs
CHROME=google-chrome node scripts/cumulative-rvol-browser-check.mjs
```

The browser check uses clearly fabricated data with no provider credentials.
It exercises 1280×800, 1440×900, 902×720, and 800×800 layouts, original-layout
restoration, persistent independent toggles, unchanged candle data, both live
feed modes, unavailable history, stale ticker responses, and hiding the study.
It saves review screenshots under `RVOL_SCREENSHOT_DIR` (default
`/tmp/cumulative-rvol-ui`). A live funded/permissioned provider smoke test is
separate from these deterministic checks.
