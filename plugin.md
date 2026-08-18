
## Role

Act as a senior Go and browser application engineer with strong experience in:

* Real-time market-data applications
* Low-latency browser interfaces
* Historical market replay
* Vanilla JavaScript module architecture
* Go HTTP and WebSocket servers
* SQLite
* IBKR and Massive market data
* Testable indicator calculations
* Safe extension and plugin architectures
* Avoiding look-ahead bias in trading software

Work directly in this repository:

`https://github.com/yencarnacion/tape-reading-tool`

Do not merely produce a design proposal. Inspect the current repository and implement the end-to-end goal described below.

Do not ask the user to choose among architecture options unless progress is genuinely blocked by unavailable credentials or inaccessible source code. Make conservative engineering decisions that fit the existing application, document those decisions, and keep the implementation narrowly focused.

Do not push, merge, or open a pull request unless separately authorized. Create or use an appropriate feature branch such as:

`feature/panel-platform-adr-rth-extension`

Avoid unrelated refactors.

---

# End-to-end goal

Implement the first version of a small, versioned analytics-panel platform inside `tape-reading-tool`, then use it to deliver the first replaceable analytics panel:

**ADR Extension from Running RTH Low**

At completion, the user must be able to switch instantly between:

1. **Tape Pressure**
2. **ADR from RTH Low**
3. **Blank**

The switch must happen inside the existing rolling-pressure rectangle without:

* Reloading the page
* Reconnecting the market-data feed
* Reconnecting the application WebSocket
* Restarting IBKR or Massive subscriptions
* Clearing the tape
* Clearing the chart
* Interrupting recording
* Interrupting historical replay
* Interrupting audio
* Changing the selected ticker
* Resizing or moving the surrounding chart and time-and-sales panes

The selected panel must receive the current symbol, authoritative market or replay clock, current data snapshot, and subsequent updates.

The ADR panel must work correctly in:

* IBKR live mode
* Massive live mode
* Demo mode
* Historical replay mode
* Deterministic render mode

A mode may show an explicit `HISTORY UNAVAILABLE` or `INSUFFICIENT HISTORY` state when the required historical data is genuinely absent. It must never silently calculate an ADR from incomplete, current-day, future, or mismatched data.

The work is not complete until:

* The existing Tape Pressure behavior is preserved.
* Live Rewind still has Tape Pressure regardless of the live analytics-panel selection.
* ADR calculations have deterministic tests.
* Replay has no look-ahead.
* Hot swapping has browser-level tests.
* Existing tests and verification commands pass.
* The architecture and indicator are documented.

---

# Product terminology

Use these definitions consistently in code and documentation:

* A **panel slot** is a fixed rectangle in the application layout.
* A **panel** is the visual feature mounted in that slot.
* An **indicator** is a calculation independent of its visual presentation.
* A **plugin** is a packaged feature containing one or more calculations and a panel that presents them.
* The **panel host** is the core-owned runtime that mounts, updates, isolates, unmounts, and swaps panels.
* The **ADR indicator** is the pure calculation used by the ADR panel.

Do not make the ADR feature another hardcoded conditional inside the existing rolling-pressure rendering logic. It must use the same panel contract as Tape Pressure.

Do not attempt to build a VS Code-style extension ecosystem in this iteration.

---

# Inspect the existing application first

Before editing, inspect at least:

* `README.md`
* `cmd/tape-reading-tool/main.go`
* `internal/config/config.go`
* `internal/feed/`
* `internal/storage/sqlite.go`
* `internal/server/server.go`
* `internal/server/web/index.html`
* `internal/server/web/styles.css`
* `internal/server/web/app.js`
* `internal/server/web/tape-model.js`
* `internal/server/web/tape-source.js`
* `internal/server/web/tape-rewind.js`
* `scripts/browser-check.mjs`
* Existing Go and JavaScript checks

Confirm the current behavior before modifying it.

Important current architectural facts to preserve:

* The Go server owns feed connections, replay, storage, and the authoritative replay clock.
* The browser receives live and replay data in substantially the same WebSocket shape.
* The browser currently maintains symbol, trades, quotes, minute bars, daily bars, replay status, server clock, and rewind state centrally.
* `tape-model.js` contains pure calculations that do not access the DOM, network, or clock.
* `tape-source.js` provides a shared event-source contract used by live and replay calculations.
* The server already has daily-history and minute-history mechanisms.
* The current Live Rewind implementation clones the live rolling-pressure DOM. That behavior must be replaced because it would otherwise clone the ADR panel whenever ADR is selected.

Do not introduce React, Vue, Svelte, a bundler, TypeScript, npm dependency management, or a new server framework. Continue using the repository’s current Go plus embedded vanilla ES-module architecture unless the actual current repository has materially changed and provides a compelling existing alternative.

---

# Architectural rules

## Responsibilities that remain in the core application

The core application must continue to own:

* IBKR connections
* Massive connections
* WebSocket delivery
* Recording
* Historical downloads
* Historical replay
* Deterministic render progression
* Symbol switching
* The authoritative live or replay clock
* Trade, quote, minute-bar, and daily-history access
* RTH session context
* Layout and panel-slot ownership
* Panel registration
* Panel mounting and unmounting
* Panel error handling
* Panel settings persistence
* Permissions and capabilities
* Shared theme and formatting utilities

A panel must never:

* Open its own IBKR connection
* Open its own Massive connection
* Open another application WebSocket
* Read API keys
* Read the SQLite database directly
* Decide independently what the current symbol is
* Decide independently what replay time it is
* Poll an arbitrary remote URL
* Access order-entry functionality
* Control replay unless that capability is deliberately added in a future API version
* Manipulate DOM outside its assigned root
* Depend on undocumented global state

The panel host may satisfy a panel’s data request through a core-owned same-origin HTTP endpoint, but the panel should call a host capability rather than issuing arbitrary `fetch` calls.

