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

---

# Review pass: findings and fixes (branch `codex/plugin-panels`)

The documented checks were rerun against `plugin.md`, this handoff, `docs/PANEL_API_V1.md`, and `docs/ADR_RTH_EXTENSION.md`. Everything passed as handed over. Five defects were found by reading the code against the specification rather than by a failing check, and all five are fixed on this branch.

## 1. A browser clock ahead of the authoritative clock made the panel unusable in replay

`GET /api/panel-data/rth-context` rejected any `through_us` beyond the server clock with `400`, and the ADR panel turns a failed request into `ADR HISTORY UNAVAILABLE`.

The browser clock is `last server-stamped receipt + wall time since delivery`. In live mode that stays behind the server. In replay it cannot: `Replay.Status().PositionUS` only advances when an event is emitted, so the extrapolating browser clock overtakes it between events, and a backward seek publishes an empty same-symbol snapshot without resetting `state.serverClockUS` — the panel then asks for the pre-seek instant, which is far ahead of the new position. The panel reported unavailable and had no retry until the next snapshot.

`through_us` is now clamped down to the authoritative instant. Non-positive and unparseable values are still rejected. Clamping can only remove look-ahead, never grant it, which `TestPanelRTHContextClampDoesNotGrantLookAhead` asserts directly: a request naming a later instant is answered with the earlier position's low, not the later one.

## 2. A failed or insufficient history answer was cached for the life of the process

`panelDataCacheEntry.at` was written and never read, so every answer was cached forever. An IBKR pacing error, a provider outage, or history that had not been downloaded yet was pinned to its `(symbol, mode, source, provider, as-of, limit)` key until restart. Switching panels, changing symbol and back, or reloading the page could not recover.

Complete answers still cache for the process lifetime — a past session's completed bars never change. Non-ready answers are now held for `panelDataRetryAfter` (30s), which keeps a browser tab from re-requesting per mount without making an outage permanent. `TestPanelDailyBarsRetriesAfterUnavailableResponse` covers hold, retry, and the ready answer staying cached.

## 3. The ADR panel never noticed a session-date change

`load()` ran only on snapshot, mode change, and lookback change. The baseline is keyed to `beforeSessionDateET` and the seed to one `sessionDateET`, and `applyEligibleTrades` silently ignores trades from a different session date. An application left running overnight therefore kept the previous session's frozen low and last, and presented them as the current reading once the next 09:30 passed. A replay seek onto an earlier date had the same effect.

`render()` now reloads the baseline and the seed when the authoritative session date leaves the one currently loaded.

## 4. A paused replay clock could be advanced by a delivered batch

`render(nowUS)` froze the panel clock while replay was paused, but the `tradeBatch` handler adopted `event.clockUS` unconditionally. The two rules are now the same rule (`frozen()`), so nothing delivered advances a clock that is deliberately stopped.

Related: `app.js` emitted `modeChanged` on every status heartbeat rather than on an actual mode or replay-state transition. Panels were being told the mode changed several times a minute, each one forcing a full ADR re-render. It now fires on a real transition; the authoritative clock still reaches panels every animation frame.

## 5. The ADR readout used the palette reserved for RVOL magnitude

`plugin.md` forbids reusing a colour that conflicts with RVOL magnitude, and `styles.css` reserves `--rvol-quiet` … `--rvol-surge` (a violet ramp) for exactly that. The ADR value was `#d8b4ff` and its meter `#b784e8`, both inside that ramp — two different magnitude readouts in one viewport wearing the same colour.

ADR now has its own named, achromatic tokens (`--adr-ink`, `--adr-meter`, `--adr-meter-track`) with the reservation documented alongside the existing ones. Text and meter position carry the magnitude, which is what the specification asks for.

## Test-suite defect fixed at the same time

`scripts/browser-check.mjs` asserted `/^\d+\.\d{2} ADR$/` against the ADR value. Before 09:30 ET the correct panel state is `WAITING FOR RTH OPEN` and no number exists, so the documented verification command failed for any run in that window. The check now asserts what is actually invariant: the demo baseline is always `ADR20 4.90%` over `20 / 20` completed synthetic sessions, and in the ready state the displayed extension and raw percent must equal the documented formula applied to the panel's own displayed low and last. It also asserts the mounted state is one of the documented states, and waits for the panel to settle instead of a fixed delay. The assertion was mutation-tested: perturbing the expected baseline fails the check.

