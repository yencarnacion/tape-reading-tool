# Gexbot context on trading charts

The **GB ON** control enables Gexbot on the main Related charts and Tape Reading
Tool's one-minute chart. It starts on for a new installation/profile. Toggling it
or changing expiry scope saves the choice. Mini charts retain their compact stock
price display. The existing Massive **GEX** overlay remains a separate estimate.

## Reading the display

- **Purple dotted** levels: nearest expiry. **Blue dashed**: next expiry.
  The date is shown, so a weekly next expiry is not mislabeled “tomorrow.”
  Choose Near + next, Nearest, Next, or 0–90D.
- **SUPPORT? / RESIST?**: concentrations below/above current price worth watching
  for a reaction. **MAGNET?**: the strongest nearby concentration in the 60-second
  options-flow direction. These roles are display heuristics, not verified dealer
  inventory, guaranteed defenses, or targets.
- **◆ / ◆◆ / ◆◆◆**: magnitude relative to that expiry's largest concentration
  (15–30%, 30–60%, 60–100%). This is level strength, not a chance of success.
- **↑ BUYING PRESSURE / ↓ SELLING PRESSURE**: the sign of new classified
  transaction delta over 60 seconds. A conflicting 15-second window produces
  **MIXED FLOW**. Compare the displayed 15s, 60s and 5m values.
- **Strong / Some / Low agreement** describes consistency across the time windows
  and within their flows. Opposing expiries reduce agreement. It is not a
  calibrated forecast probability. For example, negative options flow can occur
  while stock price rises; use it as context alongside price and tape.

Hover the compact flow strip or a level for detail. ΔDEX retains the provider's
native numerical units; it is not stock volume or dollars spent buying shares.
The source profile is Gexbot **State classified gamma imbalance**, which is
different from the calls-positive/puts-negative assumption in the older GEX tool.
The State spline center is not presented as a confirmed dealer gamma flip.

Only the three strongest qualifying concentrations per expiry within 5% of spot
are considered. The candidate magnet must be within 3%. Off-screen levels do not
stretch the price axis. Profiles older than 15 seconds or more than 2% away from
the stock's observed price are withheld.

## Live and replay

Live requests poll every two seconds for the visible selected charts, during
09:30–16:00 ET. Multiple browser requests for the same ticker share a bundle in
each app. This integration uses REST snapshots, not the Quant sub-second socket.
The complete strike profiles and cumulative transaction delta are saved to
`data/gexbot/YYYY-MM-DD/SYMBOL/`. No all-universe background scan runs.

Replay reads the latest source observation at or before its clock. For live
recordings, receipt time must also be at or before that clock. Seeking backward
cancels older requests, and missing/stale windows are unknown rather than zero.
15s/60s/5m flow is the change in **agg_dex / one_agg_dex**, not changes in chain
net exposure. Flow windows need a sufficiently complete timeline.

When a previous day's selected chart lacks history, a configured subscription
automatically downloads and imports that date's State and Orderflow archives.
Provider downloads live separately under `data/gexbot/history/`, so partial live
recordings remain intact. Earlier missing periods and incomplete flow windows can
use that historical fallback. The strip says **DOWNLOADING GEXBOT HISTORY** while preparing. Unavailable history
is explicit and retries are limited. Replays never substitute today's chain.
Imported history is labeled **HISTORICAL MODEL** because it is a later provider
reconstruction, not proof of exactly what arrived live on the original day.

New Related session recordings include the displayed Gexbot view, settings and
levels with the chart frame. Session replay preserves that recorded view. For
older chart frames without Gexbot fields, it adds dated historical context when
available. It cannot recover an entirely unrecorded Related screen; use the
existing historical chart reconstruction in that case.

The MP4 exporter includes these overlays from already prepared local archives.
It uses a persistent offline reader and never contacts Gexbot. Its resume
fingerprint includes the Gexbot input files. Open a dated replay first to prepare
missing history, or use the download/import tools below.

## Configuration

Store secrets only in private, Git-ignored `.env` files:

```dotenv
GEXBOT_ENABLED=true
GEXBOT_API_KEY=your_private_key
# Optional; default is data/gexbot within each app:
# GEXBOT_ARCHIVE_DIR=/absolute/archive/path
# Optional shared historical archive; live captures stay in the app's own dir:
# GEXBOT_HISTORY_DIR=/path/to/daidai/data/gexbot
```

The key stays server-side. It goes only to the official API, never to the browser
or the signed Azure storage download. Already stored archives remain readable
with live requests disabled. Existing Massive options flags are independent.
Archives are not automatically pruned by this feature; include them in ordinary
data retention/backup maintenance if needed.

In the DaiDai repository, manual preparation is also available in Go:

```bash
go run ./cmd/gexbot-download --date 2026-11-13 --symbols SNDK,QQQ
```

This command downloads and imports all four categories for each ticker using the
same Go code as automatic replay preparation. It reads the private `.env`, keeps
existing archives, and writes under the configured history root's `history/`
directory. Use `--dir /path/to/archive-root` to override that root. The Gexbot
integration has no Python dependency.

To import an already downloaded raw gzip archive separately:

```bash
go run ./cmd/gexbot-import --date 2026-11-13 --symbol SNDK --kind gex_zero \
  --input data/gexbot-downloads/2026-11-13/SNDK_state_gex_zero.json.gz
```

With the separate importer, import each of `gex_zero`, `gex_one`, `gex_full`, and
`orderflow` for each ticker. Imports are atomic and refuse to overwrite an existing
recording. Neither command prints credentials or signed download URLs.

## Validation

Unit tests cover live request coalescing, recording/replay parity, receipt-time
causality, gaps, redirects/authentication separation, dated history preparation,
backward seeks, actual expiry dates, direction and agreement. Friday November 13,
2026 SNDK and QQQ archives were also checked with forward/backward replay clocks.
The market was closed during implementation, so live behavior was tested with
controlled HTTP fixtures; subscription access and historical downloads used the
real API.

```bash
go test -race ./internal/gexbot
node --test scripts/gexbot-context.test.cjs
GEXBOT_VALIDATE_ARCHIVE="$PWD/data/gexbot" go test ./internal/gexbot -run TestFridayActualArchives
```

Sources: [State profile semantics](https://docs.gexbot.com/state/gexprofile/),
[State API fields](https://docs.gexbot.com/apidocs/state/state-chain/),
[aggregate transaction delta](https://docs.gexbot.com/orderflow/aggregatedex/),
[historical downloads](https://docs.gexbot.com/apidocs/quant/historical-download/).