## Version the contract immediately

Define constants equivalent to:

* `PANEL_API_VERSION = 1`
* `PANEL_DATA_SCHEMA_VERSION = 1`

Every registered panel must declare the API version it supports.

Reject an incompatible panel cleanly and show a panel-local error card. Do not allow an incompatible panel to damage the rest of the application.

## Trust level for version 1

All version-1 panels are trusted, built-in, first-party ES modules shipped with the application.

Do not implement in this iteration:

* Loading arbitrary JavaScript from a user-selected directory
* Installing plugin archives
* A marketplace
* Automatic plugin updates
* Cryptographic package signing
* Third-party network access
* Sandboxed iframes
* A declarative remote UI system
* Multiple draggable or resizable panel slots

Design the API so those features would not require abandoning the panel contract, but do not build them now.

---

# Panel platform version 1

## First panel slot

Convert the existing rolling 5/15/60-second pressure rectangle into one fixed analytics slot.

The surrounding layout must remain stable.

Conceptually, the DOM should become equivalent to:

```text
chartPanel
  chartCanvas
  analyticsSlot
    slotChrome
      panelPicker
      optional panel status/settings control
    panelRoot
  chartEmpty
  marketClock
```

The exact DOM structure may differ if a better fit is found in the existing code, but the following must be true:

* The slot owns one stable rectangle.
* Swapping content does not change the rectangle.
* The slot does not cause chart or time-and-sales reflow.
* The selector is keyboard accessible.
* The selector does not cover essential panel data.
* The selected panel name is visible.
* Tape Pressure is the default.
* The selection persists across reloads.
* The existing compact-width behavior remains usable.

## Built-in panel registry

Create a registry of first-party panel definitions.

Each definition should have a stable manifest containing at least:

```text
id
name
version
panelApiVersion
dataSchemaVersion
description
supportedModes
requestedCapabilities
defaultSettings
minimumWidth or supportedSizes
factory
```

Stable IDs should be similar to:

* `tape-pressure`
* `adr-rth-extension`
* `blank`

Do not key persistence by a display name that may later change.

## Suggested capability vocabulary

The panel host should expose narrowly scoped capabilities such as:

* Read the current symbol.
* Read the current application mode.
* Read the authoritative clock.
* Read the latest quote.
* Read the current application snapshot.
* Receive trade batches.
* Receive quote changes.
* Receive symbol changes.
* Receive mode changes.
* Receive clock changes.
* Request completed daily RTH bars through the core.
* Request current-session RTH context through the core.
* Read or save only that panel’s settings.
* Request a non-blocking panel-local status or warning.
* Request a redraw.

The ADR panel should not require arbitrary network access.

The Tape Pressure panel should receive the existing stream source or an equivalent read-only data capability rather than reaching into unrelated application state.

## Lifecycle

Implement a small lifecycle contract with semantics equivalent to:

```text
mount
snapshotChanged or receiveInitialSnapshot
symbolChanged
modeChanged
clockChanged
tradeBatch
quoteChanged
minuteBarsChanged
settingsChanged
resized
unmount
```

The implementation may use one generic `onEvent(event)` method or separate callbacks. Favor the shape that is easiest to validate and test in the current application.

Requirements:

* `mount` receives only the assigned root, read-only host capabilities, manifest information, and panel settings.
* `unmount` disposes of timers, listeners, animation frames, abort controllers, workers, and pending requests.
* A panel receives no events after unmount.
* Async results from an old mount generation must never update a newly selected panel.
* A panel may schedule a render, but the host should coalesce high-frequency updates.
* Do not update large DOM sections for every individual print.
* A panel should process one delivered trade batch at a time.

## Hot-swap sequence

Implement swapping as a lifecycle operation:

1. Record a new slot generation.
2. Stop event delivery to the current panel.
3. Abort the current panel’s host-managed requests.
4. Call its unmount/dispose operation.
5. Remove its panel-local resources.
6. Show an immediate loading state in the same rectangle.
7. Instantiate the selected panel.
8. Give it the current symbol, mode, authoritative clock, settings, and current data snapshot.
9. Let it request any required bounded history through the host.
10. Start incremental event delivery.
11. Persist the selected panel ID.

Do not reload the page.

Do not retain inactive panels in the background. A swapped-out panel is unloaded, not merely hidden.

A future “keep warm” option is outside this task.

## Settings persistence

Extend the existing settings persistence safely rather than creating a second unrelated mechanism.

Use a versioned structure conceptually similar to:

```text
panels:
  slots:
    primaryAnalytics:
      activePanelId: tape-pressure
  settings:
    adr-rth-extension:
      lookbackSessions: 20
```

Requirements:

* Existing saved settings must continue to load.
* New fields must merge with defaults.
* Invalid or unknown panel IDs fall back to `tape-pressure`.
* Invalid ADR settings fall back to safe defaults.
* The main settings reset operation must reset panel selection and panel settings appropriately.
* Do not store market history in `localStorage`.

## Error containment

Wrap every panel lifecycle callback and async completion.

A panel exception should replace only that panel with an error card similar to:

```text
ADR FROM RTH LOW STOPPED

Reload panel
Switch panel
View error
```

Requirements:

* The chart keeps painting.
* Time and sales keeps updating.
* Audio keeps running.
* Recording continues.
* Replay continues.
* The WebSocket remains connected.
* No other panel is unmounted.
* The error details are available in the browser console or a small expandable area.
* Never expose API keys, authentication data, or unrelated application state in the error card.

A trusted module can still freeze the browser with an infinite loop. Document that version 1 provides exception isolation but is not yet a hostile-code security boundary.

## Security

Preserve the existing strict Content Security Policy.

Do not add:

* Inline JavaScript
* `eval`
* `new Function`
* Remote scripts
* Wildcard network permissions
* Direct plugin access to credentials
* Direct plugin access to application internals