## Verification rerun after the fixes

| Command | Result |
| --- | --- |
| `go build -buildvcs=false ./cmd/tape-reading-tool` | pass |
| `go vet ./...` | pass |
| `gofmt -l .` | clean |
| `go test ./...` | pass |
| `go test -race ./...` | pass |
| `node scripts/adr-panel-check.mjs` | pass |
| `node scripts/audio-worklet-check.mjs` | pass |
| `node scripts/rewind-check.mjs` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo -rewind` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo` | pass |

Browser checks ran on macOS with `CHROME=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Note that the web assets are compiled into the binary through `//go:embed web/*`: restart the demo server after any change under `internal/server/web/` or the check will exercise the previous build.

## Not changed, and why

- **Live Rewind still mounts only Tape Pressure.** `plugin.md` permits this and both the handoff and `docs/ADR_RTH_EXTENSION.md` state it as a deliberate version-1 boundary.
- **`handlePanelDailyBars` holds its mutex across the provider request.** This matches the existing `handleRVOLHistory` and `handleDailyHistory` handlers, whose comment explains the intent: several tabs opening at the bell produce one provider request. Changing it here alone would make the panel path inconsistent with the rest of the server.
- **`aggregateRTHBars` seeds its accumulator from `bars[0]` without validating it first.** A session whose first minute bar is invalid is dropped rather than mis-aggregated, so the failure mode is a truthful missing session, not a wrong number. Worth tidying, not worth a behaviour change in a review pass.

## Suggested next review focus

Nothing on this branch exercises a real historical replay: there is no recorded database in the working tree, and the browser check simulates replay by injecting panel events rather than by driving the server's replay lifecycle. Findings 1, 3, and 4 all live in that gap. A recorded session replayed end to end — start, pause, backward seek, forward seek, reload while paused — is the highest-value check still missing.

---

## Independent verification after pulling `cef6614`

The branch was fast-forwarded from GitHub and independently reviewed and tested on 2026-08-18. The implementation fixes in `cef6614` are consistent with the panel contract and ADR specification. No additional runtime defect was found.

The complete documented suite passed: build, vet, formatting, Go unit and race tests, ADR model, audio, rewind, and browser checks in both normal demo and demo-with-rewind modes at 384, 634, 902, and 1372 pixels. The mounted checks covered hot swapping, persistence after reload, panel-local error recovery, stable slot geometry, and independent Live Rewind behavior.

One review-hygiene issue was corrected after testing: six feature files had an extra blank line at EOF, causing `git diff --check origin/main...HEAD` to fail. This cleanup makes that diff audit pass and does not change runtime behavior. The pre-existing local `go-render.sh` edit remains deliberately unstaged.

---

# Second review pass after `13d3dae`

`13d3dae` contains no runtime change — a trailing-newline cleanup and this document. The full documented suite was rerun against it and passed, including `git diff --check origin/main...HEAD`, which is now clean. The review effort therefore went into contract areas the first pass had only skimmed: settings ownership, the host object handed to a panel, and the Content Security Policy.

CSP is unchanged and strict (`script-src 'self'`); the panel modules are same-origin ES modules and the `innerHTML` template strings contain no script. Nothing to do there.

Two contract defects were found in settings ownership. Both are latent today because ADR is the only built-in panel with settings, and both become live the moment a second one exists.

## 6. Any panel could write the ADR panel's settings, and no panel could write its own

`plugin.md` scopes the capability to "read or save only that panel's settings", and `docs/PANEL_API_V1.md` calls settings panel-owned. The capability was hardcoded:

```js
savePanelSettings: (next) => {
  state.settings.panels.settings['adr-rth-extension'] = { lookbackSessions: clampInt(...) };
  saveSettings();
}
```

Whichever panel called it wrote ADR's key, and no future panel could persist anything of its own. The host now binds the mounted panel's id and its manifest's declared fields, and the application applies each panel's bounds. A panel cannot name another id, introduce an undeclared field, or widen its own limits.

## 7. Stored settings replaced manifest defaults instead of merging with them

