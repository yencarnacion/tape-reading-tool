# Optional options gateway contract

No companion product is required by the tape reader. Implement this small
adapter using your own licensed provider, or prepare an offline archive. The
built-in live consumer understands Massive-compatible response fields; another
provider can map its data to these fields. Never fabricate unavailable fields.

Live options are disabled by default, independently of stock data. Set
`MASSIVE_OPTIONS_ENABLED=true` on the gateway and `TAPE_OPTIONS_ENABLED=true`
on the tape backend only with a suitable options subscription. If the tape
flag is unset, this backend falls back to `MASSIVE_OPTIONS_ENABLED`; an explicit
false or invalid tape flag disables options even when the shared flag is true.
The copied `.env.example` explicitly sets the tape flag to false. Restart the tape backend after changes.
Prepared IV/GEX replay archives do not require this live opt-in.

Set `TAPE_OPTIONS_GATEWAY_URL` to the adapter's API base (any path prefix works),
or use `MARKET_DATA_GATEWAY_URL` as the shared gateway fallback.
Only loopback HTTP(S) is accepted. URL credentials, queries, fragments,
redirects, external pagination, and API keys in pagination are rejected. The
optional `TAPE_OPTIONS_GATEWAY_TOKEN` is sent as `Authorization: Bearer …` only
to that local service. Provider credentials stay in the adapter.

## Live route

`GET {base}/rest/v3/snapshot/options/{symbol}`

The IV consumer sends `limit=250`, `sort=expiration_date`, `order=asc`, inclusive
`expiration_date.gte/lte` and `strike_price.gte/lte` bounds. Pagination may use
an opaque `cursor`. Return an object with `status: "OK"`, `results: [...]`, and
optional `next_url` **relative to the same gateway origin, with the full same
route path** (for example `/options/rest/v3/snapshot/options/AAPL?cursor=next`).
Use `status: "DELAYED"` for delayed data. HTTP 401/403, 404, 429, and 5xx are
handled as unavailable states; upstream error text is never sent to the browser.
HTTP 401/403 and `NOT_AUTHORIZED`/`NOT_ENTITLED` responses stop further snapshot
requests until restart. A denied flow feed is latched separately from snapshots.
`OPTIONS_DISABLED` or a flow `disabled` response disables all live options
requests until restart. Restore access/configuration before restarting.
Stocks, ADR, RVOL, and already prepared replay data remain independent.

Each result contains:

```json
{
  "details": {"ticker": "O:EXAMPLE", "expiration_date": "2026-07-31",
    "contract_type": "call", "strike_price": 100, "shares_per_contract": 100},
  "implied_volatility": 0.30,
  "greeks": {"delta": 0.5},
  "last_quote": {"bid": 2, "ask": 2.1,
    "last_updated": 1784899800000000000, "timeframe": "REAL-TIME"},
  "day": {"volume": 100}, "open_interest": 500
}
```

This is synthetic shape documentation, not a current quote. IV is a fraction,
not percentage points; timestamps are Unix **nanoseconds**. At least two nearby
strikes with calls **and** puts must pass the [quality gates](OPTIONS_VOLATILITY.md).
Do not label delayed quotes real-time. Missing data stays missing.

## Estimated GEX on the same route

The optional [Estimated GEX panel](ESTIMATED_GEX.md) makes a separate full-strike
request to this route, with both calls/puts and inclusive 0–30, 0–60 or 0–120
calendar-day expiry bounds. Do not force its request into the IV ATM basket.
It needs these additional fields alongside details and open interest:

```json
{
  "greeks": {"gamma": 0.02},
  "open_interest": 500,
  "underlying_asset": {"ticker": "EXAMPLE", "price": 100,
    "last_updated": 1784899800000000000, "timeframe": "REAL-TIME"}
}
```

This is synthetic shape documentation. Missing gamma/OI remains absent, not a
fabricated zero. OI is the prior trading-day value by provider convention; this
feed does not supply its reporting date. Underlying freshness is only a proxy
for Greek freshness, not a timestamp of the Greek calculation. Delayed/unknown
freshness, insufficient coverage or a truncated chain yields a neutral panel.
The gateway still owns provider credentials and relative pagination.
GEX replay uses its separately recorded normalized snapshot archive, not the
quote-derived IV archive below.

## Historical preparation routes

Only the explicit preparation helper uses these endpoints:

- `GET {base}/rest/v3/reference/options/contracts`: `underlying_ticker`, `as_of`,
  expiration and strike bounds, `sort`, `order`, `limit` (up to 1000), or `cursor`.
  Results contain `ticker`, `expiration_date`, `contract_type`, `strike_price`,
  and `shares_per_contract`.
- `GET {base}/rest/v3/quotes/{optionTicker}`: `timestamp.gte/lte` in Unix
  nanoseconds, `sort=timestamp`, `order=asc`, `limit=50000`, or `cursor`.
  Results contain `sip_timestamp`, `bid_price`, `ask_price`, `bid_size`, `ask_size`.

Both use the same `status/results/next_url` envelope and local pagination rule.
They require historical access from the provider. Playback never uses them.

## Offline archive contract

Place `{SYMBOL}-{YYYY-MM-DD}.json` in `TAPE_OPTIONS_REPLAY_DIR`. No gateway is
needed to replay it. Version 1 contains:

```json
{
  "schemaVersion": 1, "symbol": "TEST", "date": "2026-07-24",
  "startMS": 1784899800000, "endMS": 1784899805000,
  "method": "Synthetic example; never use as market data",
  "samples": [{
    "schemaVersion": 1, "symbol": "TEST", "estimated": true,
    "asOfMS": 1784899800000, "spot": 100, "status": "poor-quality",
    "contracts": []
  }]
}
```

Times are Unix **milliseconds**, dates use America/New_York, and the bounded
window is at most 6.5 hours. Samples are strictly increasing, at most 4,681 per
file and eight normalized contracts per sample; file size is at most 32 MiB.
Version 1 represents reconstructed IV, so `estimated: true` is required. It
cannot represent vendor-observed historical IV as an unlabeled estimate.

For `status: "ready"`, each normalized contract includes `ticker`, `expiry`,
`kind` (`call`/`put`), `strike`, `iv` (fraction), `delta`, `bid`, `ask`, `quoteMS`,
`timeframe: "HISTORICAL"`, `bidSize`, and `askSize`. Quote timestamps must be
positive and no later than their sample. Positive sizes replace unavailable
historical volume/OI. The normal paired-strike, freshness, and spread gates
still apply. `poor-quality` may include `quality` with `ivBid`, `ivAsk`,
`maxSpread` (fractions), and `contracts` (count); this only displays a range.

Seeks reconstruct samples no later than the server replay clock. Missing,
invalid, or out-of-window archives stay unavailable, without live fallback.
Keep archives, quote caches, and recordings under ignored `data/` or outside
this repository. `node scripts/options-ui-preview.mjs` supplies synthetic UI
examples without downloading or publishing personal session data.