Validate all core-to-panel data at the boundary.

Bound:

* Daily-history request size
* Current-session history request size
* Message sizes
* Lookback values
* Retained panel state

---

# Refactor Tape Pressure into a first-party panel

The existing rolling 5/15/60-second pressure display is the reference implementation for the panel API.

Extract it behind the panel contract without changing its calculations, labels, or trading behavior.

Preserve:

* 5-second ignition horizon
* 15-second primary horizon
* 60-second context horizon
* Buyer and seller volume
* Delta and delta percentage
* Shares per second
* Prints per second
* Midpoint movement
* Relative pace
* Existing balanced/buyer/seller classification
* Existing truncated or `NO DATA` behavior
* Existing typography and responsive treatment
* Existing use of the shared EventSource calculation path
* Existing live and historical replay equivalence

Do not duplicate the pressure calculation.

A reasonable structure would separate:

* Pure pressure calculations
* Pressure DOM construction or template creation
* Pressure panel lifecycle adapter

Exact filenames are up to the implementation, but do not keep all panel logic embedded in the large `app.js` file.

## Critical Live Rewind requirement

The current implementation clones the live rolling-panel DOM into the rewind pane. Remove that dependency.

Instead:

* Create one Tape Pressure instance for the replaceable live analytics slot when `tape-pressure` is selected.
* Create a completely separate, fixed Tape Pressure instance for Live Rewind.
* The rewind instance must use the rewind event source and rewind clock.
* The live instance must use the live or historical-replay stream source.
* The rewind instance must exist regardless of which live analytics panel is selected.
* Selecting ADR must not make the rewind pane show ADR.
* Selecting Blank must not make the rewind pane blank.
* Starting or exiting rewind must not remount the live analytics panel.
* The live ADR panel must continue following live time while the separate rewind pane replays earlier prints.

Do not solve this by cloning the currently mounted live slot.

---

# ADR Extension from Running RTH Low

## Indicator name and stable ID

Display name:

**ADR FROM RTH LOW**

Stable panel ID:

`adr-rth-extension`

The panel should make clear that the reference point is the regular-session low, not:

* Premarket low
* Final low of the entire day
* Previous-day low
* Low made after the current replay instant
* VWAP
* The 09:30 opening price
* A recent microbase low

Those can become separate indicators later.

## ADR baseline definition

The default lookback is 20 completed regular trading sessions.

For each prior completed session:

```text
DailyRange_i = High_i / Low_i - 1
```

Then:

```text
ADR_N = arithmetic mean of DailyRange_i over the latest N valid completed RTH sessions
```

For the default:

```text
ADR20 = (1 / 20) × Σ(High_i / Low_i - 1)
```

ADR is represented internally as a decimal.

Examples:

* `0.06` means a 6% ADR.
* `0.025` means a 2.5% ADR.

Do not use these alternative definitions:

```text
(High - Low) / Close
(High - Low) / Open
ATR
Median daily range
Current-day-inclusive rolling range
Premarket-plus-RTH range
```

A median or ATR option is outside version 1.

## Historical-session rules

The baseline must use the most recent `N` valid completed RTH sessions preceding the current live or replay session.

Requirements:

* Exclude the current session completely.
* Freeze the baseline for the entire current session.
* Do not let today’s opening move change its own denominator.
* In replay, select sessions preceding the replay session date, not sessions preceding the computer’s current wall-clock date.
* Never include a daily bar after the replay session.
* Weekends and holidays are naturally skipped by selecting actual available completed sessions rather than assuming five sessions per calendar week.
* A shortened session may count when the provider or local coverage proves it is a completed RTH session.
* Missing calendar dates are not zero-range days.
* Invalid bars are not silently converted to zero.

A daily bar is valid only when:

```text
High > 0
Low > 0
High >= Low
all required numbers are finite
the session is known to be completed
the bar represents RTH
```

Use exactly `N` valid completed sessions for a valid result.

When only 17 of 20 sessions are available, show:

```text
INSUFFICIENT ADR HISTORY
17 / 20 COMPLETED SESSIONS
```

Do not calculate and present a 17-session value as `ADR20`.

The settings UI may let the user select a lookback from a bounded range such as 5–60 sessions. The label must change to match the actual value, such as `ADR10` or `ADR30`.

Default remains 20.

## Current extension definition

At authoritative time `t`, define:

* `P_t` as the latest eligible trade price known to the application at or before `t`.
* `L_RTH,t` as the lowest eligible regular-session trade price known to the application from 09:30 ET through `t`.
* `ADR_N` as the frozen prior-session baseline.

Then:

```text
RTH_Extension_ADR_t =
    (P_t / L_RTH,t - 1) / ADR_N
```

The raw percentage move from the RTH low is:

```text
RTH_Extension_Percent_t =
    P_t / L_RTH,t - 1
```

Example:

```text
ADR20                 = 0.08
Running RTH low       = $50.00
Current eligible last = $52.00

Raw move from low     = 52 / 50 - 1 = 0.04 = 4.00%
ADR extension         = 0.04 / 0.08 = 0.50 ADR
```

Display:

```text
0.50 ADR
+4.00% FROM RTH LOW
```

## Eligible trade rules

Use the application’s existing chart-eligibility semantics.

The current price and running low should be based on the same valid, chart-eligible trade population used for the application’s price chart.

Do not use:

* Bid
* Ask
* Midpoint
* An unreported or excluded print that the chart intentionally rejects
* A future trade
* A final end-of-day low loaded in advance
* A stale previous-symbol price

RTH membership should be determined from the trade’s market or exchange timestamp in `America/New_York`, while availability is determined by whether the event has actually reached the current live or replay state.

A late report whose market timestamp belongs to RTH may update the running RTH low when that report becomes known. Do not retroactively pretend the low was known before the report was delivered.

## Regular-session boundaries

