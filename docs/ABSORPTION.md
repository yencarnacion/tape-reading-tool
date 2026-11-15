# Volume and volatility adjusted absorption

**ABS ON** in the chart toolbar shows inferred absorption in the price pane.
It defaults on, is saved per browser, and also has a Controls checkbox. It appears
on the minute chart and visible tick-price charts, including Live Rewind, but not
the daily chart. It adds no vertical panel and never changes the price scale.

- Green **BUY ABS**: aggressive sales meet apparent buying support.
- Red **SELL ABS**: aggressive purchases meet apparent selling resistance.
- **TESTING**: enough evidence has arrived to mark an area; dashed boundaries.
- **HELD**: observed midpoint movement supports the area for at least one second;
  solid boundaries. A held area can still fail.
- **BROKEN**: observed midpoint movement crosses against the area for at least one
  second. The band fades and ends at the break timestamp.

Hover a minute-chart band/label for prices, shares, prints and volatility reference.
The label's multiple is relative volume, not a probability or remaining hidden
order size. Up to eight visible areas are drawn, prioritizing unbroken areas.
Colliding labels are omitted while their bands remain inspectable.

## Method and limits

This is a causal Level 1 heuristic, **not confirmed iceberg detection**. NBBO and
prints cannot establish a hidden parent order or a common counterparty. Direction
is inferred only for trades at a fresh bid or ask; midpoint/tick-test direction is
not treated as known aggressor direction.

The detector uses five-second windows and up to 60 preceding completed windows
(five minutes). Its baseline is the stock's own recent activity, not market cap.
It uses a rolling baseline, **not** a multi-day same-time-of-day profile.

1. Median prior five-second high-low range estimates short-term volatility.
   Bucket width is the greater of $0.01, 20% of that range, and median spread.
   Overlapping clusters cover two buckets to avoid boundary loss.
2. Prior window buy/sell volume is divided by the number of similar two-bucket
   price bands covered. The sides have separate median baselines with a
   25-share floor.
3. Cluster volume must exceed 3× baseline and baseline + 3×1.4826×MAD, with a
   100-share floor. It needs eight prints spanning one second and at least 70%
   one-sided volume within the cluster.
4. The observed window range cannot exceed the greater of cluster width and
   75% of typical prior range. High-volume sweeps are not absorption.
5. Hold/break distance is the greater of $0.02, twice spread at detection, and
   half typical prior range. Detection bounds, volume, multiple and this
   distance are frozen; only subsequent hold/break timestamps can change.

Nearby same-side detections are suppressed within a clock minute. Later minutes
can produce new zones. Areas expire after 15 minutes, with three extra minutes
retained for Live Rewind; memory is capped at 96 zones. A gap over 30 seconds in
tape input resets inference. Warmup needs 60 seconds, 12 completed windows and
100 qualifying bid/ask prints. `ABS n/60s` shows warmup; `ABS WAIT` means usable
quotes/prints are still insufficient after that time.

Volume-only/excluded sale-condition reports cannot form zones. Invalid,
locked/crossed, stale quotes (over two seconds), out-of-quote prints and late
prints are rejected. Existing candle and volume eligibility remain unchanged.

## Recording and replay

The shared Go tape store owns detection. Direct Massive, the local Massive
gateway and IBKR provide quote receipt timestamps. Existing SQLite trade/quote
recordings supply replay inputs, with the same receipt clock and detector.
No additional service or credentials are needed.

WebSocket updates deliver state changes without waiting for a candle close;
reconnect snapshots include zones. Start/seek/cue reconstruct the baseline and
recent zones from up to 20 minutes and five seconds of preceding recorded ticks,
without playing warmup aloud. Missing data leaves inference warming. Backward
seeks discard later states; Live Rewind hides future detections/transitions.
Render exports use the same state. No finished future candles are inputs.

## Validation

```bash
go test ./... -timeout 120s
node scripts/absorption-overlay.test.mjs
```

The opt-in Friday SNDK test runs the recording through the actual Massive live
parser and replay engine, compares minute checkpoints and random-access cues,
and writes an optional JSON audit. **Use an isolated SQLite backup**, since
opening a database can perform normal application migrations:

```bash
TAPE_ABSORPTION_TEST_DB=/private/tmp/friday-copy.db \
TAPE_ABSORPTION_REPORT=/private/tmp/absorption-report.json \
  go test ./internal/feed -run TestAbsorptionFriday -v -timeout 180s
```

`scripts/absorption-browser-check.mjs` drives an isolated replay server using
that database/report. It checks chart geometry, visibility controls, reload
persistence, paused frames, ordinary WebSocket playback and backward cueing,
and saves screenshots. Its header lists the environment variables. Chrome runs
in a separate profile. These checks validate causality and implementation,
**not trading profitability**.
