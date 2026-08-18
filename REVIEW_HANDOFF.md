# Reviewer handoff: analytics panel platform and ADR extension

## Review target

- Branch: `codex/plugin-panels`
- Base: `main`
- Implementation commits: `e65060d` through `65a5608`
- Product/acceptance specification: `plugin.md`

This branch introduces a versioned, first-party analytics-panel host and converts the existing rolling-pressure rectangle into a stable, hot-swappable slot. Users can switch among Tape Pressure, ADR from RTH Low, and Blank without reloading the page or reconnecting market data. Live Rewind retains its own Tape Pressure instance.

## Architecture and behavior

- `panel-host.js` owns registration, lifecycle, generation boundaries, settings persistence, and panel-local error containment.
- Panels receive a narrow host API and render only inside their assigned root. Version 1 deliberately supports trusted built-in ES modules, not arbitrary third-party JavaScript.
- Tape Pressure was moved behind the same panel contract used by ADR and Blank.
- The Go server owns prior-session history and as-of RTH context. Panels do not access feeds, provider credentials, SQLite, or independent WebSockets.
- The ADR indicator uses the mean of `High / Low - 1` over exactly N completed prior RTH sessions, then reports `(Current / RunningRTHLow - 1) / ADR_N`.
- Replay queries use market time for RTH membership and receipt/event availability for the as-of boundary, preventing future or late-delivered prints from leaking backward.
- Massive live mode tracks whether the active subscription began before the RTH open. A post-open launch or symbol change reports incomplete RTH-low coverage instead of presenting a misleading value.

The contract and indicator semantics are documented in `docs/PANEL_API_V1.md` and `docs/ADR_RTH_EXTENSION.md`.

## Suggested review order

1. Compare `plugin.md` with `docs/PANEL_API_V1.md` and `docs/ADR_RTH_EXTENSION.md` for contract and calculation intent.
2. Review `internal/server/web/panel-host.js`, `panel-api.js`, and the three panel modules for lifecycle isolation and hot swapping.
3. Review `internal/server/panel_data.go` and `internal/storage/sqlite.go` for data completeness and no-look-ahead behavior.
4. Review the integration changes in `internal/server/web/app.js`, `index.html`, and `styles.css`, especially symbol/replay generation changes and Live Rewind independence.
5. Review `internal/server/panel_data_test.go`, `scripts/adr-panel-check.mjs`, and `scripts/browser-check.mjs` against the acceptance criteria.

## High-risk review areas

- Session boundaries around 09:30 and 16:00 America/New_York, including DST and early-close data.
- Provider-consistent history selection and refusal to calculate from incomplete, mixed, future, or current-session history.
- Replay seek and symbol-switch races: stale asynchronous results must not cross panel generations.
- Panel teardown: inactive panels must release listeners and retained state, and errors must remain local to the slot.
- Massive completeness transitions when subscription activation occurs before versus after the open.
- Responsive layout: picker chrome must not resize or displace the chart and time-and-sales panes.

## Validation performed

- Go unit tests, including deterministic ADR/history/session-context coverage.
- Go race tests and application build.
- JavaScript ADR model checks.
- Audio and rewind regression checks.
- Browser checks in normal demo and demo rewind modes at responsive widths.
- Browser coverage for hot swapping, persistence, local error recovery, and mounted replay behavior.

Please rerun the repository's documented checks in the review environment, especially the browser checks, because they exercise embedded assets and timing-sensitive panel lifecycle behavior.

## Intentional limitations

- Version 1 loads only trusted, built-in modules. It does not install archives, load remote code, provide a marketplace, or claim a hostile-code sandbox.
- A trusted panel exception is contained, but synchronous code that blocks the browser main thread cannot be contained by this architecture. Workers or sandboxed iframes are the future boundary for untrusted third-party plugins.
- Missing or unprovable history displays an explicit unavailable/incomplete state.
- Automatic time-window activation, alerts, backtests, and order entry are outside this change.

## Working-tree note

The local `go-render.sh` symbol/date/time edit predates this handoff and is intentionally excluded from the branch commits.
