# Prompt 1 — Public Tape Reading Tool: generic external historical replay

You are an expert Go engineer working in the public repository `yencarnacion/tape-reading-tool`.

Implement a small, coherent, broadly useful set of generic historical-replay capabilities. This repository is public. Keep the implementation, tests, documentation, branch name, commit messages, comments, examples, fixtures, and identifiers entirely generic and suitable for public review. Do not include non-public product names, strategy labels, integration formats, or controller-specific explanations for why a symbol may be selected.

The public feature must be useful to any journal, scanner, review application, educational tool, or other local program that wants to cue Tape Reading Tool to a symbol and historical timestamp.

Create a feature branch from the current default branch, for example:

```text
feature/generic-external-historical-replay
```

Inspect the current repository before editing. Preserve all existing live, Massive-live, demo, ordinary replay, render, rewind, recording, chart, sound, and CLI behavior unless this prompt explicitly changes it. Reuse the current replay feed, store, WebSocket path, chart code, Massive client, SQLite code, and audio path rather than building a second tape engine.

## Current architectural facts to verify in the repository

Confirm these in the current code before implementation and adapt to the actual current state:

- Historical Massive trades and quotes can already be downloaded into SQLite.
- Replay already supports start, pause, resume, seek, and stop.
- Replay chart bars are currently derived from stored trade prints.
- The existing ticker endpoint activates a symbol, but changing the symbol during a running replay is not an atomic reconstruction of the new symbol at the current historical instant.
- Warmup or deterministic render preparation already contains reusable logic for applying events through an exact target timestamp.
- Interactive replay and render already have audio-related code that should be reused rather than duplicated.

## Primary goals

Implement all of the following as generic public capabilities:

1. A manually invoked Massive one-minute-bar downloader and persistent compact minute-bar cache.
2. Persistent, queryable historical download-coverage metadata for minute bars, trades, and quotes.
3. An authenticated, loopback-first, versioned external-replay control API.
4. An atomic `cue` operation that switches symbol and reconstructs chart and tape state at an exact historical timestamp.
5. External synchronization of play, pause, seek, target time, and speed.
6. A generic external-control badge/status in the public UI, with manual actions detaching control.
7. Historical replay audio at supported detailed speeds, with warmup and seeks always silent.
8. A high-speed fast-follow mode above a configurable detailed-replay threshold.
9. Deterministic tests and public documentation.

## Strict non-goals

Do not add:

- scanner logic;
- signal logic;
- candidate discovery;
- controller-specific manifest formats;
- automatic downloads at server startup, replay startup, API calls, ticker changes, or missing-data detection;
- process discovery, process launching, process stopping, shelling out to another program, or port scanning;
- permissive CORS;
- remote control enabled by default on non-loopback clients;
- a second market-data replay engine that bypasses the existing feed/store/WebSocket/browser architecture;
- any non-public product terminology.

## 1. Compact historical minute bars

The desired data model separates chart context from detailed tape data:

- Compact one-minute OHLCV bars provide full chart history and reference-level context.
- Detailed trades and quotes are stored only for the periods that require tape, time-and-sales, pressure calculations, and sound.

Add a persistent `minute_bars` table or equivalent generic storage. Store at least:

- symbol;
- provider;
- source, if useful to the existing storage conventions;
- minute start timestamp in microseconds;
- open, high, low, close;
- volume;
- dollar volume when available;
- download/update metadata sufficient for deterministic replacement.

Use a unique key that makes repeat downloads idempotent.

Add a manual CLI mode or subcommand with a clear generic name, such as:

```bash
./go.sh download-bars \
  -provider massive \
  -symbol AAPL \
  -start "2026-07-01 04:00:00" \
  -end "2026-07-02 12:00:00" \
  -db data/replay/2026-07-02.db
```

Requirements:

- It runs only when the user explicitly invokes it.
- It requires `MASSIVE_API_KEY` in the existing secure configuration path.
- It uses Massive one-minute stock aggregates and includes extended-hours timestamps in the requested range.
- Use settings consistent with raw historical trade prices; do not silently mix incompatible adjusted and unadjusted series.
- It retries transient failures using bounded behavior consistent with the existing Massive historical downloader.
- Re-running the same symbol/range replaces or upserts deterministically without duplicates.
- A failed or canceled request must not be marked fully covered.
- Existing `download` behavior for trades and quotes remains backward compatible.

## 2. Safe schema evolution

The current public database may contain valuable live recordings. Do not require users to delete a valid current database merely to add these generic tables.

Implement a safe, tested, additive migration from the current known schema version to the new schema version. Preserve all existing trades, quotes, UI events, and metadata. Continue rejecting unknown or unsupported future schema versions.

Add migration tests that create the previous schema, insert representative data, open it with the new code, and verify that the old data remains readable and the new tables work.

## 3. Historical coverage metadata

Add persistent coverage metadata that records completed manual downloads independently for:

- `minute_bars`;
- `trades`;
- `quotes`.

Coverage must record symbol, provider, requested start/end, successful completion, row count, and enough identity to distinguish the data kind. Only mark an interval complete after the corresponding operation succeeds.

