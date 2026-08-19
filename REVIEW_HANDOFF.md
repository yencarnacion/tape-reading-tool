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

---

# Fourth review pass after `a345d86`

`a345d86` extends the registration freeze recursively through `defaultSettings` and the merged settings handed to a panel, and adds nested fixtures to `scripts/panel-host-check.mjs`. The recursion is the right call — a one-level freeze protected the container and left its contents writable. The full suite passes on the pulled state and `git diff --check origin/main...HEAD` is clean.

Two findings, both created by the same thing this commit did well: it made nested settings a supported shape without the rest of the settings path following it down.

## 9. A nested field added in a later panel version never reached the panel

Finding 7 fixed this at the top level. The merge underneath is still one level deep:

```js
{ ...manifest.defaultSettings, ...(this.settings.settings?.[id] || {}) }
```

With defaults `{ display: { precision: 2, scale: 'linear' } }` and stored `{ display: { precision: 3 } }`, the whole `display` object is replaced and `scale` arrives `undefined` for every user who had already saved. `plugin.md` requires new fields to merge with defaults, and the commit's own fixtures could not catch it because the nested default had only one key.

The same gap ran the other way on save. The bound added in finding 6 iterated `Object.keys(defaults)` at the top level only, so a nested key the manifest never declared was persisted verbatim — and then merged straight back into the panel at the next mount.

Both directions now use one operation, `mergePanelSettings(defaults, overrides)` in `panel-api.js`: the manifest's defaults are the schema, nested objects merge at every depth, arrays and scalars replace wholesale because a stored list is a value rather than a base to extend, and an override of the wrong shape falls back to the declared value instead of corrupting the panel. The host uses it at mount and the application uses it on save, so the two directions cannot drift apart again.

## 10. The panel host check could not fail

This one matters more than the merge, because it is what let the merge through.

Every strong assertion in `scripts/panel-host-check.mjs` lived inside a panel factory, and the host wraps every lifecycle callback in its error boundary by design. An assertion thrown there was caught, logged as `panel <id> stopped`, and the script carried on to print its success line and exit 0.

The check appeared to work only because the DOM stubs were too thin for the error path itself to complete: `fail()` calls `document.createElement('details').append(...)`, the stub had no `append`, and the resulting `TypeError` crashed the process. The check was being saved by an incidental crash in the error handler. Reproduced in isolation — a factory asserting `1 === 2` against complete stubs exits 0 with the slot quietly in `panel-error`.

The factories now record the host and settings they were handed, and every assertion runs from the script body after the swaps. Each swap additionally asserts the panel actually mounted and the slot is not in an error state, so a swallowed exception fails the check rather than hiding in it.

Verified by mutation, all three now exit non-zero by design rather than by accident:

| Mutation | Detected |
| --- | --- |
| shallow settings merge restored | yes |
| all application capabilities spread into the host | yes |
| one panel throws during mount | yes |

Before the restructure, only the first was caught, and only because of the stub crash.

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

## A note on where the last four passes have gone

Findings 6 through 10 are all in panel settings and capability plumbing: a contract with one flat integer setting on one panel has now been reviewed four times. The generalisations are sound, but nothing above changes what a trader sees, and each round has added surface that the next round then had to audit.

Meanwhile the gap named at the end of every previous pass has not moved: no check drives a real historical replay. There is no recorded database in the working tree, and `scripts/browser-check.mjs` simulates replay by injecting panel events rather than by driving the server's replay lifecycle. Findings 1, 3, and 4 — the ones that made the ADR panel unusable after a backward seek, showed a stale session overnight, and let a paused clock advance — all lived in that gap, and were found by reading rather than by any check. Finding 10 says something similar about trusting a check that has never been shown to fail.

Recording a short session and replaying it end to end — start, pause, backward seek, forward seek, reload while paused — would exercise more of this branch's actual risk than further hardening of the settings path.

---

# Fifth review pass after `8a8a1de`

The deep settings merge and repaired host test harness in `8a8a1de` were pulled and reviewed. Using manifest defaults as the schema in both mount and save directions is the right design, and moving assertions outside the host's error boundary makes `scripts/panel-host-check.mjs` a meaningful test rather than one that can report success after a contained factory failure.

