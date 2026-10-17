# Estimated GEX

Select **ESTIMATED GEX** in the existing lower-panel picker. It uses the same small
slot as Options Flow, Kronos or Tick Chart; the selection is saved. Main charts,
ADR and time-and-sales keep their space. **DETAILS** opens a scrollable explanation
and the 0–30 / 0–60 / 0–120 calendar-day expiry selector (default 120).

| Cue | Interpretation under the positioning assumption |
| --- | --- |
| Teal **↔ RANGE / FADE BIAS** | Modeled hedging opposes price moves; fading a move may have more support after a tape turn. |
| Amber **⇅ EXPANSION BIAS** | Modeled hedging follows price moves; momentum may extend in either direction. |
| Gray **↔ BALANCED PROXY** | Calls and puts largely offset, or known exposure is zero. |
| Gray missing/stale/partial label | No current directional regime cue; the reason is shown. |

Colors describe damping versus amplification. They do not mean bullish/bearish,
an entry, a continuation probability or a guarantee of reversal.

The large number is estimated **dollar hedge adjustment for a 1% stock move**:

`Σ(sign × gamma × open_interest × 100 × stock_price² × 0.01)`

Calls use + and puts use −. This is the conventional **assumed dealer positioning**
proxy, not a property of put gamma: both long calls and long puts have positive
gamma. Open interest does not identify who holds either side. The actual dealer
regime can differ. The main panel says **C+/P− PROXY · positions assumed**.
Magnitude is not normalized for stock liquidity; compare one stock over time,
not dollar totals between differently sized stocks.

**LARGEST + / LARGEST −** show the largest net positive and negative strike concentrations
within ±10% of the snapshot stock price. ↑/↓ describe the strike's location above
or below that price, not a predicted price direction. Details includes the largest
12 strike totals and all expiry totals. These are not guaranteed walls, support,
resistance, max pain or a modeled gamma flip.

Each concentration also shows its percentage distance above/below the **last
stock price** and its estimated exposure. **DETAILS** starts with a signed bar
profile of up to 12 largest net concentrations within that nearby window,
ordered by strike. Negative values extend left of zero; positive values extend
right. Numerical signs and amounts are shown as well as colors. The latest
stock price and snapshot price are identified separately: exposure is computed
at the snapshot price, not by repricing the chain at each strike.

There is **no calculated mean price or reversion target**. Range/fade means
estimated damping under the positioning assumption. A stall or failed breakout
on the tape is consistent with it; the label does not establish a reversal.
Expansion means estimated amplification in either direction; actual
acceleration on the tape supplies the observed behavior. A strike concentration
is a place to observe price behavior, not an instruction to buy, sell, or fade.

Details also shows the fraction of gross exposure from expiries **0–7 calendar
days** from the snapshot's New York date, within the selected expiry window.
This helps distinguish a reading dominated by near-term expiries from one
dominated by later dates. It is not a separate near-term directional regime.
The **net/gross balance** describes cancellation between the modeled call and
put exposures; it is not confidence or a reversal probability. Unusable data
does not display a current concentration profile.

## Strike overlay on the one-minute chart

Click **GEX OFF** in the one-minute chart toolbar to enable the optional strike
profile. It starts off, and the toggle and its **0–30D / 0–60D / 0–120D** expiry
window are saved independently of the lower GEX panel. The overlay works while
Options Flow or another lower panel is selected; the ADR panel keeps its space.

Each horizontal bar sits at its stock option strike on the existing candle
price scale. **Teal positive bars extend right; amber negative bars extend left**
from a common zero line. Length is proportional to the absolute net exposure,
normalized to the largest visible current or historical exposure in the chosen
expiry window. Changing
the visible price range or expiry scope can therefore change the length scale.
All strikes inside the price pane are included; distant strikes never expand the
candle scale. Zero net exposure gets a small neutral mark. Crowded labels favor
larger concentrations, but bars remain visible. Hover a bar or label for its
strike, signed net/call/put values, snapshot time and units. The status strip's
hover text explains the scale, colors and snapshot age.

