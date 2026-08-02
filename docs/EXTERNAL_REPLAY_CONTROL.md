# External Historical Replay Control

Tape Reading Tool can be cued by a local journal, review program, scanner, or educational tool to an exact symbol and historical time. Control uses the existing SQLite event store, replay feed, WebSocket stream, chart, and audio implementation. It controls an already running server: it never launches, discovers, or stops a process, and never scans ports.

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

Optionally set `TAPE_EXTERNAL_REPLAY_TOKEN` in `.env`. It is read only from the environment; a `token:` key in YAML is ignored. When configured, every control request must include `X-Tape-Control-Token`, compared in constant time. The endpoints do not enable CORS, and the intended control path is local server-to-server HTTP rather than a browser. Loopback restriction is on by default; do not disable it on an untrusted network.

Read-only status and coverage remain available on loopback without a token so a controller can tell "not ready" from "not authorised". Mutating control always follows the configured policy.

## Preparing data manually

Nothing downloads by itself. Downloads happen only when you run one of these commands; server startup, replay startup, API calls, ticker changes, and missing-data detection never trigger one.

Bars are unadjusted one-minute Massive aggregates so their prices agree with raw historical prints, and they always include extended hours.

```bash
./go.sh download-bars -provider massive -symbol AAPL \
  -start "2026-07-01 04:00:00" -end "2026-07-02 12:00:00" \
  -db data/replay/2026-07-02.db

./go.sh download -provider massive -symbol AAPL \
  -start "2026-07-02 09:30:00" -end "2026-07-02 16:00:00" \
  -db data/replay/2026-07-02.db

./go.sh coverage -symbol AAPL -provider massive -db data/replay/2026-07-02.db

./go.sh replay -provider massive -source historical -symbol AAPL \
  -db data/replay/2026-07-02.db -xtra
```

`coverage` is read-only inspection of completed downloads and never contacts a provider.

Repeated bar downloads upsert the `(symbol, provider, source, minute)` key, so re-running a range replaces it without duplicating rows. A bar range too large for one provider response is rejected rather than silently truncated, so a short answer can never be recorded as a complete download.

Detailed downloads replace their range: the existing coverage claim over that window is withdrawn *before* the rows are deleted, so a replacement that then fails leaves coverage describing only the data that is still durable. Completed coverage on either side of the replaced window survives with a recount. Coverage is recorded for both providers, and only after that data kind's request has succeeded — a failed or cancelled download leaves no coverage behind. An interval with zero rows is still valid coverage: a quiet premarket is not a missing download. Coverage checks merge adjacent and overlapping successful intervals rather than inferring coverage from the first and last row. A `-rth` download records only the 09:30–16:00 Eastern parts of the requested span, because that is all it retained.

### Database schema

The schema version is 4. A version 3 database is migrated additively in place: existing trades, quotes, UI events, and metadata are preserved, and the new `minute_bars` and `download_coverage` tables are added alongside them. Any other version is rejected without the database being deleted or rewritten.

## Protocol version 1

All request bodies use `Content-Type: application/json` and `protocol_version: 1`. Unknown fields are rejected.

### Status

`GET /api/external-replay/status`

```json
{
  "protocol_version": 1,
  "enabled": true,
  "mode": "replay",
  "capable": true,
  "capability": "ready",
  "loopback_only": true,
  "token_required": true,
  "max_detailed_speed": 4,
  "sync_tolerance": "750ms",
  "ui_audio_ready": false,
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
    "state": "paused",
    "drift_us": 0,
    "drift_corrections": 0,
    "cues": 4,
    "last_cue_ms": 7,
    "last_cue_rows": 1082
  },
  "replay": {}
}
```

`capability` distinguishes the states a controller has to tell apart:

| capability | meaning |
|---|---|
| `ready` | replay mode, control enabled |
| `disabled` | `external_replay.enabled` is false; control returns `404` |
| `wrong_mode` | live, Massive-live, demo, or render; control returns `409` naming the current mode |

An unreachable server is the fourth state and is observed as a connection failure. A non-loopback client receives `403` and a bad configured token `401`.

`control.state` is one of `cueing`, `paused`, `following`, `fast_follow`, `data_incomplete`, `error`, or `detached`. `playing` reports what the replay is actually doing, so it is false in fast follow. `drift_us` is the last measured controller-to-replay offset and `drift_corrections` counts how often that was absorbed without a rebuild. `last_cue_ms` and `last_cue_rows` are the cue diagnostics.

`ui_audio_ready` reflects a bounded heartbeat from the browser (`POST /api/external-replay/ui`, loopback-only, newest report only). A tab that has not unlocked Web Audio, has muted sound, or has stopped reporting reads as not ready rather than being assumed healthy.

### Coverage

`POST /api/historical/coverage/check` accepts 1 to 256 requirements:

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

