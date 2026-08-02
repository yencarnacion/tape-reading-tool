# External Historical Replay Control

Tape Reading Tool can be cued by a local journal, review program, scanner, or educational tool to an exact symbol and historical time. Control uses the existing SQLite event store, replay feed, WebSocket stream, chart, and audio implementation.

## Configuration and security

External control is off by default:

```yaml
external_replay:
  enabled: true
  loopback_only: true
  default_warmup: 180s
  max_detailed_speed: 4
  sync_tolerance: 750ms
```

Optionally set `TAPE_EXTERNAL_REPLAY_TOKEN` in `.env`. When configured, every control request must include `X-Tape-Control-Token`. Token comparison is constant-time. The endpoints do not enable CORS, launch or discover processes, scan ports, or download missing data. Loopback restriction is enabled by default; do not disable it on an untrusted network.

## Preparing data manually

Bars are unadjusted one-minute Massive aggregates so their prices agree with raw historical prints. Both commands are manual and write completion coverage only after each data-kind request succeeds.

```bash
./go.sh download-bars -provider massive -symbol AAPL \
  -start "2026-07-01 04:00:00" -end "2026-07-02 12:00:00" \
  -db data/replay/2026-07-02.db

./go.sh download -provider massive -symbol AAPL \
  -start "2026-07-02 09:30:00" -end "2026-07-02 16:00:00" \
  -db data/replay/2026-07-02.db

./go.sh replay -provider massive -source historical -symbol AAPL \
  -db data/replay/2026-07-02.db -xtra
```

Repeated bar downloads upsert the `(symbol, provider, source, minute)` key. Completed intervals are stored independently for `minute_bars`, `trades`, and `quotes`; an interval with zero rows is valid coverage. Coverage checks merge adjacent and overlapping successful intervals rather than inferring coverage from the first and last row.

## Protocol version 1

All request bodies use `Content-Type: application/json` and `protocol_version: 1`.

### Status

`GET /api/external-replay/status` returns:

```json
{
  "protocol_version": 1,
  "enabled": true,
  "mode": "replay",
  "capable": true,
  "control": {
    "attached": true,
    "controller_id": "local-review-controller",
    "controller_session_id": "opaque-session-id",
    "sequence": 17,
    "generation": 3,
    "symbol": "AAPL",
    "target_us": 1782994559999000,
    "playing": false,
    "speed": 1,
    "fast_follow": false,
    "state": "paused"
  },
  "replay": {}
}
```

`capable` is true only when enabled in replay mode. A control request in live, Massive-live, demo, or render mode returns `409 Conflict`. Disabled control returns `404`, a non-loopback client returns `403`, and a bad configured token returns `401`.

### Coverage

`POST /api/historical/coverage/check` accepts up to 256 requirements:

```json
{
  "protocol_version": 1,
  "requirements": [
    {"symbol":"AAPL","provider":"massive","kind":"minute_bars","start_us":1782907200000000,"end_us":1783008000000000},
    {"symbol":"AAPL","provider":"massive","kind":"trades","start_us":1782994020000000,"end_us":1783008000000000},
    {"symbol":"AAPL","provider":"massive","kind":"quotes","start_us":1782994020000000,"end_us":1783008000000000}
  ]
}
```

Each result echoes `requirement` and returns `complete`, plus normalized `covered` and `missing` interval arrays. This endpoint is read-only and never downloads data.

### Control

`POST /api/external-replay/control` supports `cue`, `sync`, and `detach`:

```json
{
  "protocol_version": 1,
  "controller_id": "local-review-controller",
  "controller_session_id": "opaque-session-id",
  "sequence": 17,
  "action": "cue",
  "symbol": "AAPL",
  "source": "historical",
  "provider": "massive",
  "target_us": 1782994559999000,
  "warmup_start_us": 1782994379999000,
  "range_end_us": 1783008000000000,
  "playing": false,
  "speed": 1
}
```

`cue` and `sync` validate coverage for all three data kinds, cancel the preceding generation, clear the old symbol, silently reconstruct the bounded warmup through the exact target, and then pause or play. Reconstruction never emits browser events incrementally, and canceled generations cannot apply later events. A duplicate accepted sequence returns the current status without doing work; a lower sequence returns `409`. A different session also receives `409` until the owner detaches.

```bash
curl -sS http://127.0.0.1:8097/api/external-replay/control \
  -H 'Content-Type: application/json' \
  -H "X-Tape-Control-Token: $TAPE_EXTERNAL_REPLAY_TOKEN" \
  --data-binary @cue.json
```

`detach` releases ownership and leaves the display intact. A manual ticker or replay transport request detaches first. Chart and tape display settings do not detach. The badge itself performs a manual pause/detach.

## Chart, sound, and fast follow

Completed cached minutes provide broad chart context. Detailed trades replace them only when trade coverage proves the entire minute is present. The forming minute is always rebuilt from eligible trades through the exact target, so its future high, low, close, and volume cannot leak.

At speeds through `max_detailed_speed`, playback uses the normal detailed tape and audio path. Cue and sync reconstruction are silent; sound can begin only with new post-target events. Browsers still require a user gesture to initialize Web Audio, and the badge shows `AUDIO LOCKED` until that has happened.

Above the threshold the controller enters `FAST FOLLOW`: detailed playback and sound remain paused, the authoritative target and chart update on sync, and the tape is visibly marked suppressed. Returning to detailed speed or pausing sends another exact silent reconstruction before detailed state is shown.

## Limitations

- Control is local HTTP, not a durable distributed coordination protocol.
- Fast follow advances when the controller sends authoritative sync anchors; it does not extrapolate indefinitely after controller loss.
- Massive aggregate requests are bounded to the provider's 50,000-base-aggregate response limit; split very long ranges into explicit downloads.
- Audio readiness is browser-local; the badge reports the state of the current UI, not every open tab.