Use the configured application timezone, expected to be:

`America/New_York`

Define nominal RTH as:

```text
09:30:00 ET inclusive
16:00:00 ET exclusive
```

Use timezone-aware date conversion. Do not calculate boundaries by applying a fixed UTC offset because daylight-saving time changes.

States:

### Before 09:30 ET

Show:

```text
WAITING FOR RTH OPEN
ADR20 6.24%
20 / 20 SESSIONS
```

Do not substitute the premarket low.

### At or after 09:30 ET, before the first eligible RTH trade

Show:

```text
BUILDING RTH LOW
```

### During RTH

Update from eligible trade batches.

### After 16:00 ET

Freeze the final current-session extension and label the state as:

```text
RTH CLOSED
```

Do not automatically replace the panel after 10:30 or 16:00.

Version 1 uses manual panel selection. Automatic layout schedules are outside scope.

## No look-ahead

This requirement is absolute.

In replay at 09:36:

* The running RTH low may use only eligible events delivered through 09:36 on the authoritative replay timeline.
* It may not use a low formed at 09:47.
* Daily history may include only completed sessions before the replay date.
* The panel must freeze when replay is paused.
* The panel must rebuild when replay seeks backward or forward.
* A replay seek must invalidate pending history from the prior replay generation.
* A browser reload during replay must reconstruct the same value at the same replay position.
* Deterministic render must use the explicit render clock, never `Date.now()`.

Do not calculate the running low by loading the complete current-day candle from a daily-history provider.

## Do not derive the running low from only the bounded browser tape

The browser’s recent-trade array or server snapshot may no longer contain all prints since 09:30, particularly:

* When the application started after 09:30
* After a symbol switch
* Late in the day
* After a ring-buffer prune
* After a browser reload
* During replay seek
* At very high print rates

Therefore, the panel must not assume:

```text
minimum price in state.trades = running RTH low
```

Add a **core-owned, replay-aware RTH session-context capability**.

It may be implemented as:

* Additional validated data in the WebSocket snapshot,
* A generic same-origin panel-data endpoint,
* A host data service backed by the current feed and database,
* Or a combination.

Choose the implementation that best fits the current repository.

The capability must provide a seed equivalent to:

```text
schemaVersion
symbol
sessionDateET
throughUS
open
high
low
lowTimeUS
last
lastTimeUS
eligibleTradeCount
completeFromRTHOpen
source
provider
mode
```

Critical rules:

* `completeFromRTHOpen` must be truthful.
* If the core cannot establish the low from 09:30 through the current instant, do not display a normal ADR extension.
* Show `RTH LOW INCOMPLETE` instead.
* Once seeded, incremental eligible trade batches may update the running low in O(number of new trades).
* Do not rescan the full session after every trade.
* Symbol changes, date changes, replay seeks, generation changes, and reconnect snapshots must invalidate and reseed context.
* Stale responses for a previous symbol or generation must be discarded.

For live mode starting after the open, use an existing feed/provider history capability or recorded minute bars to seed 09:30 through the current instant.

For replay, reconstruct through the replay position from local data only. Never use later current-session bars.

## Daily history capability

Generalize or extend the existing daily-history mechanism so panels can request completed RTH daily bars as of an authoritative session date.

The panel-facing host capability should be conceptually similar to:

```text
getCompletedDailyBars({
  symbol,
  beforeSessionDateET,
  limit,
  session: "RTH"
})
```

The panel calls the host capability, not an arbitrary URL.

The core may implement this over an endpoint such as:

```text
GET /api/panel-data/daily-bars
```

The exact route name is not important. The semantics are.

Return validated metadata equivalent to:

```text
schemaVersion
symbol
timezone
session
throughUS
beforeSessionDateET
requestedSessions
completeSessions
source
provider
adjustment
status
message
bars
```

Each bar should include enough information to audit the calculation:

```text
sessionDateET
open
high
low
close
volume
startUS
endUS
complete
```

Requirements:

* Bound `limit`, for example 1–90.
* Normalize and validate the symbol.
* Reject malformed timestamps.
* Use the replay clock in replay and render modes.
* Never use the computer’s current date to choose history for an older replay.
* Cache by symbol, mode, provider/source, as-of session, session type, and requested limit.
* Do not let one browser tab produce repeated provider requests every animation frame.
* Cancel or disregard stale requests after symbol or replay-generation changes.
* Do not expose provider credentials.

## Data source behavior by mode

### IBKR live

Reuse the existing IBKR session and existing historical-bar mechanisms.

Use completed one-day RTH `TRADES` bars for the ADR baseline.

Use a bounded RTH minute-bar or session-context request when the current running low must be seeded.

Do not create a second IBKR client connection for the panel.

Respect IBKR pacing.

Cache results.

### Massive live

Use a core-owned Massive data capability or locally cached bars.

Do not let the panel use the Massive API key directly.

Use unadjusted data consistently with the raw tape unless the existing application establishes a different explicit convention.

Return truthful source and adjustment metadata.

### Demo

Provide deterministic synthetic prior daily bars and deterministic current-session context.

The demo must be rich enough to test:

* Loading state
* Ready state
* Running-low updates
* A new low resetting extension to zero
* Panel swapping
* Symbol changes
* Insufficient-history state
* Error state if deliberately injected by a browser test

Do not make demo ADR depend on an external provider.

### Historical replay

Use the replay’s selected symbol, source, provider, session date, and authoritative replay position.

Prefer local SQLite data.

The core may derive prior RTH sessions from:

* Cached historical minute bars
* Complete downloaded trade data
* Existing provider bars stored locally
* A new reusable core history abstraction

A locally derived session is eligible for ADR history only when the application can establish that the requested RTH interval was completely covered. Use existing download-coverage metadata where possible.

Do not infer that a day is complete merely because one or more bars exist.

When fewer than the requested prior sessions are locally available, return a truthful insufficient-history result.