`POST /api/external-replay/control` supports `cue`, `sync`, and `detach`.

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
  "speed": 1.0
}
```

`warmup_start_us` defaults to `target_us` minus `default_warmup`. `source` must be `historical` and `provider` must be a specific provider.

**`cue`** validates mode, authentication, request, symbol, ranges, and coverage for all three data kinds; rejects or supersedes stale work; cancels the previous replay generation; reconstructs chart and tape state from warmup through the exact target; and publishes it as one complete browser generation before attaching the controller and either staying paused or beginning playback. Reconstruction happens on a detached tape, so the previous symbol stays on screen until the new one is complete and no part of the warmup is ever delivered as incremental prints. Coverage is checked before anything changes, so an incomplete request leaves the display exactly as it was.

**`sync`** carries authoritative target, play/pause, and speed. Forward drift within `sync_tolerance`, on the same symbol, the same generation, and the same speed, at a detailed speed, is corrected in place without a rebuild and increments `drift_corrections`. Backward movement, a symbol change, a jump beyond tolerance, a generation mismatch, a speed change, or a change between detailed and fast-follow mode rebuilds deterministically — a speed change rebuilds rather than advertising a speed that playback never adopted. In fast follow, a forward sync advances the historical clock and the compact-bar chart without replaying detailed prints.

**`detach`** releases ownership and pauses, leaving the display intact and manually controllable rather than continuing autonomously. A detach that owns nothing is a no-op: it never pauses a session the caller did not control, so it is safe to send after a manual action has already released the controller.

```bash
curl -sS http://127.0.0.1:8097/api/external-replay/control \
  -H 'Content-Type: application/json' \
  -H "X-Tape-Control-Token: $TAPE_EXTERNAL_REPLAY_TOKEN" \
  --data-binary @cue.json
```

### Ordering and ownership

`controller_session_id` plus a monotonically increasing non-zero `sequence` decides ordering:

- a duplicate of the accepted sequence returns the current status without repeating the work;
- a lower sequence returns `409` and changes nothing;
- a different session returns `409` while another controller is attached, and may take over once that controller detaches or a manual action releases it;
- work from a cancelled generation can never publish after a newer cue.

One control operation runs at a time, so ownership, ordering, and the reconstruction they authorise are decided together.

## Chart, sound, and fast follow

Completed cached minutes provide broad chart context, including a premarket or a previous session that has no detailed prints. Detailed trades replace a completed minute only when trade coverage proves the entire minute is present; otherwise the cached aggregate stands alone, so the two are never added together. The forming minute is always rebuilt from eligible trades through the exact target, so its future high, low, close, and volume cannot leak. With `-xtra`, the previous session, current premarket, regular-session extremes through the target, and the opening price are all available from cached bars.

At speeds through `max_detailed_speed`, playback uses the normal detailed path: tick bars, rolling 5/15/60-second pressure and pace, quotes, time and sales, the one-minute chart and indicators, and historical print and tape-rate audio. Cue reconstruction, backward seeks, snapshot hydration, and drift-correction rebuilds are always silent; sound can begin only with newly replayed post-target events after playback starts. Existing audio enable, mute, volume, and user-gesture requirements still apply, and the badge shows `AUDIO LOCKED` until the browser has unlocked Web Audio.

Above the threshold the session enters `FAST FOLLOW`: detailed playback and historical audio stay suppressed, the tape area is visibly marked as suppressed, and the authoritative clock and one-minute chart follow the controller's sync anchors. Returning to a supported speed, or pausing, performs another exact silent reconstruction at the authoritative target before the suppression label is removed.

## Public UI

While a controller is attached the toolbar shows a compact badge:

```text
EXTERNAL REPLAY · AAPL · 09:35:42 · FOLLOWING
```

with `CUEING`, `PAUSED`, `FAST FOLLOW`, `AUDIO LOCKED`, `DATA INCOMPLETE`, `ERROR · …`, and `DETACHED` as the other states. A cue that is refused before any controller attaches still reports `DATA INCOMPLETE` or the error, so a rejected cue never looks like nothing happened. The controlling application is never named or assumed.

Chart and tape display settings stay usable and do not detach. A manual ticker change, replay seek, play, pause, speed change, or stop detaches external control first and then performs the manual action. The badge itself is the generic detach control.

Manual ticker and transport operations are ordered against whole external control operations. If a cue is already reconstructing, the manual action completes after that cue and remains authoritative; an older cue cannot publish later and retake control. Cue reconstruction streams its database cursor into a detached tape whose memory is bounded by the configured tape ring, then atomically publishes that completed stage.

## Errors

| status | meaning |
|---|---|
| `400` | malformed request, unknown field, or an invalid symbol, range, warmup, or speed |
| `401` | a token is configured and the request did not present it |
| `403` | the client is not on loopback and `loopback_only` is set |
| `404` | external control is disabled |
| `409` | wrong mode, stale sequence, competing controller, or incomplete historical data |
| `503` | no historical database is attached |

A `409` for incomplete data returns the exact missing intervals per data kind and sets the badge to `DATA INCOMPLETE`.

## Limitations

- Control is local HTTP, not a durable distributed coordination protocol.
- Fast follow advances when the controller sends authoritative sync anchors; it does not extrapolate indefinitely after controller loss.
- Massive aggregate requests are bounded to the provider's 50,000-base-aggregate response limit. A range that exceeds one response is rejected with an explicit error rather than truncated; split it into smaller explicit downloads.
- Audio readiness is browser-local and reports the most recent tab that reported, not every open tab.
- `scripts/browser-check.mjs` measures Live Rewind's paint budget against a steadily fed live tape. Run it against an ordinary replay; the ratio it asserts is not meaningful while an external cue has pre-loaded a large warmup into the same session.
