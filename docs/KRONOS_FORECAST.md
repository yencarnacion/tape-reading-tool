# Automatic Kronos forecast panel (experimental)

The lower section of the live tape chart is now a second first-party plugin
slot (`lowerAnalytics`). Its default is **KRONOS FORECAST**; its picker also
contains **TICK CHART** (the original price canvas) and **BLANK**. The upper ADR
selection, the one-minute chart, the delta pane, tape, audio, replay controls,
and the separate Live Rewind pressure/tick chart retain their own lifecycles.

This is a research display, not a proven prediction service or an order-entry
feature. It neither changes risk settings nor issues buy/sell instructions.

## First connection

Kronos is assumed to be installed already. `/health` means the process is alive;
this integration checks `/ready` before requesting real inference. The initial
base URL is `http://10.17.17.99:8787`.

On the machine **running the tape-reading-tool Go backend**, securely copy the
private key made by the Spark launcher. For the user's current host/user:

```sh
install -d -m 700 "$HOME/.config/tape-reading-tool"
scp yamir@10.17.17.99:.local/share/kronos-api-dgx-spark/config/api-key \
  "$HOME/.config/tape-reading-tool/kronos-api-key"
chmod 600 "$HOME/.config/tape-reading-tool/kronos-api-key"
```

The default key path is found automatically. The key never goes into the
browser, localStorage, Git, the request URL, or diagnostics. Do not paste it into
chat. The Spark and the tape backend must have synchronized clocks.

Restart the tape backend with its usual command, for example `./go-chart.sh`.
There is no per-prediction button. Existing saved ADR settings are preserved;
old settings receive a new lower slot defaulting to Kronos. The lower picker can
switch it off or restore the tick chart. Its selection and the selected horizon
are remembered locally.

### Change the server later

Set these in the tape backend's ignored `.env` file or process environment, then
restart **the tape backend**, not necessarily Kronos:

```dotenv
KRONOS_URL=http://10.17.17.99:8787
KRONOS_API_KEY_FILE=~/.config/tape-reading-tool/kronos-api-key
KRONOS_PATHS=32
KRONOS_SESSION=extended
KRONOS_ENABLED=true
```

`KRONOS_URL` may instead be `http://127.0.0.1:8787` (including an SSH tunnel),
`http://[::1]:8787`, or `https://forecast.example.com/kronos`. It is a base URL,
**not** `/v1/forecast`. A path prefix is supported. HTTPS uses normal certificate
verification. Redirects, URL credentials, query parameters and fragments are
rejected/not followed. A public/domain HTTP URL needs the explicit
`KRONOS_ALLOW_INSECURE_HTTP=true` override; prefer HTTPS instead. Private-IP HTTP
is still unencrypted: use a trusted LAN, VPN, or tunnel. This feature does not
change the tape server's bind address, firewall, CORS or CSP.

`KRONOS_API_KEY` is an alternative backend environment secret. A key file is
preferable and must be private (0600), regular and small. Paths are 8–128; 32 is
the default. Higher path counts require latency measurement on the Spark, not
an assumption that more paths make the model better. Session is `extended`
(04:00–20:00 ET, no cross-date padding) or `regular` (09:30–16:00 ET).

## Exactly what is displayed

The default horizon is five **completed one-minute bars**. Tabs select 1, 3, 5,
or 10 bars; these all come from one ten-bar sampling request. A tab change
reuses those results rather than generating a more favorable new sample.

The large **ABOVE** number is the proportion of generated paths whose terminal
close is strictly above the **last completed input candle's close**. **BELOW**
is strictly below. Equality is separately counted; the two displayed rounded
percentages need not add to 100%. The reference price, outcome clock time,
origin time, age, model identity, number of attempted paths and uncalibrated
status remain explicit. For example, an origin of 10:17 ET with a 5m horizon
concerns the close at 10:22, not five minutes after an arbitrary glance.

The small 95% interval is a Wilson interval for finite **model sampling only**.
It is not a market-prediction confidence interval, real-market calibration,
accuracy percentage, fill probability, or guarantee. Intervals are computed
from validated event counts. The median move is a distribution summary, not
an expected trade profit. No directional traffic-light grading is used.

