# Fractional share sizes

Massive stock prints can carry integer `s: 0` and decimal `ds: "0.013374"`.
That is a real execution for 0.013374 shares. DaiDai preserves the original
trade JSON on its existing shared stock connection; Tape Reading Tool prefers
`ds` for live prints and `decimal_size` for historical downloads. Missing or
null decimal fields fall back to the legacy size; malformed, negative or
non-finite decimal quantities are rejected rather than turned into zero.

The in-memory tape, SQLite recordings, replay and pressure calculations retain
fractional quantities. Time & Sales uses `<1` for a sub-share execution so the
narrow column remains readable; hover over Size for the quantity to six decimal
places. Other quantities keep compact formatting, with the full quantity on
hover and in accessible text. An unavailable/zero size displays `—`.

Both DaiDai and Tape Reading Tool must restart to load the fix. Existing live
recordings that already lost the decimal field cannot be repaired from those
records alone. They are retained, not guessed or silently rewritten. New
historical downloads retrieve decimal sizes through the configured gateway.

Validation: `go test ./internal/feed`, `node scripts/trade-size-check.mjs`, and
`scripts/trade-size-browser-check.mjs` (set `CHROME` to a Chromium executable).
DaiDai's data tests exercise the actual SDK against a local mock WebSocket.