Do not silently contact a remote provider from the panel.

### Deterministic render

Use the explicit render progression and replay data.

Do not read wall-clock time.

The ADR value at a rendered frame must be repeatable.

A second render of the same symbol, data, and timestamp must produce the same ADR value.

## Corporate actions and adjustment consistency

Do not silently combine adjusted and unadjusted history.

Return adjustment metadata with history.

Use a consistent convention across all history bars in one calculation.

Because the ADR formula uses the high-to-low ratio within each session, ordinary overnight split adjustment usually does not change that session’s percentage range. An intraday corporate action or corrupt bar can still distort the result.

Requirements:

* Reject invalid bars.
* Do not invent split corrections.
* Document the adjustment convention.
* Report an explicit warning if the provider cannot state or preserve consistent adjustment semantics.
* Do not mix provider histories merely to reach 20 sessions without clear normalization.

---

# ADR calculation module

Place ADR arithmetic in a pure JavaScript module with:

* No DOM access
* No network access
* No `Date.now()`
* No application-global state
* Explicit inputs
* Deterministic outputs
* Unit-testable functions

Functions should conceptually cover:

* Validation of completed daily bars
* Selection of the latest `N` valid completed sessions before a target session
* ADR arithmetic
* RTH boundary classification
* Initial session-context validation
* Incremental update of running RTH low and current price
* Calculation of raw percent extension
* Calculation of ADR-normalized extension
* Display-state classification
* Safe formatting inputs

Do not bury the formula inside DOM rendering code.

Handle safely:

* Zero or negative ADR
* Non-finite values
* High below low
* Missing current price
* Missing RTH low
* Incomplete-from-open session context
* Fewer than the required daily sessions
* Symbol mismatch
* Session-date mismatch
* Stale generation
* Current price equal to the running low
* A newly delivered lower eligible print
* An excluded print below the low
* Before-open and after-close states

---

# ADR panel presentation

The panel must fit into the current Tape Pressure slot at both desktop and compact widths.

Use the existing visual language:

* Dark surfaces
* Existing typography
* Tabular numeric alignment
* Existing CSS variables where semantically appropriate
* Text labels in addition to color
* Keyboard focus indicators
* Accessible status text

Do not use green to imply “buy” or red to imply “sell.”

ADR extension is magnitude, not trade direction.

Do not reuse a color in a way that conflicts with:

* Buyer pressure
* Seller pressure
* Price up/down
* RVOL magnitude
* Live Rewind chrome
* VWAP or chart indicators

A mostly neutral or separately named non-directional ADR palette is acceptable. Text and position must carry the meaning even without color.

## Primary ready-state layout

The panel should prominently show:

```text
ADR FROM RTH LOW

0.47 ADR
+2.82% FROM RTH LOW
```

Also show compact supporting fields:

```text
RTH LOW     $50.00
LOW TIME    09:31:14
LAST        $51.41
ADR20       6.00%
HISTORY     20 / 20
```

Adapt the arrangement responsively rather than allowing text to overflow.

Use sensible precision:

* ADR extension: two decimals by default
* ADR baseline percentage: two decimals
* Raw move percentage: two decimals
* Price: use the application’s existing stock-price formatting
* Times: New York market time

## Reference scale

Include a compact horizontal magnitude scale with reference marks such as:

```text
0.00
0.25
0.50
0.75
1.00
1.25+
```

Requirements:

* The value may exceed 1.25.
* Do not clip the numeric readout.
* The visual meter may cap its filled width while still showing the actual value.
* Mark `1.00 ADR` as a neutral reference, not a reversal prediction.
* Do not make 0.47 a hardcoded special threshold.
* Do not issue default audio alerts.
* Do not label any band `BUY`, `SAFE`, `WINNER`, or `SHORT`.
* Include a compact `REFERENCE ONLY` label or equivalent accessible text.

The metric describes extension. It does not prove win probability.

## Loading and unavailable states

Provide clear, non-deceptive states:

```text
LOADING ADR HISTORY
```

```text
WAITING FOR RTH OPEN
```

```text
BUILDING RTH LOW
```

```text
INSUFFICIENT ADR HISTORY
17 / 20 COMPLETED SESSIONS
```

```text
RTH LOW INCOMPLETE
SESSION DATA DOES NOT REACH 09:30 ET
```

```text
ADR HISTORY UNAVAILABLE
```

```text
RTH CLOSED
```

```text
ADR PANEL ERROR
```

Do not show `0.00 ADR` when the correct state is unknown or unavailable.

## Settings

Version 1 needs only one ADR-specific setting:

```text
lookbackSessions
```

Default:

```text
20
```

Use a bounded range such as 5–60.

Changing the lookback must:

* Invalidate the old history request
* Load the correct number of completed sessions
* Update the label from `ADR20` to the chosen period
* Persist the setting
* Not reconnect the feed
* Not clear the tape
* Not interrupt replay

Do not add threshold optimization, alerts, automatic trades, or strategy rules.

---

# Panel picker and interaction

Provide a quick panel picker in the slot chrome.

It should allow the user to choose:

* `TAPE PRESSURE`
* `ADR FROM RTH LOW`
* `BLANK`

Requirements:

* One deliberate selection changes the panel.
* The picker works with mouse and keyboard.
* Focus does not trigger ticker shortcuts accidentally.
* The picker does not cause a page reload.
* The active panel is clearly indicated.
* The picker remains available in panel loading and error states.
* A failed panel can be replaced through the picker.
* The selection persists.
* Unknown saved IDs fall back to Tape Pressure.
* The Blank panel mounts and unmounts through the same lifecycle, proving that the slot is generic.

Do not implement automatic switching by time of day.

The manifest may reserve a future preferred active window such as 09:30–10:30 ET, but version 1 must not automatically hide or replace the ADR panel.

---

# Symbol changes