One contract mismatch remained. The merge documented that an override of the wrong shape falls back to its declared default, but this was enforced only for nested objects. An array default still accepted a string or object, and scalar defaults accepted objects or different primitive types. A future plugin could therefore persist structurally corrupt settings even though undeclared keys were filtered correctly.

`mergePanelSettings` now enforces the manifest shape throughout: nested objects recurse, arrays accept only arrays and replace wholesale, scalar overrides must keep the declared primitive type, and null accepts only null. Focused regressions cover wrong-shaped objects and arrays plus number, boolean, string, and null defaults. ADR's application-owned 5–60 bound remains a separate semantic constraint after structural shaping.

The full suite passed after the fix: uncached Go tests, race tests, vet, build, formatting, panel-host and ADR checks, audio, rewind, normal demo browser, demo-with-rewind browser, and the feature diff whitespace audit. The pre-existing local `go-render.sh` edit remains deliberately unstaged.

The recommended next investment remains an end-to-end recorded replay test rather than another expansion of generic settings infrastructure.

---

# Fifth review pass after `712caa2`

`712caa2` tightens `mergePanelSettings` with type and shape preservation: an array default only accepts an array, a scalar override must keep the declared primitive type, and a `null` default stays null. I reviewed the branch ordering — `typeof null === 'object'`, but `fallback &&` is falsy for null so the null case correctly falls through to its own branch — and the recursion on a scalar override, where indexing a string or number yields `undefined` and the whole declared object is returned. It is correct, and the fixtures cover it. No defect found in this commit.

The suite passed on the pulled state before any change below.

## No sixth settings finding

Findings 6 through 10 were all in the settings and capability path. A contract with one flat integer setting on one panel does not need a sixth pass, and looking for one would have produced a nit rather than a risk. The effort went to the gap named at the end of every previous handoff instead.

## The replay gap is now closed on the server side

Every no-look-ahead guarantee on this branch had been verified by reading the code, or by a browser check that simulates replay by injecting panel events. Nothing drove a real `*feed.Replay`. That is precisely where findings 1, 3, and 4 lived, and all three were found by reading rather than by a check.

`internal/server/panel_replay_test.go` now drives the real feed. It seeds a temporary database with two completed prior sessions, the replay session, and — importantly — a completed, fully downloaded session that falls *after* the replay session but before any plausible wall clock. It then uses `PrepareRender` and `StepRender` to place the replay position at exact instants, which removes wall-clock pacing from the assertions, and calls the panel data handlers at those positions.

Three properties, each previously unverified end to end:

- **A later low stays invisible.** The session low forms at 09:45. At position 09:36 the context reports the 09:35 low, reports the position as its as-of instant, and a request naming 15:59 — the shape a browser produces when its clock outruns the position, or when a backward seek leaves it stale — clamps instead of revealing the low. Stepping to 09:46 then reveals it.
- **History follows the replay date, not the machine's.** Asking with the replay session date returns the two prior sessions with their aggregated ranges. Asking with a wall-clock date clamps the as-of session, and the seeded later session never enters the baseline.
- **The same position answers the same way twice.** Deterministic render depends on it.

Verified by mutation — each of these fails the new tests:

| Mutation | Detected by |
| --- | --- |
| `through_us` clamp removed | later low leaks at 09:36 |
| daily as-of taken from `s.now()` instead of the replay position | seeded later session enters the baseline |
| session stats read the whole session instead of through the position | later low leaks at 09:36 |

## What is still not covered

This closes the server half. The browser half — that the ADR panel recovers correctly across a real pause, backward seek, forward seek, and a reload while paused — still has no check, because that needs a recorded database and a browser driven against it. It is a smaller gap than before: the guarantees the panel depends on are now enforced and tested at the boundary it reads from, so a browser-side failure would be a panel bug rather than a silent wrong number. Recording a short demo session to SQLite and replaying it under `scripts/browser-check.mjs` is the natural next step.

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

---

# Sixth review pass after `c6e2148`