`plugin.md` requires that new fields merge with defaults. Mount read `{ ...(stored[id] || manifest.defaultSettings) }`, so a stored object won outright: a field added in a later panel version arrived `undefined` for every user who had already saved settings. Now `{ ...manifest.defaultSettings, ...(stored[id] || {}) }`.

While in that constructor, the host object was also reordered. `...this.capabilities` was spread last, so an application capability named `signal`, `generation`, or `isCurrent` would silently replace the core-owned generation guards every panel depends on for stale-response rejection. Core fields are now written after the capabilities.

## New coverage

The ADR lookback is version 1's only panel-owned setting and nothing exercised it end to end. `scripts/browser-check.mjs` now drives it: changing 20 to 10 relabels the readout to `ADR10`, reloads exactly `10 / 10` completed sessions, keeps the same WebSocket, and persists under `adr-rth-extension` and no other key; an out-of-range 999 clamps to 60; and the default restores through the panel itself. The assertion was mutation-tested by binding the save capability to the wrong panel id — the check fails with the stray key visible.

Note when extending that block: the host persists the whole settings object on every swap, so editing `localStorage` directly is undone by the next mount. Drive the panel's own control instead.

Also corrected in the checks: the demo synthetic daily range cycles with period 5, so its mean `High / Low - 1` is 4.90% for any lookback that is a multiple of 5. An ADR10 and an ADR20 baseline are legitimately identical in demo mode; the comment now says so, to save the next reader the same wrong assumption.

## Verification rerun

| Command | Result |
| --- | --- |
| `git diff --check origin/main...HEAD` | clean |
| `go build -buildvcs=false ./cmd/tape-reading-tool` | pass |
| `go vet ./...` | pass |
| `gofmt -l .` | clean |
| `go test -count=1 ./...` | pass |
| `go test -count=1 -race ./...` | pass |
| `node scripts/adr-panel-check.mjs` | pass |
| `node scripts/audio-worklet-check.mjs` | pass |
| `node scripts/rewind-check.mjs` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo -rewind` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo` | pass |

## Still the highest-value gap

Unchanged from the first pass: no check drives a real historical replay. There is no recorded database in the working tree, and the browser check simulates replay by injecting panel events rather than by driving the server's replay lifecycle. A recorded session replayed end to end — start, pause, backward seek, forward seek, reload while paused — remains the most useful check nobody has written.

---

# Third review pass after `82ed183`

The settings-ownership changes in `82ed183` were pulled and reviewed. Default merging, panel-id binding, field filtering, application-owned bounds, and lifecycle-field precedence are correct, and their new mounted lookback coverage passes.

One related contract and security defect remained: `requestedCapabilities` was descriptive only. The host spread every application capability into every panel, so even Blank received the stream, snapshot, history, RTH-context, and settings functions. That contradicted the documented narrow capability model and would have made future plugin permissions misleading.

The host now builds a frozen grant from the manifest's requested capability vocabulary. Blank receives no application methods; Tape Pressure receives its stream and shared formatters; ADR receives clock/snapshot, formatter, bounded completed-history, RTH-context, and panel-owned settings methods. Unknown capability names are rejected during manifest validation, unrequested application methods are omitted, and core lifecycle fields remain unshadowable. `scripts/panel-host-check.mjs` deterministically covers capability isolation, unknown-capability rejection, generation-field precedence, settings ownership, and default merging.

The first mounted run usefully failed because ADR used the shared price formatter without declaring it. Formatting is now an explicit capability in the ADR manifest; both mounted browser modes then passed. The complete suite also passed: uncached Go tests, race tests, vet, build, formatting, ADR model, panel host, audio, rewind, normal demo browser, demo-with-rewind browser, and the feature diff whitespace audit.

The pre-existing local `go-render.sh` edit remains deliberately unstaged. The real recorded-replay lifecycle remains the highest-value untested gap.

---

# Third review pass after `682b908`

`682b908` turns `requestedCapabilities` into a real grant: the vocabulary is validated at registration, each entry maps to a small set of methods, and everything else — including application capabilities a panel never asked for — is omitted from the frozen host object. `scripts/panel-host-check.mjs` is a good addition; it runs the host headless and asserts the isolation directly. The full suite passes and `git diff --check origin/main...HEAD` is clean.

