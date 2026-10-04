# ADR + Options Vol

The existing `adr-rth-extension` panel now displays **ADR + OPTIONS VOL**. Its
saved settings and ADR arithmetic are preserved: the mean of `High / Low - 1`
over the selected 5–60 completed RTH sessions, normalized extension from RTH
low or high, and AUTO direction. The active ADR/options slot receives more
vertical space (up to three times its former allocation), while the lower
forecast/tick slot becomes compact. The chart, tape, and independent rewind
keep their own lifecycle. A smaller screen limits growth to preserve Kronos.

## Run

The normal tape, ADR, audio, demo, and recorded stock replay work without an
options subscription or any companion application. Options are optional: an
unset gateway leaves the panel neutral and makes no options network requests.
To see the production panel with synthetic data and no credentials, run
`node scripts/options-dashboard-preview.mjs` and open
`http://127.0.0.1:18098/preview/ready` or `/preview/wide`. This full-page preview
uses fabricated tape, options, and Kronos values; it makes no provider calls.

For live options, configure a local service implementing the public
[options gateway contract](OPTIONS_GATEWAY.md), then start the tape reader as
usual. The selected stock drives the panel; QQQ/SPY are not required.

Backend-only settings, stored in an ignored `.env` or process environment:

- `TAPE_OPTIONS_GATEWAY_URL`: optional loopback HTTP(S) API base, for example
  `http://127.0.0.1:8080/options`. No default companion service is assumed.
- `TAPE_OPTIONS_GATEWAY_TOKEN`: optional local gateway bearer token, **not** a
  provider API key. It never enters browser JavaScript.
- `TAPE_OPTIONS_REPLAY_DIR`: prepared archive directory; default
  `data/options-replay`. Playback needs no gateway or provider credentials.

The gateway owns provider authentication, request limits, caching, and relative
pagination. The tape reader never opens a direct options-provider connection.
Unavailable gateways, missing entitlement, thin/stale quotes, closed markets,
and incomplete chains produce neutral states while ADR continues independently.
Demo says `OPTIONS LIVE ONLY`; use the synthetic preview to explore the options
states. Live Rewind continues to show the live ADR and options panel.

## Historical replay

Use any compatible local gateway to prepare options beside an existing stock
recording. The following date and ticker are illustrative, not bundled data:

```bash
export TAPE_OPTIONS_GATEWAY_URL=http://127.0.0.1:8080/options
python3 scripts/prepare-options-replay.py --symbol AAPL --date 2026-07-24 \
  --db /path/to/recorded-tape.db --start 09:30 --end 10:30
./go-chart.sh replay -symbol AAPL -source live -provider ibkr -db /path/to/recorded-tape.db
```