The real replay endpoint tests in `c6e2148` were pulled and reviewed. They genuinely cross temporary SQLite storage, `feed.Replay` render stepping, the server's authoritative replay clock, and the panel HTTP handlers. The seeded future session and later intraday low make the no-look-ahead assertions meaningful, and the focused tests pass before and after the change below.

One adjacent cross-session defect remained in the RTH-context handler. Daily history already clamps a stale browser date to the replay session, but RTH context accepted its `session` query verbatim. After a cross-day backward seek, the browser can briefly carry both a later session date and later clock; the endpoint would then answer `BEFORE OPEN` or return mismatched-session context instead of data for the authoritative replay position.

In real replay and deterministic render modes, RTH context now always uses the New York session derived from the server-owned replay clock while still validating the query format. The replay fixture adds a request carrying a stale next-day session and time at the July 22 09:36 position and asserts in both modes that the response is July 22, clamped to 09:36, ready, and contains only the low known by then.

The first broad implementation clamped every mode and correctly failed the mounted browser suite: demo intentionally accepts an injected historical session so it can simulate replay presentation without a recorded database. The fix was narrowed to real server replay mode. Both normal and rewind demo browser suites then passed, while the real replay regression continued to pass. This distinction is documented in `docs/ADR_RTH_EXTENSION.md`.

The complete suite passed on the final code: uncached Go tests, race tests, vet, build, formatting, panel-host and ADR checks, audio, rewind, both browser modes, and the feature diff audit. The unrelated local `go-render.sh` edit remains deliberately unstaged.

The remaining replay gap is now specifically browser-to-real-replay lifecycle coverage, not the server data boundary.

---

# Sixth review pass after `66453c4`

`66453c4` makes the core authoritative for the session in replay and deterministic render modes: the requested `session` is ignored there, so a stale browser date after a cross-session backward seek cannot select another day's data. Demo keeps honouring a requested historical session so the browser checks can exercise replay presentation without a recorded database. That split is right, and the added test covers both modes.

The change is correct on its own terms. It also surfaced the thing underneath it.

## 11. The browser threw away the authoritative clock it was already being sent

Findings 1 and this commit both fix symptoms of one cause. Finding 1 clamped a `through_us` that had outrun the replay position; `66453c4` overrides a `session` that had done the same. Both exist because the browser keeps extrapolating a clock a seek has already invalidated.

`streamTimeMS()` has always stamped every snapshot with the authoritative instant — the replay position in replay and render modes, the wall clock otherwise. The browser adopted it on the first snapshot and on status messages, but not on later snapshots. That is exactly backwards: a snapshot *is* the generation boundary, the one moment an extrapolated clock is guaranteed wrong.

A replay seek makes it concrete. The seek publishes an empty same-symbol snapshot, `deferReplayReset` keeps the previous trades so the last complete frame stays on screen, and `observeReceiptClock` is skipped along with them. So the clock still reads the instant the seek just left, and that is the clock handed to the panels a few lines later.

With `66453c4` in place, the consequence changed shape rather than going away. Before it, a cross-session seek asked for the wrong session and got an answer for it. Now the core correctly answers for its own session, the panel's `seedRTHContext` sees a `sessionDateET` it did not ask for, treats it as stale — which is right, its whole state is keyed to that date — and shows `ADR HISTORY UNAVAILABLE`. Correct core, correct panel, and a wrong result between them, until the first batch from the new position arrives and the session-change reload from finding 3 recovers it.

The browser now adopts `server_time_ms` on every snapshot. The clamp and the session override both stay: they are the right behaviour for a core that owns the clock, and they are now defence in depth rather than load-bearing.

## What is tested, and what is not

Two contracts the fix rests on are now pinned:

- `TestReplaySnapshotCarriesTheAuthoritativePosition` asserts the wire actually carries the replay position rather than the wall clock, at two stepped positions. Mutation tested: replacing `streamTimeMS` with `time.Now()` fails it.
- `scripts/adr-panel-check.mjs` asserts a seed for a different session is stale rather than usable, so the panel's half of the agreement cannot quietly become tolerant.

The browser half — that the app adopts the stamped clock across a real cross-session seek — is verified by reading, not by a check. Driving it needs a recorded database and a browser, which is the same gap named in every previous pass. This is worth being blunt about: findings 1, 3, 4, and now 11 all live in the replay path, all were found by reading, and none of them would have been caught by any check on this branch. The server half of that path now has real coverage. The browser half does not.

