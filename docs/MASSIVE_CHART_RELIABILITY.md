# Massive chart and history reliability

The live Massive path continues to use the configured local market-data gateway.
It opens no direct provider connection and needs no new package or credential.

## Candles and time & sales

Stock trade conditions now survive ingestion, recording, replay and rewind.
Minute candles apply the provider's separate open/close, high/low and volume
rules. Odd-lot and average-price reports can contribute volume without moving
the candle price. Range-only reports can extend a wick without replacing the
close. Unknown conditions are conservatively excluded from candle calculations.
A late report cannot roll the latest close back to an older event timestamp.
Tick candles count only reports eligible to update open/close.

Time & sales keeps special reports visible, dimmed and marked with a dot. Hover
for their eligibility and available condition codes. Thus a printed trade price
may correctly differ from the candle close or eligible LAST price. No price cap,
median filter or artificial averaging is applied to real eligible moves.

The embedded stock condition table was retrieved on 2026-10-05. Startup attempts
to refresh it through the gateway; an unavailable reference endpoint retains
the embedded table. See the provider's [condition reference](https://massive.com/docs/rest/stocks/market-operations/condition-codes)
and [trade eligibility explanation](https://massive.com/blog/understanding-trade-eligibility).
Combined sale conditions must permit each candle field. Extended-hours trading
can produce fewer eligible candles; a report is not made eligible merely because
it occurred outside regular hours.

The minute chart's vertical scale fits visible candle prices. Distant VWAP or
moving-average bands no longer squash or shift the candle pane. Indicators are
clipped to the visible price area; the yellow VWAP legend retains its value and
shows an up/down arrow when outside that area. VWAP arithmetic is unchanged.
Paint work is coalesced to 30 frames/second while every received report is still
processed. Genuine eligible price changes remain immediate on the next paint.

New Massive recordings store exchange timestamps as market time and persist
ring sequence IDs. Existing recordings retain their original stored data;
condition eligibility is derived during reads, with explicit exclusions kept.
This does not promise identical candles to every commercial feed: provider
coverage, delayed reports, corrections and historical aggregate revisions differ.

## ADR and daily history

ADR remains the mean of `(high / low - 1)` over the selected number of completed
regular sessions, excluding the current session. Massive uses unadjusted RTH
minute aggregates. Duplicate dates and malformed OHLC cannot count as completed
samples. There is no silent shorter-lookback or different-provider fallback for
live ADR.

Unavailable/insufficient ADR data and unavailable RTH context retry after five
seconds. The completed ADR baseline can display even while today's context is
recovering. Completed baselines are retained when only context needs a retry.
Daily chart failures/empty results retry while that chart is visible, without
requiring a ticker change. Old ticker requests are cancelled and cannot replace
the current ticker's history. Server cache locks are released before network IO;
a slow history request cannot lock out another ticker's ADR request. Completed
gateway daily bars are reused across compatible lookbacks.

## Reconnects and options

Stock gateway reconnects start at 250 ms, with bounded backoff up to two seconds.
An eight-second heartbeat silence limit detects a stalled local stream. Each
connection has an epoch so even a brief disconnect causes history/ADR resync.
These intervals are retry/detection settings, not end-to-end freshness guarantees.
Transient options failures retry quickly; request timeouts leave an explicit
unavailable state rather than staying pending forever. Entitlement/delayed-feed
states remain explicit. The gateway owns provider connections and recovery.

## Verification

- `go test -race ./internal/tape ./internal/storage ./internal/feed ./internal/server ./internal/marketgateway`
- `node scripts/massive-chart-check.mjs`
- `node scripts/adr-retry-check.mjs`
- `node scripts/adr-panel-check.mjs`
- `node scripts/adr-open-recovery-check.mjs`
- `node scripts/chart-history-check.mjs`
- `node scripts/day-map-check.mjs`
- `node scripts/rewind-check.mjs`
- `CHROME=/path/to/chrome node scripts/massive-recovery-browser-check.mjs`

The isolated browser fixture checks extreme special reports, correct OHLCV,
a stable price scale, an immediate genuine move, marked time & sales and recovery
from a first daily-history HTTP failure. It is synthetic data, not a live trade.