A ticker change must be treated as an atomic panel-generation boundary.

When the symbol changes:

1. Invalidate pending ADR history and RTH-context requests.
2. Clear the old symbol’s visible ADR values immediately.
3. Deliver the new symbol event.
4. Seed the new symbol’s current RTH session context.
5. Load the new symbol’s prior completed sessions.
6. Display loading states until both components are valid.
7. Ignore any late response for the previous symbol.
8. Resume incremental updates for the new symbol only.

Never briefly display AAPL’s ADR while the ticker field says SMCI.

The Tape Pressure panel’s existing symbol-switch behavior must remain unchanged.

---

# Replay behavior

Panel operation must follow the server-owned replay lifecycle.

Test at least:

* Replay ready
* Replay start
* Replay pause
* Replay resume
* Go-to-minute seek
* Backward seek
* Forward seek
* Replay stop
* Symbol change
* External replay cue
* Browser reload while replay is paused
* Deterministic render stepping

Requirements:

* Pause freezes the ADR display.
* Resume continues from the paused state.
* Seek clears prior current-session context and reconstructs through the target.
* A backward seek may increase or decrease the extension because the known low and price are reconstructed at the earlier instant.
* A future lower low must not affect an earlier replay value.
* History uses sessions before the replay session date.
* A stale seek-generation response cannot update a newer generation.
* Fast-follow or externally controlled replay must not make ADR appear current when its session context is not current.
* Use the application’s existing status vocabulary and suppression rules where appropriate.

---

# Live Rewind behavior

Live Rewind remains a separate visual tool.

When ADR is selected in the live analytics slot:

* ADR continues following the live feed.
* Pressing a rewind shortcut opens the existing rewind pane.
* The rewind pane shows its own Tape Pressure panel.
* Rewind has no effect on the live ADR calculation.
* Exiting rewind does not remount ADR.
* Changing rewind tick granularity does not affect ADR.
* Pausing the rewound segment does not pause live ADR.
* The live WebSocket and feed remain unchanged.

ADR itself does not need to be mounted inside the rewind pane in version 1.

Document that as a deliberate version-1 boundary, not an accidental limitation.

---

# Performance requirements

The panel platform and ADR feature must not add meaningful work to the feed callback.

Requirements:

* No history request per trade.
* No full daily-history recalculation per trade.
* No full-session scan per trade.
* ADR baseline calculation is O(N) when history loads.
* Running-low updates are O(number of newly delivered eligible trades).
* DOM rendering is coalesced, preferably through the existing animation-frame loop or a panel-host render scheduler.
* History requests run asynchronously.
* Cache completed daily history.
* Cache current-session seed data where safe.
* Use generation tokens or abort controllers.
* No inactive-panel timers.
* No hidden inactive-panel calculations.
* No new unbounded arrays.
* No duplicate WebSocket.
* No separate market-data subscription.
* No direct SQLite work in a feed callback.

Panel selection feedback should be immediate even when ADR history is still loading.

---

# Recommended file organization

Adapt names to current repository conventions, but aim for separation similar to:

```text
internal/server/web/
  panels/
    panel-api.js
    panel-host.js
    panel-registry.js
    blank-panel.js
    tape-pressure-panel.js
    adr-rth-extension-panel.js
    adr-rth-extension-model.js
```

A separate `panels/` directory is preferred if embedding `web/*` recursively is supported or can be safely adjusted.

Be aware that the current `//go:embed web/*` pattern may not recursively include nested files. Inspect Go embed behavior and the repository’s current asset arrangement before choosing a nested directory.

Safe alternatives include:

* Updating the embed pattern deliberately and testing it
* Keeping first-version modules directly under `internal/server/web/`
* Using a shallow directory structure supported by the current embed pattern

Do not create a layout that works from a development filesystem but disappears from the compiled Go binary.

Server-side additions should be placed in focused files rather than further enlarging `server.go` unnecessarily. For example:

```text
internal/server/panel_data.go
internal/server/panel_data_test.go
```

Pure Go aggregation or session-context code should also have focused tests.

---

# Server and storage design guidance

Use existing interfaces and storage where practical.

The repository already has concepts equivalent to:

* Feed-specific minute history
* Feed-specific daily history
* SQLite minute bars
* Download coverage
* Replay position
* Replay source/provider
* Server caching
* Active symbol
* Chart-eligible trade classification

Build on those.

Do not duplicate history retrieval independently for ADR.

A good internal design would expose generic core services such as:

```text
CompletedDailyBars(...)
RTHSessionContext(...)
```

The server handlers and panel-host capabilities can use those services.

## Current-session completeness

The current RTH seed must communicate whether it covers the interval beginning at 09:30.

For live mode:

* Application started before the open and retained authoritative session state: valid.
* Application started after the open but successfully backfilled 09:30 through now: valid.
* Application cannot backfill the earlier part of the session: incomplete.
* Symbol was newly selected and backfill is pending: loading.
* Provider request failed: unavailable or incomplete.

For replay:

* Local data reconstructs from 09:30 through replay position: valid.
* Replay range begins at 10:00 with no earlier local data: incomplete.
* Do not pretend the lowest price since 10:00 is the RTH low.

## Prior-session completeness

For local historical minute or trade data, use existing coverage metadata where possible.

A prior session should be considered complete only when:

* It came from a provider’s completed RTH daily candle, or
* Local coverage proves the requested data interval includes the full nominal RTH window, or
* Another existing authoritative repository mechanism proves completeness.

A coverage request extending through 16:00 can establish completion even on an early-close day when no prints occur after the actual close.

Do not require every minute to contain a trade.

Do not treat an illiquid zero-print minute as missing coverage when the provider request itself completed successfully.

---

# Testing requirements

## Pure ADR model tests

Add dependency-free deterministic checks following the repository’s current JavaScript testing style.

A script such as:

