# Optional local integrations

A clean checkout can run `./go.sh demo -chart -xtra` with no credentials or other apps.
IBKR live tape, ADR, stock replay, and audio retain their normal setup. All
integrations below are optional backend configuration; none is a build dependency.
Keep real settings in ignored `.env` or environment variables, and personal
notes, recordings, screenshots, and archives in ignored `local/`, `data/`, or
outside the repository. Publish synthetic examples only.

- **Options:** [gateway and archive contract](OPTIONS_GATEWAY.md).
- **Forecast:** [Kronos setup](KRONOS_FORECAST.md); defaults to loopback. Change
  `KRONOS_URL` locally for your service, or set `KRONOS_ENABLED=false`.
- **External replay:** [public control protocol](EXTERNAL_REPLAY_CONTROL.md).
  A controller can be changed without changing the tape reader.
- **Position overlay:** set `TAPE_POSITION_STATUS_URL` to a loopback HTTP(S)
  status endpoint. Unset means disabled. The older explicit setting
  `TRADING_TOOLS_STATUS_URL` remains supported for compatibility. There is no
  hardcoded service address. Redirects and URL credentials are rejected.

The position adapter's GET response is deliberately small:

```json
{
  "ManagedSymbol": "TEST",
  "Position": {"symbol": "TEST", "quantity": -10, "average_price": "100.50"},
  "Stop": {"stop_price": "102.00"}
}
```

`Position` and `Stop` may be null; money can be a number or decimal string.
Only symbol, quantity, average cost, and stop reach the chart. Account metadata
and unrelated fields are discarded. `/api/trading-position` is loopback-only,
rejects foreign browser origins, and is not cacheable. An absent/unavailable
adapter hides the overlay; it cannot block tape or chart updates.

Before publishing changes, run `python3 scripts/check-public-tree.py`. This
checks tracked and unignored candidate files for common credential literals,
personal absolute paths, deployment addresses, private chat links, and local
data artifacts. It is a guard, not proof against every possible secret; review
the diff and keep credentials out of source files in the first place.