The label **EST. GEX · C+/P−** retains the same positioning assumption as the
panel. Amounts are estimated dollars of hedge adjustment per 1% stock move,
calculated at snapshot spot. They are not actual dealer inventory or price
magnets. This profile uses the stock's own strikes; it does not translate index
strikes to futures prices. The supported windows include expirations from today
through 30, 60 or 120 calendar days; 120 days is not all expirations. A separate
0DTE profile and session-open/min/max strike markers are not supplied.

The overlay refreshes visible live data on the same bounded schedule as the GEX
panel. It clears unusable, incomplete or stale data, including when the tape is
idle, and aborts obsolete symbol/scope/timeline requests. Switching to 90 DAY,
hiding the page/chart, disabling GEX, or entering local tape rewind stops its
requests. Server replay uses only recorded GEX at or before its replay clock;
missing recordings show **NO RECORDED GEX**. Paused replay does not continuously
poll. No current chain is substituted for a historical snapshot.

Bars sit behind candles; labels remain readable above chart lines. No chart or
study pane is resized. The profile moves to the opposite side when the Daily Map
is moved to a right corner. The inset stays above the volume studies and hides
while GEX is on if the price pane is too short or narrow to fit the profile and
map without obscuring strikes.

## Changes through time

The chart overlay now adds prior-time dots to each comparable strike: **1m white,
5m blue, 15m purple, 30m yellow**. A dot is the earlier exposure endpoint, on the
same signed scale as the current bar. A dot farther from zero than the bar means
its magnitude has since shrunk; a dot across zero shows a sign change. Hover a
strike to see each earlier amount, its exact observation time and the signed
change. Missing comparisons remain unavailable; an absent strike is not zero.

**HISTORY**, available from the overlay or lower GEX panel, opens a larger
recorded-data view:

- A slider and previous/next buttons step through saved observations. **LATEST
  RECORDED** returns to the newest observation available to the session clock.
- The net-GEX timeline uses actual observation times and leaves recording gaps
  blank. The selected observation is highlighted.
- The strike profile shows up to 60 concentrations within ±10% of snapshot spot,
  with individually switchable 1/5/15/30-minute dots on a common signed scale.
- The five largest absolute strike changes and the net change compare with the
  selected lookback. Amounts retain their signs; they are not trade directions.

Scrubbing is read-only: it does not seek the tape, switch stocks, or fetch a new
options chain. The displayed price is **stock at snapshot**, not the latest tape
price. The date and exact saved time remain visible, including after hours.
History uses the selected stock, current session date and expiry window. To
review another recorded date, use that session in normal server replay.

Each lookback selects the nearest saved observation at or before its target,
with a maximum 90-second gap. It never borrows a later observation or another
session. Replay exposes no snapshots beyond its clock. A gap, unusable coverage,
or missing recording is shown as unavailable. There is no invented backfill:
recordings accumulate while the visible overlay or GEX panel is enabled.

These are changes in the existing **C+/P− open-interest estimate**. Price,
Greeks, and input coverage can change the reading even when OI is unchanged.
The feed's prior-trading-day OI convention does not identify intraday option
buying/selling, opening/closing transactions, or actual dealer inventory.

The read-only `/api/panel-data/gex/history` route accepts the selected `symbol`,
`dte` (30/60/120) and optional `at` Unix milliseconds. It shares the bounded
archive cache with replay, caps the timeline at 4,096 observations and derived
comparison payloads at 4 MiB. Derived history is never written into the archive.

## Data and quality

The backend uses the existing loopback DaiDai options gateway and server-side
token, configured by `TAPE_OPTIONS_GATEWAY_URL` / `TAPE_OPTIONS_GATEWAY_TOKEN`
(with the existing market-gateway fallbacks). No second data provider or browser
API key is introduced. It separately paginates **all strikes and both calls and
puts within the selected expiry window**; it never reuses the IV panel's limited
ATM basket. Only standard 100-share contracts are included.