```text
scripts/adr-panel-check.mjs
```

should test at least:

1. ADR20 uses exactly 20 completed sessions.
2. It uses `High / Low - 1`.
3. It does not use `(High - Low) / Close`.
4. The current session is excluded.
5. Later sessions are excluded in historical replay.
6. The baseline remains frozen through the current session.
7. Invalid bars are rejected.
8. Fewer than 20 valid sessions produces insufficient history.
9. A zero ADR produces an unavailable calculation rather than division by zero.
10. Current price equal to RTH low produces `0.00 ADR`.
11. A move equal to half the baseline produces `0.50 ADR`.
12. A new lower eligible trade resets or reduces extension correctly.
13. An excluded lower trade does not change the RTH low.
14. A future lower low does not alter an earlier replay value.
15. Before-open state is correct.
16. First-trade/building state is correct.
17. After-close state is correct.
18. New York session boundaries work across daylight-saving changes.
19. A stale symbol generation is rejected.
20. Incomplete-from-open session context never yields a normal ADR number.
21. Formatting does not turn unavailable values into zero.
22. Lookback changes update both the calculation and label.

Expose only narrowly scoped test hooks when the existing browser-check pattern requires them. Do not make large mutable application internals global merely for tests.

## Go tests

Add focused Go tests for the server/core data capabilities.

Test at least:

* Symbol normalization
* Bounded lookback validation
* Invalid timestamp rejection
* Completed sessions only
* Current session exclusion
* Replay as-of date
* No future daily bars
* Correct provider/source selection
* Cache-key isolation
* Cache invalidation by session date
* Current RTH context through an exact timestamp
* Incomplete session-start coverage
* Complete coverage
* Late eligible reports
* Excluded prints
* Daylight-saving boundary construction
* Missing history
* Provider failure
* No credentials in responses
* Response schema version
* Race-safe concurrent requests
* Stale request generations where applicable

## Browser integration checks

Extend `scripts/browser-check.mjs` or add a focused companion check.

Test:

1. Tape Pressure is the default.
2. The selector lists all three panels.
3. Selecting ADR does not reload the page.
4. Selecting ADR does not open a second WebSocket.
5. Selecting ADR does not change the active symbol.
6. Chart canvas continues painting during and after the swap.
7. Time and sales continues updating.
8. Audio state is unchanged.
9. Tape Pressure unmounts cleanly.
10. ADR receives the current snapshot.
11. ADR shows loading and then ready.
12. ADR renders the expected deterministic demo value.
13. A new demo RTH low updates the value correctly.
14. Switching back to Tape Pressure restores normal pressure behavior.
15. Selection persists after reload.
16. Blank mounts through the same lifecycle.
17. Unknown saved panel IDs fall back safely.
18. A deliberately throwing panel callback produces a panel-local error card.
19. Reload Panel recovers.
20. Switching from an errored panel works.
21. A symbol change cannot display stale ADR data.
22. A stale delayed history response is ignored.
23. Replay pause freezes the value.
24. Replay seek reconstructs it.
25. A future replay low is not visible early.
26. The slot rectangle remains unchanged before and after swapping.
27. Surrounding pane rectangles remain unchanged.
28. Compact and desktop widths remain usable.
29. Keyboard access and focus indicators work.
30. Live Rewind always displays Tape Pressure while live ADR remains live.
31. Entering and exiting rewind does not remount the live ADR panel.
32. No inactive-panel timers or listeners continue firing after unmount.

Where possible, instrument:

* WebSocket constructor count
* Panel mount/unmount counts
* Canvas paint counts
* Slot bounding rectangles
* Pending-request generation IDs

## Existing verification

Run all current repository checks, including at least:

```bash
go test ./...
go test -race ./...
go build -buildvcs=false ./cmd/tape-reading-tool
node scripts/audio-worklet-check.mjs
node scripts/rewind-check.mjs
```

Run the new ADR model check.

With demo mode running in the required configuration, run:

```bash
node scripts/browser-check.mjs
```

Use both normal demo mode and the mode that reserves Live Rewind when needed by the browser checks.

Report every command actually run and its result.

Do not claim a test passed unless it was executed successfully.

---

# Documentation requirements

## README

Add a concise section explaining:

* The analytics panel slot
* How to switch panels
* Which panels are built in
* How selection is persisted
* ADR’s default 20-session lookback
* Live, demo, replay, and render behavior
* What happens when history is unavailable
* That Live Rewind retains Tape Pressure
* Verification commands

## Panel API documentation

Create:

`docs/PANEL_API_V1.md`

Document:

* Panel, indicator, plugin, slot, and host terminology
* API and data-schema versions
* Manifest fields
* Lifecycle
* Event ordering
* Initial snapshot
* Symbol and replay generation boundaries
* Host capabilities
* Settings ownership
* Error behavior
* Unmount obligations
* Requested permissions
* Version-1 trusted status
* Why arbitrary third-party loading is not yet supported
* Future path to workers and sandboxed iframes
* Security limitations
* Performance expectations

## ADR documentation

Create:

`docs/ADR_RTH_EXTENSION.md`

Document exactly:

```text
ADR_N = mean(High_i / Low_i - 1)
RTH extension = (Current / Running_RTH_Low - 1) / ADR_N
```

Also document:

* Current-session exclusion
* RTH boundaries
* New York timezone
* Chart-eligible trade population
* Running low known at the current instant
* No-look-ahead replay behavior
* History completeness
* Provider and adjustment metadata
* Behavior before open and after close
* Behavior when the application starts after 09:30
* Data required for replay
* Lookback setting
* UI reference markers
* Known limitations

Explicitly state:

* The indicator measures extension.
* It is not a win-rate calculation.
* It does not predict an immediate reversal.
* `1.00 ADR` is a reference level, not a universal day-trading threshold.
* The panel does not place or manage orders.

