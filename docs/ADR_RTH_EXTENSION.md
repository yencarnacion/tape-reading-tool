# ADR Extension from Running RTH Low

The panel measures extension. It is not a win-rate calculation, does not predict an immediate reversal, and does not place or manage orders. `1.00 ADR` is a neutral reference marker, not a universal day-trading threshold.

## Definition

For the latest `N` valid completed RTH sessions preceding the active live or replay session:

```text
DailyRange_i = High_i / Low_i - 1
ADR_N = mean(High_i / Low_i - 1)
```

At authoritative time `t`:

```text
Raw extension = Current_t / Running_RTH_Low_t - 1
RTH extension = (Current_t / Running_RTH_Low_t - 1) / ADR_N
```

The default is `N = 20`; settings accept 5–60. The baseline uses exactly `N` sessions, excludes the current session, and is frozen throughout it. Fewer sessions produce `INSUFFICIENT ADR HISTORY`, not a mislabeled shorter average. Invalid, incomplete, future, mixed-provider, or zero-range history never produces a normal number.

The arithmetic is not ATR, a median, `(High - Low) / Close`, or `(High - Low) / Open`.

## RTH and eligible data

Nominal RTH is 09:30:00 inclusive through 16:00:00 exclusive in `America/New_York`, using timezone-aware conversion across daylight-saving changes. The current price and running low use the same chart-eligible trade population as the price chart. Bid, ask, midpoint, rejected/unreported prints, premarket prices, and final daily lows loaded in advance are excluded.

Market/exchange time decides RTH membership. Availability time decides when a print becomes knowable. A late RTH report may change the running low only when it is delivered; it is never inserted into an earlier replay state.

Before 09:30 the panel waits for RTH. After the open it builds until the first eligible price is known. After 16:00 it freezes and labels the value `RTH CLOSED`.

## Completeness and no look-ahead

The browser does not infer the low from its bounded tape array. A core-owned session-context capability returns symbol, session, as-of time, OHLC/low time/latest price, eligible count, source/provider/mode, and `completeFromRTHOpen`.

For live IBKR, the existing connection supplies bounded historical bars; no second connection is created. Massive and replay use locally recorded/downloaded coverage when available. Demo supplies deterministic prior bars and session context. If an application starts or changes symbols after 09:30 and the core cannot prove coverage back to the open, the UI shows `RTH LOW INCOMPLETE`.

Replay and deterministic render take their session date and position from the server-owned replay clock, never `Date.now()`. Storage filters current-session trades both by RTH market time and by whether their receipt/event time was at or before the target. Seeking or changing symbols produces a new panel generation, clears prior visible values, reloads the frozen prior-session baseline, and reconstructs context through the new target. Late results from older generations are ignored.

The browser names the session and instant it wants, but in real replay and deterministic render modes the server decides the authoritative session and instant it answers for. Replay-backed session context always follows the replay clock's New York session; a stale browser date after a cross-session backward seek cannot select old or future session data. Demo mode deliberately accepts a requested historical session so deterministic browser checks can exercise replay presentation without a recorded database. A requested `through_us` beyond the authoritative clock is clamped down to it rather than refused: the browser extrapolates between deliveries, the replay position only advances when an event is emitted, and a backward seek leaves the browser clock ahead until the first batch from the new position arrives. Clamping can only remove look-ahead, never grant it, so an early replay instant can never be answered with a later session low.

Every snapshot carries the authoritative instant — the replay position in replay and render modes — and the browser adopts it before anything else in the message is applied, so a generation boundary resets the clock rather than carrying an extrapolation across it. Between snapshots the browser clock advances at wall-clock rate while the replay position advances only when an event is emitted, which is why a request may name an instant marginally past the position and why the core clamps rather than refuses.

These guarantees are exercised against a real replay feed, not a simulated position. `internal/server/panel_replay_test.go` steps a prepared render to exact instants and asserts that a session low formed later in the session is invisible before the position reaches it, that a request naming an instant past the position clamps rather than revealing it, that the baseline is selected from the replay session date even when the browser asks with a wall-clock date, and that the same position twice produces the same context. `scripts/replay-panel-check.mjs` drives the same guarantees through the browser against a generated recording, including that the running low the panel reports is one the browser's own tape never received, because the seek restarted it later in the session.

A paused replay is stopped in time. Neither the animation frame nor a delivered batch advances the panel clock while it is paused. Crossing into a different session date — overnight in live mode, or a seek that lands on an earlier date — invalidates both the baseline and the seed and reloads them; the previous session's low and last are never presented as current.

Completed prior sessions come either from provider-completed RTH daily candles or local minute/trade data whose coverage metadata proves the full nominal RTH request completed. Quiet minutes need not contain trades. The service does not mix providers merely to reach the lookback.

History responses report source/provider and an adjustment convention. Version 1 preserves one provider-consistent series and does not invent split corrections. High/low ratios are ordinarily invariant to overnight split adjustment, but corrupt or intraday-action bars remain invalid inputs.

## Presentation

The main value is shown in ADR units with the raw percent from the running RTH low. Supporting fields show low, low time, last, ADR period/value, and history count. The neutral magnitude scale marks 0.00 through 1.25+; its fill may cap while the numeric value continues above 1.25. It issues no alerts and carries no buy, sell, safe, winner, or reversal label.

The readout is achromatic on purpose. Every saturated hue in the application already carries an instant meaning — green/red delta, cyan/amber price direction, blue/orange tape sides, the violet RVOL magnitude ramp, amber Live Rewind chrome — so extension, which is neither a side nor an alarm, is carried by the number, the labels, and the meter position instead of by a colour that would read as one of those.

Live Rewind intentionally keeps an independent Tape Pressure panel in version 1. Selecting ADR affects only the live analytics slot; rewind does not pause or remount it.

## Known limitations

- Version 1 depends on provider history or truthful local coverage; missing history is shown explicitly.
- Early-close sessions count only when provider/local coverage establishes completion.
- Provider adjustment semantics are reported as provider-consistent; no cross-provider normalization is attempted.
- Automatic time-of-day panel switching, premarket/open/VWAP extensions, signals, alerts, backtests, and order entry are outside scope.
