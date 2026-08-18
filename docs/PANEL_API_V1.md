# Panel API v1

## Terminology and scope

A **panel slot** is a fixed rectangle owned by the core layout. A **panel** is the visual feature mounted in that slot. An **indicator** is a calculation independent of presentation. A **plugin** is a packaged calculation plus panel. The **panel host** registers, mounts, updates, isolates, unmounts, and swaps panels.

Version 1 ships trusted, first-party ES modules only. It establishes `PANEL_API_VERSION = 1` and `PANEL_DATA_SCHEMA_VERSION = 1`; it does not load arbitrary files, remote scripts, archives, or third-party packages. Exception containment is provided, but a trusted module that blocks the JavaScript main thread remains capable of freezing the page. Workers and sandboxed iframes are the intended future hostile-code boundary.

## Manifest

Every registry entry declares:

- `id`, a stable persistence key
- `name`, `version`, and `description`
- `panelApiVersion` and `dataSchemaVersion`
- `supportedModes`
- `requestedCapabilities`
- `defaultSettings`
- `minimumWidth`
- `factory`

An incompatible definition is rejected before mounting. Built-in IDs are `tape-pressure`, `adr-rth-extension`, and `blank`.

## Lifecycle and ordering

The host owns one generation at a time. A swap increments the generation, stops delivery, aborts host-managed work, calls `unmount`, removes panel-local DOM, shows a loading state, creates the next panel, sends its current snapshot, and persists the stable ID. Inactive panels are destroyed rather than hidden.

The factory receives only its assigned root, immutable manifest/settings data, and narrow host capabilities. A panel may implement `onEvent`, `render`, and `unmount`. The current events are:

- `snapshot`: symbol/mode/generation boundary plus authoritative state
- `tradeBatch`: one delivered browser batch, never one callback per print
- `modeChanged`: feed or replay status and authoritative clock

Snapshot and symbol/replay generation boundaries invalidate previous asynchronous results. A panel must check its host generation after awaited work. No event is intentionally delivered after unmount. Render work is coalesced through the application animation loop.

`unmount` must release listeners, timers, animation frames, abort controllers, workers, and retained data. Version-1 panels create no independent WebSocket, feed connection, provider client, or database connection.

## Host capabilities

Capabilities expose read-only current symbol/mode/status/clock/quote/trades, the shared stream source, shared formatters, bounded completed daily RTH bars, an as-of RTH session context, and panel-owned settings. Panel data requests are fulfilled by same-origin core endpoints; panels do not receive provider credentials or arbitrary network access.

Daily history is bounded to 1–90 sessions. ADR settings are bounded to 5–60. Responses are schema-versioned and include symbol, as-of session, source/provider, adjustment, status, and completeness metadata.

## Settings and errors

The existing versioned local settings object owns:

```text
panels.slots.primaryAnalytics.activePanelId
panels.settings.<panel-id>
```

Unknown IDs fall back to Tape Pressure. Reset restores Tape Pressure and ADR20.

Every lifecycle callback is wrapped. An exception replaces only the assigned root with a local error card and leaves the chart, tape, audio, feed, recording, replay, and WebSocket running. Details are restricted to the thrown message and browser console. The picker remains outside the panel root and can replace a failed panel.

## Performance and security expectations

Panels process delivered batches, not feed callbacks. They must not perform per-trade history requests, full-session rescans, unbounded retention, or hidden inactive work. Core history calls are cached and bounded: a complete answer for a past as-of session is cached for the process lifetime, while an unavailable or insufficient answer is held only briefly, so a provider outage or a history download that has not run yet cannot strand a panel until restart. `modeChanged` reports an actual mode or replay-state transition, not every status heartbeat; the authoritative clock reaches panels through the animation frame. Content Security Policy remains unchanged: no inline script, `eval`, `new Function`, remote script, credential access, order entry, or direct DOM access outside the assigned root is added.

The next architecture step should be another first-party indicator exercising this contract. Only after the API has remained stable should installation packages, permissions UI, workers, signatures, and sandboxed iframe execution be added.
