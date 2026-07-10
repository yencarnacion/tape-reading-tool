# tape-reading-tool

A compact, real-time IBKR tape reader for split-second scalping. It renders tick bars, trade volume, volume delta, and a narrow color-coded time-and-sales stream. Every received print is also sent to a low-latency browser audio mixer.

## What it does

- Connects to TWS or IB Gateway through the socket API.
- Requests `AllLast` tick-by-tick trades and a top-of-book quote stream.
- Aggregates `1T`, `10T`, `100T`, `1000T`, or custom tick bars in the browser.
- Keeps volume and volume delta aligned with the price pane.
- Shows the maximum positive and minimum negative delta in large text.
- Retains a recent ticker history and caches a configurable number of IBKR subscriptions for fast switching back.
- Runs the sound path through an `AudioWorklet` mixer with distinct buy/sell timbres and size-sensitive emphasis.
- Batches WebSocket delivery at frame-scale intervals without threshold-filtering prints.

The program is read-only. It does not place or manage orders.

## Requirements

- Go 1.23 or newer.
- TWS or IB Gateway running locally or on a reachable host.
- The TWS socket API enabled and the configured client ID available.
- Live market-data permissions for the instruments being watched.
- A current Chromium, Chrome, Firefox, or Safari browser with AudioWorklet support.

IBKR's tick-by-tick behavior and request restrictions are documented in the [official tick-by-tick guide](https://interactivebrokers.github.io/tws-api/tick_data.html).

## Configure

Local defaults are in `.env` and detailed settings are in `config.yaml`.

```dotenv
IBKR_HOST=127.0.0.1
IBKR_PORT=7497
IBKR_CLIENT_ID=97
DEFAULT_TICKER=AAPL
PORT=8097
```

Common socket ports are `7497` for TWS paper, `7496` for TWS live, `4002` for Gateway paper, and `4001` for Gateway live. Confirm the port in the API settings of the running TWS/Gateway instance.

The main settings worth changing during setup are:

```yaml
ibkr:
  exchange: SMART
  primary_exchange: ""
  market_data_type: 1
  subscription_cache: 3

tape:
  ring_size: 50000
  snapshot_trades: 12000
  websocket_batch: 16ms
  websocket_max_batch: 4096
```

`subscription_cache` keeps recent tick subscriptions alive for quick back-navigation and avoids immediately repeating the same tick-by-tick request. Keep it within the market-data capacity of the IBKR account.

## Run

Use the synthetic burst feed to verify the UI and sound without TWS:

```bash
./go.sh demo
```

Connect to IBKR:

```bash
./go.sh live
```

Then open [http://localhost:8097](http://localhost:8097). `Ctrl-C` shuts down the HTTP server and IBKR connection cleanly.

An alternate config or listen address can be supplied from the CLI:

```bash
./go.sh live -config config.yaml -addr :8098
```

## Live diagnostics

`./go.sh live` prints bounded diagnostics to the terminal. The important stages are:

- `IBKR TCP probe succeeded`: the configured host and port are reachable.
- `IBKR API handshake complete`: TWS/Gateway accepted the client ID and protocol handshake.
- `next_valid_id ... API session is ready`: the API session completed startup.
- `IBKR subscription request`: quote and `AllLast` requests were sent for the symbol.
- `IBKR first quote` and `IBKR first trade`: market data is reaching the application.
- `IBKR heartbeat`: every five seconds, reports connection state, bid/ask, cumulative quote/trade callbacks, last-event times, and the latest IBKR status message.

The last stage printed identifies the failure boundary. Common examples:

- `TCP probe failed ... connection refused`: wrong host/port, API socket disabled, or Gateway not listening yet.
- Stops after `API handshake starting`: trusted-IP, API-version, or duplicate-client-ID problem.
- Handshake succeeds but an `IBKR error` follows the subscription: contract definition or market-data entitlement problem.
- Quotes increase but trades remain zero: the top-of-book subscription works, but tick-by-tick trade data is unavailable or not entitled.

Gateway farm-status messages are printed as `IBKR notice`; request and entitlement failures are printed as `IBKR error`. Individual prints are not logged, so diagnostics remain usable during a fast market.

## Controls

- Enter a ticker and press `Enter` or `GO`. The input selects its full contents on focus for quick replacement.
- Use the arrow buttons and recent-ticker dropdown to revisit symbols.
- Select the tick count from the toolbar. `CUSTOM` opens the controls panel.
- Use `CONTROLS` to change visible bars, tape rows, pane visibility, size visibility, and every sound parameter. `Master` boosts overall output up to 200%; `Small prints` sets an audible floor for isolated, low-size trades.
- Press `SOUND START` once to satisfy the browser's audio gesture requirement. The same control then mutes/unmutes the mixer.
- Press `/` while outside an input to focus the ticker field.

Browser settings are saved in local storage, so changes remain available on the next run without editing files.

## Trade classification

Time and sales uses the latest top-of-book quote at receipt time:

| Print | Color |
|---|---|
| Below bid | Magenta |
| At bid | Red |
| Between bid and ask | White |
| At ask | Green |
| Above ask | Yellow |

At-bid and below-bid size is negative delta. At-ask and above-ask size is positive delta. Prints between the quote use the standard tick rule: an uptick is positive, a downtick is negative, and an unchanged print carries the previous direction.

## Performance model

IBKR callbacks do constant, bounded work: quote lookup, classification, and one ring write. Each symbol uses a fixed-size ring rather than an ever-growing slice. WebSocket clients pull from sequence numbers in batches, so a slow client cannot block the feed callback or allocate a queue per print. If a client falls behind the ring, the UI reports the overwritten count as `LAGGED`.

The canvas redraws only when data or dimensions change. Time and sales reuses a fixed DOM row pool. The audio worklet receives every delivered print, synthesizes it off the main thread, and uses a fixed voice pool; under extreme overlap, a new print steals the oldest active voice instead of allocating another Web Audio graph.

## Verify

```bash
go test ./...
go test -race ./...
go build -buildvcs=false ./cmd/tape-reading-tool
```

With demo mode running, the dependency-free browser check drives local Chrome at the two target widths and saves screenshots under `/tmp`:

```bash
node scripts/browser-check.mjs
```

## Notes

- `AllLast` includes additional trade types such as combos, derivatives, and average-price trades when IBKR supplies them. This tool intentionally does not filter those prints.
- Exchange timestamps in the IBKR tick callback have one-second resolution. The tool separately records local receipt time in microseconds for tape-rate measurement and audio scheduling.
- The referenced `ticksonic-original` repository returned GitHub 404 during implementation. The mixer and synthesis path here were implemented directly from the requested behavior.