One defect in the new mechanism.

## 8. A panel could grant itself a capability it never declared

`validatePanelManifest` returned `Object.freeze({ ...manifest })`, and `Object.freeze` is shallow. `requestedCapabilities`, `supportedModes`, and `defaultSettings` stayed writable through the object the host hands to the factory:

```js
manifest.factory({ root: this.root, host, manifest, settings });
```

The host rereads those declarations on every mount, so a panel could do this at mount:

```js
manifest.requestedCapabilities.push('rth-session-context');
```

Grants are computed before the factory runs, so nothing changes for the current mount — but the next one collects the capability. Swapping away and back is enough, and because the selection persists, so is a reload. The same reference also reaches the settings path: widening `defaultSettings` widens the field set the application will persist for that panel, since the merge is bounded by the manifest's declared keys.

Confirmed by probe before the fix: pushing onto `requestedCapabilities` succeeded, `defaultSettings.smuggled = true` stuck, and the registry module's own exported object was mutated too, while only the top-level `id` was actually protected.

The three declarations are now copied and frozen at registration. Copying rather than freezing in place leaves each panel module's own exported object alone. `scripts/panel-host-check.mjs` asserts all three reject mutation and keep their declared values.

This does not make version 1 a hostile-code boundary and is not claimed to — a trusted module can still block the main thread, as `docs/PANEL_API_V1.md` already states. It closes the gap between what the capability mechanism claims to enforce and what it actually enforced.

## Considered and deliberately not changed

A manifest may request a capability the application has not wired; `grantedCapabilities` omits it silently and the panel fails with a `TypeError` at mount. Validating that at registration was tempting, but registration failures throw out of the `PanelHost` constructor and would take down application startup, whereas the current behaviour contains the failure to one panel's error card. Turning a contained, visible failure into a whole-application one is the wrong trade for a class of error that can only be a wiring mistake, and `scripts/panel-host-check.mjs` already constructs the host with the real capability names.

## Verification rerun

| Command | Result |
| --- | --- |
| `git diff --check origin/main...HEAD` | clean |
| `go build -buildvcs=false ./cmd/tape-reading-tool` | pass |
| `go vet ./...` | pass |
| `gofmt -l .` | clean |
| `go test -count=1 ./...` | pass |
| `go test -count=1 -race ./...` | pass |
| `node scripts/panel-host-check.mjs` | pass |
| `node scripts/adr-panel-check.mjs` | pass |
| `node scripts/audio-worklet-check.mjs` | pass |
| `node scripts/rewind-check.mjs` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo -rewind` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo` | pass |

## Still the highest-value gap

Unchanged through three passes: no check drives a real historical replay. There is no recorded database in the working tree, and the browser check simulates replay by injecting panel events rather than by driving the server's replay lifecycle. Findings 1, 3, and 4 from the first pass all lived in that gap, which is a reasonable argument for closing it before adding more surface.

---

# Fourth review pass after `9ddfaa9`

The declaration-freezing change in `9ddfaa9` was pulled and reviewed. Copying the manifest arrays and defaults before freezing correctly prevents a panel from changing its grant on a later mount without mutating the module's exported manifest.

One deeper form of the same defect remained. `defaultSettings` was copied and frozen only at its top level, and the settings object passed to a panel was also shallow-frozen. A future panel using nested settings could still mutate a nested default, mutate a nested value sourced from persisted application settings, or retain shared nested references despite the API's immutable-data guarantee.

Panel settings now pass through one recursive copy-and-freeze helper at registration and again after defaults and stored settings are merged for mount. The focused host check covers nested objects and arrays, verifies detachment from the source defaults, and verifies that nested mounted settings reject writes. This is deliberately scoped to JSON-like panel configuration; it does not claim to sandbox panel execution.

The complete documented suite passed after the fix: uncached Go tests, race tests, vet, build, formatting, panel-host and ADR checks, audio, rewind, normal demo browser, demo-with-rewind browser, and the feature diff whitespace audit. The pre-existing local `go-render.sh` edit remains deliberately unstaged.

The highest-value remaining test gap is unchanged: a real recorded replay driven end to end through start, pause, backward seek, forward seek, and reload while paused.