The Python helper uses only the standard library and opens the stock database
read-only. It reads gateway settings from the **shell environment** or the
`--gateway` argument, not `.env`. Contract lookup uses the historical `as_of`
date; quotes use the gateway's historical routes. Four workers, bounded
pagination, cached raw quotes, and atomic output keep preparation resumable.
The helper never reads a provider key. Other producers can write the documented
[archive format](OPTIONS_GATEWAY.md#offline-archive-contract) directly.

Historical quotes do **not** include historical vendor IV or Greeks. The panel
therefore labels them **REPLAY · EST.** It inverts European Black-Scholes at the
bid/ask midpoint with zero interest and dividend yield, ACT/365 calendar time,
and 16:00 ET expiry. American exercise and carry are not modeled. The default
expiry is the first after the replay date, avoiding a 0DTE model; `--expiry` can
select a specific expiry. These approximate values are not an exact replay of
what the live vendor IV would have shown.

Positive historical bid/ask sizes replace the unavailable historical OI/volume
gate. The same 20-second quote-age, 20% spread, paired-strike and IV-consistency
checks still govern signals. Wider markets may display **OPTIONS WIDE** and a
median bid–ask IV estimate range, with all point-estimate trend, skew, move-used
and exhaustion signals withheld. The range reflects quoted price uncertainty,
not a confidence interval. Missing quotes remain unavailable.

Only samples at or before the server's replay position are returned. A paused
clock stays fixed; seeks reset the model and rebuild the same observed history
from the prepared start. Subsequent polls request only new samples. Missing files
and times outside the prepared interval never fall back to a live snapshot.

Recorded IBKR sessions may lack complete prior-day/RTH coverage. When complete
Massive bars and historical ticks have been separately prepared in the replay
database, the ADR baseline and initial RTH range can use those, explicitly named
in the ADR tooltip and API response. The baseline uses one provider throughout;
the current tape retains the original recorded IBKR arrivals. ADR arithmetic,
lookback and FROM LOW/FROM HIGH controls are unchanged.

## Expanded dashboard

Six cards show ATM IV and expiry, one-minute IV impulse with 30s/5m comparisons,
frozen IV move used, distance from the observed IV peak, actual pace (RV/IV),
and five-minute put-skew direction. RISING/EASING uses a 0.2-point display
deadband; the divergence calculation retains its documented stricter gates.

A separate flow strip uses a green **BUY FLOW** badge or coral **SELL FLOW**
badge, with text labels so direction never depends on color alone. Its neutral
**FASTER / SLOWER / STEADY** label describes pace independently of side:
slowing sell flow stays coral, and slowing buy flow stays green. The percentage
compares the previously dominant classified side's share volume over adjacent
completed 30-second windows: SLOWER below −25%, FASTER at +25% or more,
STEADY otherwise. These are the existing SLOWING/ACCELERATING model states;
the calculations and divergence rules are unchanged. MIXED means the earlier side
was not at least 20% dominant. A full minute, ten prints per window, and a stock
print within ten seconds are required. MIXED, BUILDING, and STALE use neutral
gray, and a disconnect or symbol reset clears the previous side's color.
These are descriptive thresholds, not price-direction or buy/sell signals.

Four small divergence checks expose the existing logic: new five-minute low,
IV easing, put-minus-call skew not rising, and sells slowing. A checkmark means
the condition is met; a dot means not met; a dash means insufficient comparable
data. The headline only alerts when the complete rule passes. There is no
invented pressure score or probability.

When options are wide/stale/unavailable, IV impulse, peak, move-used, skew, and
divergence checks clear. Valid underlying flow and raw five-minute realized
volatility remain available independently; RV ONLY never implies an RV/IV
ratio. RV itself clears if underlying prints become stale. At the RTH open,
flow needs a minute and RV needs five minutes before appearing.

Layout checks cover 1280×720, 1280×800, 1440×900, and 1470×956. Main options
numbers stay at least 22px; the compact forecast uses 32px numbers and retains
its reference price/time, usable-path count, uncalibrated label, and sampling
uncertainty. Its 128px slot returns height to volume delta without shrinking
the ADR/options allocation. Delta also shows its positive/negative share scale.
The layout uses available height, not physical screen inches.

## Glanceable readings

- **VOL EXPANDING / COOLING / STEADY**: actual one-minute ATM IV change, with a
  deadband of the greater of 0.2 volatility points or 0.5% of current IV. No
  invented normalized pressure score. The 30s, 1m, and 5m deltas are in DETAILS.
- **ATM IV**: median of 4–6 accepted contracts across 2–3 paired nearby strikes
  in the nearest usable expiry. The expiry is shown in DETAILS; a weekly or
  monthly contract is never labeled 0DTE.
- **OFF IV PEAK**: percentage change from the highest IV **observed since the
  displayed time**, not an unobserved session high. It resets if the contract
  basket changes, quality fails, or samples are more than 20 seconds apart.
- **IV MOVE USED**: absolute stock-price change since the displayed tracking
  start, divided by the frozen estimate `initial price × initial IV / √252`.
  This is a **one-trading-day projection from front IV**, not a move to expiry,
  not today's opening implied move, and not a hard price boundary. It can exceed
  100%. Earnings/event risk and the difference between calendar and trading-time
  volatility make it approximate. Reloading/reselecting the panel starts a new
  observed reference; later IV changes do not rewrite its denominator.
- **RV/IV**: root mean squared log return over thirty completed 10-second
  intervals, annualized by `252 × 390 × 6`, divided by ATM IV. Every price bin
  must exist; no forward filling through gaps. QUIET <0.75, NORMAL <1.25,
  ELEVATED <1.75, EXTREME otherwise. These are descriptive thresholds, not
  calibrated probabilities. Five minutes of suitable underlying data is needed.
- **SKEW**: 25-delta put IV minus 25-delta call IV, in volatility points. Each
  wing must be within 0.08 delta of the target. Missing wings stay unavailable;
  the five-minute change requires the same wing contracts.

**IV DIVERGENCE** is a visual downside alert only when the stock makes a new
observed five-minute low, IV is at least 3% below its observed peak and falling
on the one-minute window, a full five-minute IV comparison exists, put skew is
not rising over five minutes, and classified sell flow is slowing. It does not
emit audio or place trades. The full reason is in DETAILS.

**EXHAUSTION WATCH** requires ≥1 ADR extension or ≥80% IV move used, IV at least
5% below peak and falling over one minute, and tape slowdown. Sell-side watches
also require non-increasing five-minute skew. Both watch states are research
heuristics, not demonstrated trading edges or entry instructions.

Tape slowdown means the previously dominant side exceeded the other side by
20%, then its classified share volume fell at least 25% across adjacent 30s
windows. Both windows need ≥10 prints; there must be a full minute of observed
history and a stock print within 10s. Divergence also requires five minutes of
history with at least 150 occupied seconds. A halt or silence is not exhaustion.

## Data quality and bounds

The first two complete expiries found within 45 calendar days and ±10% of stock
price are considered. Pagination is bounded to 8 pages × 250 contracts and a
6-second total request deadline; hitting the bound produces no partial signal.
The client refreshes every 5 seconds after a result (15 seconds on errors),
coalesces requests, and cancels browser work on symbol/panel changes. Quote age,
not HTTP receipt time, controls freshness. Provider IV has no separate timestamp;
the trend represents sampled IV associated with accepted quotes.

ATM contracts must have a positive uncrossed bid/ask, relative spread ≤20%,
REAL-TIME quotes no more than 20s old and no more than 2s ahead, volume ≥10 or
open interest ≥20, standard 100-share delivery, and |delta| 0.30–0.70. At least
two strikes must have both calls and puts, all within 25% of the basket's median
IV. IV must be positive and ≤1000%. These gates deliberately leave thin stocks
with ADR + tape rather than a misleading options signal. They are not a numeric
"quality score" or proof that a market is suitable for execution.

## Verification

```
go test ./...
node scripts/options-volatility-check.mjs
node scripts/options-lifecycle-check.mjs
node scripts/adr-panel-check.mjs
node scripts/adr-open-recovery-check.mjs
node scripts/panel-host-check.mjs
node scripts/options-ui-preview.mjs
```

The last command serves a synthetic, local-only production-panel preview at
`http://127.0.0.1:18098` with expanding, divergence, thin-options, offline, and
replay scenarios and an adjustable panel width. It has no provider connection.

Provider schema: [Massive option chain snapshot](https://massive.com/docs/rest/options/snapshots/option-chain-snapshot).