Coverage checks must reason over the union of completed intervals rather than merely comparing the earliest and latest row timestamps. Natural periods with no prints must not be confused with a failed download when a successful request covered that period.

Expose a generic, read-only coverage API. A batch form is preferred so an external controller can check many requirements efficiently. An illustrative request is:

```json
{
  "protocol_version": 1,
  "requirements": [
    {
      "symbol": "AAPL",
      "provider": "massive",
      "kind": "minute_bars",
      "start_us": 1782907200000000,
      "end_us": 1783008000000000
    },
    {
      "symbol": "AAPL",
      "provider": "massive",
      "kind": "trades",
      "start_us": 1782994020000000,
      "end_us": 1783008000000000
    },
    {
      "symbol": "AAPL",
      "provider": "massive",
      "kind": "quotes",
      "start_us": 1782994020000000,
      "end_us": 1783008000000000
    }
  ]
}
```

Return complete, missing, and partially covered intervals in a machine-readable format. This endpoint must never trigger a download.

A generic CLI coverage-inspection command is desirable when it can be added cleanly, but the HTTP API and storage correctness are required.

## 4. Merge cached bars with exact replay trades without future leakage

Refactor the replay chart-bar path so it can use compact stored minute bars for broad context while preserving exact historical replay behavior.

Required merge rules:

- Use cached minute bars for completed minutes at or before the replay target.
- Never expose a completed aggregate for the currently forming minute when the target is inside that minute.
- Build the current partial minute from detailed eligible trade events through the exact target timestamp.
- When detailed trades exist for a completed minute, use one deterministic precedence rule and test it. Prefer exact trade-derived data when it is complete for that minute; otherwise use the cached aggregate without double counting.
- Never include bars after the target timestamp.
- Preserve VWAP, SMA, Bollinger, RVOL, volume-pane, and existing chart semantics.
- Ensure replay `-xtra` reference levels can use the previous trading session, current premarket, regular-session high/low through the target, and opening price from cached bars.

Add tests specifically proving that a target at `09:35:10` does not reveal the final `09:35` high, low, close, or volume.

## 5. Versioned external-replay API

Add a dedicated generic API rather than placing controller-specific semantics into `/api/ticker`. A reasonable shape is:

```text
GET  /api/external-replay/status
POST /api/external-replay/control
POST /api/historical/coverage/check
```

You may choose slightly different paths if they fit the current server cleanly, but document them and keep the contract stable and versioned.

The control request must support at least:

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

Support these generic actions:

### `cue`

Atomically:

1. validate mode, authentication, request, symbol, data ranges, and coverage;
2. reject or supersede stale work safely;
3. cancel the previous replay generation;
4. activate the requested symbol;
5. clear stale state from the previous symbol;
6. reconstruct chart and tape state from warmup through the exact target;
7. keep all warmup and seek reconstruction silent;
8. publish a complete browser snapshot/generation;
9. attach the external controller;
10. remain paused or begin replaying according to the request.

Do not implement `cue` as a race-prone sequence of the existing ticker/start/seek calls.

### `sync`

Allow the attached controller to send authoritative target, play/pause, and speed state. Small forward drift while playing may be corrected without a full rebuild; backward movement, a symbol change, a large discontinuity, or a generation mismatch must rebuild deterministically.

### `detach`

Release external control without corrupting the current display. Leave the public UI in a clear, manually controllable state. Pausing on detach is acceptable and preferable to an ambiguous autonomous continuation.

## 6. Ordering, idempotency, and controller ownership

Use `controller_session_id` plus a monotonically increasing `sequence`:

- Duplicate requests with the same accepted sequence must be idempotent.
- Lower sequences must be rejected as stale without changing state.
- Work from an older generation must never publish after a newer cue.
- Only one external controller session owns control at a time.
- A different controller must receive a clear conflict unless the previous controller is detached or an explicitly documented safe takeover rule applies.

Expose the accepted controller session, sequence, symbol, target, replay state, speed, generation, drift, and errors in status.

## 7. Security and configuration

Add a generic configuration section, for example:

```yaml
external_replay:
  enabled: false
  loopback_only: true
  default_warmup: 180s
  max_detailed_speed: 4
  sync_tolerance: 750ms
```

Use names that fit the current config conventions.

Requirements:

- External control is disabled unless explicitly enabled.
- It is loopback-only by default.
- Support an optional control token loaded from environment, never committed to YAML or source. A suitable environment name is `TAPE_EXTERNAL_REPLAY_TOKEN`.
- When a token is configured, require it through a dedicated request header such as `X-Tape-Control-Token` and compare safely.
- Do not add permissive cross-origin browser access. The intended control path is local server-to-server HTTP.
- Read-only health/status may be available on loopback without the token if that is operationally useful; mutating control must follow the configured policy.

## 8. Existing-instance and wrong-mode behavior

This feature controls an already running Tape Reading Tool server. It must not launch or discover a process.