Unknown/invalid paths never become exact probabilities, and null never becomes
0% or 50%. The selected horizon is withheld when price-path validity or the
response contract fails. A lack of decoded sample diversity also withholds the
headline. No empirical calibrator, measured forecasting edge, setup/tape model,
execution model, or automated trading feature is included.

## Automatic scheduling and data ownership

Only the **currently active symbol**, while the mounted panel is visible, is
polled. The browser asks the same-origin `/api/forecast` endpoint for a status;
that is NOT an inference call each time. The backend admits at most one global
job and stores up to 16 origin/generation results, including failures. Repeated
tabs/polls for a given symbol, data generation and completed minute reuse one
job. No repeated random draws are taken to search for favorable odds.

The first job starts approximately 1–8 seconds after a minute close. If the
panel opens mid-minute, it waits for the next close instead of silently enabling
stale research. If history arrives too late, that origin is skipped. Forecasts
are labelled with their true age and withheld once a new minute origin exists.
Slow results never overwrite another symbol or generation. Hidden/unmounted
panels start no new work; an already accepted job may finish server-side so
cancellation does not prematurely free GPU capacity. A transport failure after
POST imposes an extra 135-second cooldown because failure is not proof that
remote GPU work stopped. The upstream also retains its bounded worker queue.

The current data adapter is the existing **IBKR live completed-minute TRADES
history**, sharing its core RVOL cache and connection. It requests up to 240
same-date, same-session bars and requires at least 32. Below 120 bars is visibly
marked short history. No browser receipt-time bars, forming candle, forward-fill,
previous-day padding, second market-data feed, or Massive fallback is used.
Any gap, malformed OHLC, nonfinite value, duplicate, negative volume or stale
last minute stops the forecast. Turnover is omitted deliberately so the service
labels its OHLC-times-volume estimate rather than claiming reconstructed
turnover is exact. IBKR real-time market-data type 1 is required.

The initial time gate is conservative weekday/clock filtering. The **Kronos
server's pinned XNYS calendar validation is authoritative** for holidays,
early closes, extended-session restrictions and the entire future grid. The
required v1 `future_session_confirmed` flag means the caller submitted a scheduled
minute grid subject to that validation; it cannot promise absence of future
halts. No rejected session is retried with relaxed validation. Inspect the
Kronos logs for detailed 422 diagnostics.

**Deliberate v1 limitation:** demo, Massive live, historical replay and live
rewind are not sent to the model. They show `LIVE HISTORY ONLY` or an explicit
unsupported state. A future replay adapter must reconstruct data as actually
available at its replay clock; blindly using revised historical bars would not
establish that. Existing replay behavior is not modified by this limitation.

The Spark service's existing request/response JSONL and raw-path artifacts are
the research record. This panel adds no outcome calibrator or claimed Brier
score. Retain those records for later chronological/forward evaluation.

## Implementation contract and checks

`forecast.go` targets the **actual supplied self-contained Kronos launcher's
`contracts.py` v1.0**, not illustrative response JSON in a research report.
It sends numerical candles with offset timestamps, exact sampling fields,
explicit source units, `allow_stale_research=false`, and the four horizons.
The response origin, request identity, reference, symbol, mode, model, path count
and horizon presence are checked in Go. The panel additionally verifies event
definitions, exhaustive counts, bounds, null semantics and calibration status.

Tests are runnable without a Spark or a market-data subscription:

```sh
go test -race ./...
go vet ./...
node scripts/kronos-model-check.mjs
node scripts/panel-host-check.mjs
CHROME=google-chrome node scripts/kronos-browser-check.mjs
```

The browser check uses fabricated candles and path counts against the full app,
not a live prediction. It checks 1440×900, 1280×800, 1470×956 and 1280×720 CSS-pixel
viewports, clipping, font sizes, the independent ADR slot, automatic polling,
original tick fallback, offline states, response races and replay isolation.
Screenshots from this test are **mock UI illustrations**, not model results.
CPU/mock tests do not qualify live latency, a physical 13-inch Mac display,
Safari behavior, the user's LAN connection, or forecasting accuracy.

Scientific background: the project handoff's Sections 6–9 and 11 distinguish
bar-anchored events, invalid outputs and model frequency from calibration.
See also scikit-learn's official probability-calibration documentation
(https://scikit-learn.org/stable/modules/calibration.html). The new text uses
neutral contrast and explicit labels rather than treating color as confidence.