Recording a short demo session to SQLite and replaying it under `scripts/browser-check.mjs` — start, pause, backward seek across a session boundary, forward seek, reload while paused — would close it, and would have caught four of the eleven findings on its own.

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

---

# Seventh review pass after `77015d8`

`77015d8` was pulled and reviewed. Adopting `server_time_ms` on every snapshot is the correct generation-boundary fix: the server stamps replay snapshots from `feed.Replay.Position()`, and `syncServerClock` already rejects invalid values. The existing replay wire test and ADR stale-session check cover the two sides of that contract.

This pass also exercised the previously untested browser-to-real-replay path with the local August 18 SMCI recording. The database contains 11,639 chart-eligible IBKR/live prints from 09:31 through 09:40 ET, including dense data around 09:33. A replay was paused near 09:33:31, the Analytics slot was changed to `ADR FROM RTH LOW`, and the replay was sought backward to 09:33:00. The visible clock moved backward immediately, the ADR panel remained mounted, no browser errors were logged, and a reload while paused restored `REPLAY TIME 09:33:00 ET` rather than extrapolating from the abandoned position.

The ADR value itself could not be numerically validated from this recording. The database has no SMCI daily bars and its live trades start at 09:31 rather than the 09:30 RTH open. The truthful result at 09:33 is therefore `INSUFFICIENT ADR HISTORY` (`0 / 20 COMPLETED SESSIONS`) with incomplete RTH-open coverage, not a fabricated extension value. This is a data-coverage limitation, not a panel failure.

No code issue was found. The only change in this pass is this reviewer handoff. The unrelated local `go-render.sh` edit remains deliberately unstaged.

## Verification rerun

| Command or scenario | Result |
| --- | --- |
| Real SMCI IBKR/live replay, backward seek 09:33:31 → 09:33:00, paused reload | pass; clock restored to 09:33:00, panel retained, no browser errors |
| SMCI ADR data-integrity state | expected insufficient history: 0/20 daily sessions and incomplete 09:30 coverage |
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

---

# Eighth review pass after `c01045b`

`c01045b` contains no code. It records a manual validation against a local SMCI recording. That recording is not in the repository — correctly, it is market data — so nothing in it could be reproduced here, and its result is not restated below as verified. One detail in it is slightly off: snapshots are stamped from `replay.Status().PositionUS` in `streamTimeMS`, not from `feed.Replay.Position()`, which is a different method. Its conclusion is sound: an SMCI recording with no daily bars and prints starting at 09:31 must produce `INSUFFICIENT ADR HISTORY` and incomplete open coverage, and getting that instead of a number is the panel working.

## Correction: finding 11 was a misdiagnosis

Last pass I reported that the browser threw away the authoritative clock the server stamps on every snapshot, and added a `syncServerClock` call late in the snapshot handler to fix it. That was wrong. `handleMessage` already calls `syncServerClock(message.server_time_ms)` as the first statement inside the snapshot branch, unconditionally, before anything else in the message is applied. I read it as sitting inside the first-snapshot initialisation block; it is not.

So the scenario I described — a backward seek leaving the browser asking the core for the instant it had just left — does not happen. The line I added was redundant, and its comment asserted a bug that does not exist, which is worse than no comment. It has been reverted.

This also softens part of finding 1. The clamp is still right and still necessary: between snapshots the browser clock advances at wall-clock rate while the replay position advances only when an event is emitted, so a request can name an instant marginally past the position and would previously have been refused with a `400` that the panel renders as `ADR HISTORY UNAVAILABLE`. That is a real intermittent failure. But my account of it as *guaranteed* after every backward seek, and persisting until the next snapshot, overstated it. The drift is milliseconds, not minutes.

`TestReplaySnapshotCarriesTheAuthoritativePosition` stays. It pins the contract the existing sync depends on, and mutation testing shows it fails if `streamTimeMS` returns the wall clock.

## The browser half of the replay path now has a check

Named as the outstanding gap in every pass since the first. The obstacle was always that it needs a recording, and market data cannot be committed. It can be generated instead.