Fresh current stock tape is required. A fetched chain is cached for 60 seconds;
the visible panel polls every 15 seconds and requests an earlier refresh after
a ≥1% spot change, at most once per 15 seconds. Hidden or deselected panels stop
polling. Work is bounded to 64 × 250 contracts, 4 MiB/page and 20 seconds per
chain; a truncated, duplicate, malformed or unsafe paginated chain has no usable
total. The stock-feed callback does no chain fetching or file I/O.

A colored bias requires a complete chain, at least 90% of known OI and 80% of
returned contracts included, and no missing OI. Missing gamma and nonstandard
contracts are counted; unknown inputs are not treated as zero. Known zero OI
contributes exactly zero even if gamma is absent. The net must be at least 10%
of gross absolute modeled exposure; below this it is balanced. These thresholds
are data-quality/display heuristics, not calibrated confidence.

Underlying snapshot timestamps stand in for Greeks freshness because the feed
does not timestamp each Greek calculation. Inputs older than 90 seconds,
future-dated, delayed or materially different from the stock snapshot are neutral.
Live stock price drift of ≥1% also neutralizes the old reading pending a refresh.
The main panel displays coverage and snapshot age; Details shows excluded counts
and the oldest included underlying timestamp. Greek age itself remains unknown.

Open interest follows Massive's **end of the previous trading day** convention.
The snapshot does not provide an independently verified OI reporting date; the
panel says so in Details. Same-day positions, closing/opening trades and actual
dealer inventory are unknown. Quotes and trades alone cannot reconstruct them.

## Recording and replay

While this panel or the strike overlay is enabled and visible, completed numeric
snapshots are appended to `data/options-gex/YYYY-MM-DD/SYMBOL.jsonl` (override
with `TAPE_GEX_REPLAY_DIR`). **REC** means that snapshot was saved, and
**REC FAILED** indicates a write failure. This is selected-stock recording,
not background recording of every ticker. The overlay records its selected
stock even while a different lower panel is shown.
Coverage/freshness state, scope, assumed model and breakdowns are preserved.

Replay/render reads only the nearest recorded snapshot **at or before** the
replay clock, for the same symbol, date and expiry window. A gap over 90 seconds
is neutral; symbol changes, seeks and scope changes discard stale responses.
No today's-chain request is made during historical replay. Existing October 9
stock/options replay archives do not contain historical gamma + OI, so they
show **NO RECORDED GEX** unless a matching GEX archive exists. Current options
data must not be presented as past-session GEX.

## Validation

`go test ./internal/server -run '^TestGEX'`

`node scripts/gex-check.mjs`

`node scripts/gex-overlay-check.mjs`

`node scripts/gex-history-check.mjs`

`CHROME=/path/to/chrome node scripts/gex-browser-check.mjs`

`CHROME=/path/to/chrome node scripts/gex-overlay-browser-check.mjs`

`CHROME=/path/to/chrome node scripts/gex-history-browser-check.mjs`

The browser check uses synthetic local fixtures, tests laptop-sized dashboard
windows, details/settings, quality colors, paused replay, stale asynchronous
responses and panel cleanup. The overlay check measures actual canvas bar
coordinates and widths, verifies unchanged candle/volume/ADR geometry, persisted
controls, request cancellation and replay cutoff safety. History checks cover
signed deltas and scale, missing strikes, gaps, invalid inputs, actual-time
scrubbing, symbol/scope races, rewind boundaries, and closed/paused polling.

Browser fixtures are synthetic by default. To preview real recorded GEX, set
`GEX_REAL_ARCHIVE=data/options-gex/YYYY-MM-DD/SYMBOL.jsonl` when running the
history browser check; its foreground GEX view uses those archived observations.
The surrounding tape scaffold remains synthetic. `GEX_SCREENSHOT_DIR` selects
the screenshot output directory.

References: [Massive option-chain snapshot](https://massive.com/docs/rest/options/snapshots/option-chain-snapshot)
for Greeks, OI convention, pagination and underlying metadata;
[Options Industry Council on gamma](https://www.optionseducation.org/advancedconcepts/gamma)
for the long/short gamma distinction.