Do not present the Qullamaggie sample’s 0.47 median or 1.00 reference as validated thresholds for this day-trading application.

---

# Non-goals

Do not add any of the following in this task:

* Premarket-low ADR
* Extension from the 09:30 open
* VWAP extension
* Structural-stop ADR
* Opening-drive velocity
* Same-time RVOL research
* Backtest collection
* Signal expectancy
* Buy or sell recommendations
* Automatic order entry
* Audio alerts based on ADR
* Automatic panel switching at 10:30
* Multiple movable panel slots
* User-downloaded plugins
* Marketplace support
* Plugin signing
* Dependency resolution
* Remote network permissions
* Sandboxed third-party execution
* Worker infrastructure unless a worker is genuinely required by an existing computation
* A new database solely for panel settings
* A frontend framework
* A build pipeline
* A redesign of the entire UI

Leave clean extension points for later indicators, but do not implement them.

---

# Suggested implementation progression

Use an incremental sequence that keeps the application working:

## Phase 1: Establish baseline

* Run current tests.
* Run the app in demo mode.
* Record current panel rectangles and screenshots.
* Confirm current Tape Pressure and Live Rewind behavior.

## Phase 2: Extract Tape Pressure

* Separate Tape Pressure calculation/presentation lifecycle from the main application.
* Preserve all behavior.
* Replace the rewind DOM clone with a second explicit Tape Pressure instance.
* Verify no visual or calculation regression.

## Phase 3: Add panel host

* Add registry and manifests.
* Add one fixed analytics slot.
* Add picker.
* Add lifecycle and error boundary.
* Add persistence.
* Add Blank panel.
* Verify hot swapping without feed interruption.

## Phase 4: Add generic data capabilities

* Add completed RTH daily-bar capability.
* Add current RTH session-context capability.
* Make both replay-aware.
* Add validation, cache, completeness metadata, and tests.
* Do not calculate ADR in the server unless a small shared server-side validation calculation is useful for tests; the panel’s indicator calculation should remain independently testable.

## Phase 5: Add ADR model and panel

* Implement pure model.
* Implement loading, ready, closed, incomplete, and error states.
* Add lookback setting.
* Add neutral reference meter.
* Add incremental updates.
* Add stale-generation protection.

## Phase 6: Complete mode support

* IBKR live
* Massive live
* Demo
* Historical replay
* Deterministic render

## Phase 7: Browser and regression tests

* Hot swap
* Persistence
* Error containment
* Symbol races
* Replay seek
* No look-ahead
* Rewind independence
* Responsive widths
* No WebSocket reconnect

## Phase 8: Documentation and final verification

* Update README.
* Add Panel API documentation.
* Add ADR documentation.
* Run every test.
* Review the diff for unrelated changes.

Do not postpone tests until after a broad refactor.

---

# Acceptance criteria

The implementation is accepted only when all of these statements are true:

## Architecture

* A versioned panel API exists.
* A stable panel registry exists.
* One fixed analytics slot exists.
* Tape Pressure, ADR, and Blank use the same lifecycle.
* The ADR feature is not a hardcoded special case in the main render loop.
* Core data and application control remain centralized.
* Inactive panels are unloaded.

## Hot swapping

* The user can change the panel without a page reload.
* The WebSocket does not reconnect.
* The market-data feed does not reconnect.
* Recording continues.
* Replay continues.
* Audio continues.
* The chart continues painting.
* Time and sales continues updating.
* The surrounding layout does not move.
* Selection persists.

## Tape Pressure

* Existing live behavior is preserved.
* Existing replay behavior is preserved.
* Existing truncated-window behavior is preserved.
* Live Rewind has an independent Tape Pressure instance.
* Live Rewind is unaffected by the live-panel selection.

## ADR correctness

* The baseline is arithmetic mean `High / Low - 1`.
* Default lookback is 20 completed RTH sessions.
* The current session is excluded.
* The baseline is frozen for the session.
* Extension uses current eligible last versus running RTH low.
* The RTH low is known through the current authoritative instant only.
* The calculation never uses a future low.
* Replay history is selected relative to replay date.
* The current RTH seed reaches 09:30 or the panel declares it incomplete.
* Invalid or insufficient data never appears as a normal numeric result.
* Changing lookback updates the correct calculation.
* No trade signal or win probability is implied.

## Reliability

* Symbol races are handled.
* Replay-generation races are handled.
* Pending requests are aborted or ignored after unmount.
* A panel exception does not break the application.
* CSP remains strict.
* No credentials reach a panel.
* No unbounded background calculation is introduced.
* The race test passes.

## Documentation and tests

* Pure ADR checks exist and pass.
* Go data-service tests exist and pass.
* Browser hot-swap tests exist and pass.
* Existing audio and rewind checks pass.
* README is updated.
* `PANEL_API_V1.md` exists.
* `ADR_RTH_EXTENSION.md` exists.
* The final report lists all verification commands and truthful results.

---

# Final response format

After implementation, respond with these sections:

## Result

State whether the end-to-end goal was completed.

## User-visible behavior

Explain how the user switches between Tape Pressure, ADR, and Blank, and what the ADR panel displays.

## Architecture implemented

Summarize the panel host, registry, lifecycle, capabilities, persistence, error boundary, and Live Rewind separation.

## ADR definition

Repeat the exact formulas and data rules implemented.

## Important files changed

List each important file and its responsibility.

## Mode support

Report the result for:

* IBKR live
* Massive live
* Demo
* Historical replay
* Deterministic render
* Live Rewind interaction

## Tests and verification

List every command executed and whether it passed.

## Limitations

State only genuine remaining limitations, especially missing local history, provider availability, or version-1 trusted-plugin boundaries.

## Follow-up architecture

Briefly identify the next logical step, but do not implement it as part of this task. The likely next step is exercising Panel API version 1 with another first-party indicator before attempting third-party package installation or sandboxing.