`scripts/replay-fixture` writes a deterministic recording: twenty completed prior sessions each spanning exactly 5% high to low, so `ADR20` is 5.00%; a replay session whose filler prints hold the last price at 102.90 so the reading is identical at every position between the running low and the later one; a running regular-session low of 98.00 at 09:32; and a lower low of 95.00 at 09:45. The steady reading is therefore `1.00 ADR` at `+5.00%`, and it is the same at any position in a thirteen-minute window, so the check never has to land the replay on an exact instant.

`scripts/replay-panel-check.mjs` builds that recording, starts the application in replay mode against it, and drives the real replay lifecycle in Chrome. It needs no running server and no data of its own:

- **The running low comes from the core, not the browser tape.** The seek restarts the browser tape at 09:38, so it holds nothing at or below 98.00 and usually nothing at all, because the pause lands before prints flow. The panel reports `RTH LOW $98.00` regardless. This is the requirement that motivated the whole session-context capability, and it was previously unobservable in any check.
- **A pause freezes the reading.** Held and re-read.
- **A backward seek across the low reconstructs correctly.** The low disappears, the reading becomes `0.00 ADR`, and the 95.00 low sitting in the recording at 09:45 does not appear in its place.
- **A seek does not remount the panel.** Mount counts are compared across seeks.
- **A reload while paused restores the position**, `09:38`, not the wall clock, and the same reading with it.
- **The later low appears only once the position passes it.**

Mutation tested. Making the session context read the whole session instead of stopping at the as-of instant fails the check immediately, with the leaked low visible in the message: `1.66 ADR`, `$95.00`.

It also, honestly, does **not** catch reverting the finding-11 line — which is how the misdiagnosis above was found. Writing the check was what disproved the finding.

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
| `node scripts/replay-panel-check.mjs` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo -rewind` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo` | pass |

Browser checks ran on macOS with `CHROME=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. The replay check builds the server binary rather than using `go run`, because `go run` does not forward a kill to the binary it spawns and the port would stay held.

## What is left

The replay gap that motivated eight passes is closed on both sides. What remains is narrower and worth naming precisely rather than repeating a slogan:

- The generated recording has one symbol and one session, so a **cross-session** backward seek and a **symbol change mid-replay** are still unexercised. Both are generation boundaries where the panel and the core have to agree on a date, and `66453c4` was written for exactly that case.
- No check covers **IBKR or Massive live** mode. That is inherent — they need a broker connection — but it means the live-mode branches of `panel_data.go` are read, not run.

---

# Ninth review pass after `73d9d3c`

`73d9d3c` was pulled and reviewed. The correction is valid: `handleMessage` already synchronizes `server_time_ms` at the start of every snapshot, so the removed late call was redundant. The generated replay fixture and browser driver exercise the actual server, SQLite recording, replay feed, WebSocket snapshots, HTTP panel-data capabilities, panel lifecycle, and visible browser state rather than simulating panel events. The fixture's constant 5.00% ADR baseline and deliberately later low make both the arithmetic and no-look-ahead assertions meaningful.

The generated replay check passed. A separate replay against the local August 18 SMCI IBKR/live recording also passed around 09:33: a paused position at 09:33:30 was sought backward to 09:33:00, the visible clock moved backward, the ADR panel stayed mounted, a paused reload restored 09:33:00, and the browser logged no errors. As in the prior pass, the real recording truthfully shows `INSUFFICIENT ADR HISTORY` because it has no SMCI daily bars and begins after the 09:30 open; the generated fixture is what validates the numeric `1.00 ADR` path.

No product or test issue was found. The only change in this pass is this handoff note. The unrelated local `go-render.sh` edit remains deliberately unstaged.

## Verification rerun

| Command or scenario | Result |
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
| `node scripts/replay-panel-check.mjs` | pass |
| Real SMCI IBKR/live replay, backward seek and paused reload around 09:33 | pass; expected insufficient-history state, no browser errors |
| `node scripts/browser-check.mjs` against `./go.sh demo -rewind` | pass |
| `node scripts/browser-check.mjs` against `./go.sh demo` | pass |