- In replay mode with the feature enabled, control works.
- In live, Massive-live, demo, render, or another incompatible mode, return a precise conflict explaining the current mode and required replay mode.
- Do not silently convert a live instance into replay or alter a live subscription.
- `/api/external-replay/status` must expose mode and capability so a controller can distinguish offline, wrong-mode, disabled, unauthorized, and ready states.

## 9. Detailed replay, historical sound, and silent reconstruction

At or below the configured `max_detailed_speed`, externally controlled replay must reproduce the existing detailed experience:

- tick bars;
- rolling 5/15/60-second pressure and pace metrics;
- quotes;
- time-and-sales;
- one-minute chart and indicators;
- historical print/tape-rate audio using the existing audio engine and event timing.

Rules:

- Warmup, cue reconstruction, backward seek reconstruction, browser snapshot hydration, and drift correction rebuilds are always silent.
- Sound starts only for newly replayed post-target events after playback begins.
- Respect existing audio enable, mute, volume, and user-gesture requirements.
- Never produce a burst of warmup sounds after a cue.
- A browser that has not unlocked audio must be reported as audio-not-ready rather than falsely reported healthy.

Add a lightweight browser-to-server status/heartbeat only if needed to report whether at least one active UI has initialized and unlocked audio. Keep it generic and bounded.

## 10. Fast-follow above the detailed threshold

The default detailed threshold is 4× and must be configurable.

When externally commanded above the threshold:

- Enter a visibly labeled generic `FAST FOLLOW` state.
- Keep the historical clock and one-minute chart synchronized using compact bars and authoritative controller anchors.
- Do not pretend that detailed tape is current.
- Suppress detailed tape animation and historical audio.
- Clearly mark the tape/pressure/time-and-sales area as suppressed at high speed.
- On pause or a return to a supported speed, atomically reconstruct exact tape state at the authoritative current target before removing the suppression label or resuming audio.

Do not allow an overloaded detailed renderer to silently fall farther behind.

## 11. Public UI behavior

Show a compact generic status such as:

```text
EXTERNAL REPLAY · AAPL · 09:35:42 · FOLLOWING
```

Also represent:

- `CUEING`;
- `PAUSED`;
- `FAST FOLLOW`;
- `AUDIO LOCKED`;
- `DATA INCOMPLETE`;
- `DETACHED`;
- errors.

While attached:

- chart/tape display settings remain usable and do not detach;
- a manual ticker change, replay seek, play/pause, speed change, stop, or other transport action first detaches external control and then performs the requested manual action;
- provide a generic Detach control;
- do not name or assume the controlling application.

## 12. Performance and bounded resource use

A cue with already prepared data should target an interactive response within two seconds on a representative local fixture. Do not query or replay an entire day of detailed events merely to cue a three-minute warmup.

Use indexed, bounded queries and generation cancellation. Add diagnostics for cue duration, rows processed, generation, drift corrections, and coverage failures. Avoid unbounded goroutines, queues, or in-memory event slices.

## 13. Documentation

Create a public protocol and operations document, recommended path:

```text
docs/EXTERNAL_REPLAY_CONTROL.md
```

Document:

- purpose in generic terms;
- configuration and token setup;
- manual `download-bars` and existing detailed-download commands;
- database/coverage behavior;
- how to start replay with a chosen database and `-xtra`;
- API request/response schemas;
- sequence and ownership rules;
- audio unlock requirements;
- fast-follow behavior;
- manual detach semantics;
- error/status meanings;
- curl examples using generic stock-review terminology;
- security limitations.

Update the README with a concise link to this document. Do not add any non-public product references.

## 14. Testing and acceptance criteria

Add deterministic tests for at least:

### Storage and downloads

- previous-schema additive migration preserving existing rows;
- minute-bar upsert/replacement;
- coverage interval union and missing-range calculation;
- failed download not marked complete;
- no duplicates after repeated downloads;
- current-minute future-data prevention;
- cached-bar/detail-trade merge.

### Server and replay

- cue while in replay mode;
- cue rejected in live or other wrong mode;
- missing bars, trades, or quotes reported precisely;
- atomic AAPL-to-NVDA switch with no late AAPL publication;
- backward cue rebuild;
- duplicate and stale sequence behavior;
- competing controller behavior;
- token and loopback enforcement;
- warmup and seeks silent;
- detailed audio only after playback begins;
- fast-follow suppression and exact rebuild on slowdown/pause;
- status fields and error transitions.

### Browser

- generic external badge rendering;
- manual transport/ticker action detaches;
- visual settings do not detach;
- audio readiness reporting;
- tape area cannot look current while fast-follow suppression is active.

Run and pass all existing Go, browser, replay, render, rewind, storage, and deterministic scripts that are applicable. Do not weaken existing tests merely to make the new feature pass.

## 15. Delivery requirements

At completion, provide:

1. a concise architecture summary;
2. the exact public API contract;
3. all files changed and why;
4. schema migration behavior;
5. manual commands to download bars and ticks and start replay;
6. tests and checks run with results;
7. known limitations;
8. confirmation from a repository-wide case-insensitive search that no non-public product names, strategy labels, or integration-specific terminology were introduced.

Do not stop at a design document. Implement the feature completely on the feature branch.
