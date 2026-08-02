// Dependency-free validation of the Live Rewind buffer and of the one property
// the feature stands on: aggregate state recomputed at a sequence through the
// rewind source must equal the state the live path held at that same sequence.
// A rewound panel that disagrees with the live panel is a correctness bug that
// can be read as a trade signal, so the comparison here is exact, not tolerant.
//
//   node scripts/rewind-check.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const model = await import('../internal/server/web/tape-model.js');
const { createStreamSource } = await import('../internal/server/web/tape-source.js');
const { RewindBuffer, createRewindSource, rewindBufferBytes } = await import('../internal/server/web/tape-rewind.js');

const BASE_US = 1_784_726_400_000_000; // 2026-07-22 13:30:00Z, a fixed instant.

// Minute candles use exchange time while events arrive in receipt-time order.
// These are the three shapes observed in COIN on 2026-07-31: a report crossing
// the next minute, another ordinary print in the current minute, and a much
// older sale reported late. None may create a duplicate, near-empty candle.
{
  const bars = [];
  const trade = (marketUS, price, size) => ({ t: marketUS / 1000, p: price, z: size });
  const minute0 = BASE_US;
  const minute1 = minute0 + 60e6;
  model.appendMinuteBar(bars, trade(minute0 + 58e6, 100, 10));
  model.appendMinuteBar(bars, trade(minute1 + 200e3, 101, 20));
  model.appendMinuteBar(bars, trade(minute0 + 59e6, 100.5, 3));
  model.appendMinuteBar(bars, trade(minute1 + 500e3, 101.5, 30));

  assert.deepEqual(bars.map((bar) => bar.timeUS), [minute0, minute1], 'late boundary report keeps unique sorted minutes');
  assert.equal(bars[0].volume, 13, 'late boundary report merges into completed-minute volume');
  assert.equal(bars[0].close, 100.5, 'exchange-time order determines the completed-minute close');
  assert.equal(bars[1].volume, 50, 'current minute is not split after a late report');
  assert.equal(bars[1].close, 101.5, 'current-minute close continues normally');

  const oldMinute = minute0 - 14 * 60e6;
  model.appendMinuteBar(bars, trade(oldMinute + 3e6, 99, 874));
  assert.deepEqual(bars.map((bar) => bar.timeUS), [oldMinute, minute0, minute1], 'very late sale inserts at its exchange minute');
  assert.equal(new Set(bars.map((bar) => bar.timeUS)).size, bars.length, 'minute aggregation never duplicates a timestamp');
}

// Replay seek deliberately publishes one empty stream snapshot before the new
// range starts arriving. Every source accessor and rolling metric must remain
// valid during that frame so the browser animation loop can continue.
{
  const empty = createStreamSource({ trades: [], midpoints: [], prefixBase: {} });
  assert.equal(empty.firstSeq(), 0, 'empty stream first sequence');
  assert.equal(empty.lastSeq(), 0, 'empty stream last sequence');
  assert.equal(empty.firstReceivedUS(), 0, 'empty stream first receipt');
  assert.equal(empty.lastReceivedUS(), 0, 'empty stream last receipt');
  assert.equal(empty.oldestReceiptUS(), Infinity, 'empty stream receipt floor');
  assert.doesNotThrow(() => model.computeHorizon(empty, 5, BASE_US), 'empty replay snapshot metrics');
}

// A deterministic synthetic tape with the shape that makes rewind worth having:
// a quiet stretch, then a burst, with mixed classifications and sizes.
function makeTape(count, { startSeq = 1, gapAt = -1, gapLength = 0, stepUS = 4000 } = {}) {
  const trades = [];
  let seq = startSeq;
  let receipt = BASE_US;
  let price = 42.5;
  let state = 1103515245;
  const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let index = 0; index < count; index++) {
    if (index === gapAt) seq += gapLength; // the hole a LAGGED client leaves
    const burst = index % 900 > 700;
    receipt += burst ? 500 : stepUS;
    const roll = random();
    price += roll < 0.45 ? -0.01 : roll < 0.9 ? 0.01 : 0;
    price = Math.round(price * 100) / 100;
    const bid = Math.round((price - 0.01) * 100) / 100;
    const ask = Math.round((price + 0.01) * 100) / 100;
    const klass = roll < 0.1 ? 'below' : roll < 0.45 ? 'bid' : roll < 0.55 ? 'mid' : roll < 0.92 ? 'ask' : 'above';
    const side = klass === 'below' || klass === 'bid' ? -1 : klass === 'mid' ? (roll < 0.5 ? -1 : 1) : 1;
    trades.push({
      s: seq++, r: receipt, t: Math.floor(receipt / 1000 / 1000) * 1000,
      p: price, z: [1, 10, 100, 200, 500, 1000, 5000][Math.floor(random() * 7)],
      d: side, c: klass, b: bid, a: ask
    });
  }
  return trades;
}

// Mirrors exactly how app.js accumulates the live history: running prefix sums
// on the delivered trades, and a midpoint subset for midpoint movement.
function liveState(trades) {
  const state = { trades: [], midpoints: [], prefixBase: { volume: 0, buyer: 0, seller: 0, prints: 0 } };
  let volume = 0;
  let buyer = 0;
  let seller = 0;
  let prints = 0;
  for (const trade of trades) {
    const size = Math.max(0, Number(trade.z) || 0);
    volume += size;
    if (trade.d > 0) buyer += size;
    if (trade.d < 0) seller += size;
    prints++;
    trade._volume = volume;
    trade._buyer = buyer;
    trade._seller = seller;
    trade._prints = prints;
    state.trades.push(trade);
    if (trade.b > 0 && trade.a >= trade.b) state.midpoints.push(trade);
  }
  return state;
}

function fill(buffer, trades) {
  for (const trade of trades) buffer.push({ ...trade });
  return buffer;
}

// ---------------------------------------------------------------- eviction
{
  const trades = makeTape(4000);
  const buffer = fill(new RewindBuffer({ bufferSeconds: 5, maxPrintsPerSecond: 5000 }), trades);
  const newest = buffer.lastReceivedUS();
  assert.ok(buffer.count < trades.length, 'a 5 second buffer must not retain a longer tape');
  assert.ok(buffer.firstReceivedUS() >= newest - 5e6, 'the oldest retained event must be inside the window');
  const beforeFloor = trades.filter((trade) => trade.r < newest - 5e6);
  assert.ok(beforeFloor.length > 0, 'the fixture must actually exceed the window');
  assert.equal(buffer.firstSeq(), trades[beforeFloor.length].s, 'eviction must cut exactly at the receipt-time floor');
  assert.ok(Math.abs(buffer.retainedSeconds() - 5) < 0.01, `retained ${buffer.retainedSeconds()}s`);

  // Retention is by time, so a slow tape keeps far fewer events than capacity.
  const slow = fill(new RewindBuffer({ bufferSeconds: 60, maxPrintsPerSecond: 2000 }), makeTape(500));
  assert.equal(slow.count, 500, 'nothing inside the window may be evicted');
  assert.equal(slow.evictedByCapacity, false, 'the capacity bound must not fire inside the window');
}

// -------------------------------------------------------- capacity bound
{
  // A rate above the configured maximum must shorten the retained span
  // visibly rather than silently promise the configured duration.
  const buffer = new RewindBuffer({ bufferSeconds: 60, maxPrintsPerSecond: 100 });
  fill(buffer, makeTape(20000));
  assert.equal(buffer.count, buffer.capacity, 'the ring must saturate at capacity');
  assert.equal(buffer.evictedByCapacity, true, 'a capacity eviction must be recorded');
  assert.ok(buffer.retainedSeconds() < 60, `retained span ${buffer.retainedSeconds()}s must report the shortfall`);
}

// ------------------------------------------------------------ buffer floor
{
  const trades = makeTape(3000);
  const buffer = fill(new RewindBuffer({ bufferSeconds: 4, maxPrintsPerSecond: 5000 }), trades);
  const source = createRewindSource(buffer);
  assert.equal(source.seqAtOrBefore(buffer.firstReceivedUS() - 1), 0, 'a target below the floor must not resolve');
  assert.equal(source.at(buffer.firstSeq() - 1), null, 'an evicted sequence must not be readable');
  assert.equal(source.receivedUSAt(buffer.firstSeq()), buffer.firstReceivedUS());

  // A window that reaches past the floor must be reported as truncated so the
  // pane can refuse to display an understated number.
  const nowUS = buffer.lastReceivedUS();
  const inside = model.computeHorizon(source, 1, nowUS);
  const crossing = model.computeHorizon(source, 60, nowUS);
  assert.equal(inside.truncated, false, 'a window inside the buffer is not truncated');
  assert.equal(crossing.truncated, true, 'a window crossing the floor must be flagged');
  assert.equal(crossing.relativePace, null, 'pace without a baseline must stay unavailable');
}

// ------------------------------------------------------- sequence-gap holes
{
  const trades = makeTape(600, { gapAt: 300, gapLength: 40 });
  const buffer = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), trades);
  const missingFrom = trades[299].s + 1;
  const missingTo = trades[300].s - 1;
  assert.deepEqual(buffer.gapList, [[missingFrom, missingTo]], 'the discontinuity must be recorded exactly');
  assert.deepEqual(createRewindSource(buffer).gaps(1, buffer.lastSeq()), [[missingFrom, missingTo]]);
  assert.deepEqual(createRewindSource(buffer).gaps(1, missingFrom - 1), [], 'a window before the hole has no gap');

  // Without a backfill the range stays discontinuous, and says so.
  assert.equal(await createRewindSource(buffer).ensure(1, buffer.lastSeq()), false);
}

// ------------------------------------------------- backfill closes the hole
{
  const complete = makeTape(600);
  // The same tape as the client would have seen without falling behind.
  const delivered = complete.filter((trade) => trade.s < complete[300].s || trade.s > complete[339].s);
  const buffer = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), delivered);
  assert.equal(buffer.gapList.length, 1, 'the fixture must produce one hole');

  let pages = 0;
  const source = createRewindSource(buffer, {
    symbol: () => 'IREN',
    // Pages like /api/tape/range: bounded batches with next_seq_from.
    fetchRange: async (symbol, fromSeq, toSeq) => {
      assert.equal(symbol, 'IREN');
      pages++;
      const window = complete.filter((trade) => trade.s >= fromSeq && trade.s <= toSeq).slice(0, 16);
      const last = window.length ? window[window.length - 1].s : toSeq;
      return { trades: window, complete: last >= toSeq, next_seq_from: last + 1 };
    }
  });
  const filled = await source.ensure(complete[280].s, complete[360].s);
  assert.equal(filled, true, 'the range must be contiguous after backfill');
  assert.ok(pages >= 2, `paging must be exercised, got ${pages} page(s)`);
  assert.deepEqual(buffer.gapList, [], 'no hole may remain');
  assert.equal(buffer.count, complete.length, 'every event must be present exactly once');

  // The reassembled buffer must agree with a buffer that never lagged at all,
  // including its prefix sums, which is what a rewound panel reads.
  const pristine = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), complete);
  const pristineSource = createRewindSource(pristine);
  const nowUS = complete[560].r;
  for (const seconds of model.HORIZONS) {
    assert.deepStrictEqual(
      model.computeHorizon(source, seconds, nowUS),
      model.computeHorizon(pristineSource, seconds, nowUS),
      `backfilled ${seconds}s horizon must match a tape that never lagged`
    );
  }
}

// --------------------------------------------------------- determinism
// The single most important assertion in the feature.
{
  const trades = makeTape(30000);
  const live = liveState(trades);
  const liveSource = createStreamSource(live);
  const buffer = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), trades);
  const rewindSource = createRewindSource(buffer);
  assert.equal(buffer.count, trades.length, 'the buffer must retain the whole fixture for this comparison');

  for (const index of [120, 1500, 7777, 15000, 22222, 29999]) {
    const target = trades[index];
    const nowUS = target.r;
    assert.equal(rewindSource.seqAtOrBefore(nowUS), target.s, 'sequence lookup by receipt time');
    assert.equal(rewindSource.receivedUSAt(target.s), nowUS, 'receipt lookup by sequence');

    for (const seconds of model.HORIZONS) {
      const liveMetric = model.computeHorizon(liveSource, seconds, nowUS);
      const rewindMetric = model.computeHorizon(rewindSource, seconds, nowUS);
      assert.deepStrictEqual(rewindMetric, liveMetric,
        `rewound ${seconds}s horizon at sequence ${target.s} must equal the live state`);
    }
    assert.equal(
      model.computeTapeRate(rewindSource, nowUS),
      model.computeTapeRate(liveSource, nowUS),
      `tape rate at sequence ${target.s}`
    );

    // Tick bars: identical phase and identical bars when the tick size matches.
    for (const tickSize of [1, 10, 100]) {
      const liveBars = model.aggregateTickBars(liveSource, 1, target.s, tickSize);
      const rewindBars = model.aggregateTickBars(rewindSource, 1, target.s, tickSize);
      assert.deepStrictEqual(rewindBars, liveBars, `rewound ${tickSize}T bars at sequence ${target.s}`);
    }

    // The quote at the instant is the book the server saw for that print.
    assert.deepStrictEqual(rewindSource.quoteAt(target.s), { bid: target.b, ask: target.a });
  }
}

// ------------------------------- determinism after both stores have pruned
// The production condition: the live history has pruned its front and the ring
// has evicted by receipt time, so both sides are working from a rebased prefix.
// An off-by-one in either rebase would hide here and nowhere else.
{
  const trades = makeTape(20000);
  const live = liveState(trades);
  const liveSource = createStreamSource(live);
  // Exactly how app.js prunes: drop the front, rebase on the last removed trade.
  const removeCount = 6000;
  const lastRemoved = live.trades[removeCount - 1];
  live.prefixBase = {
    volume: lastRemoved._volume, buyer: lastRemoved._buyer,
    seller: lastRemoved._seller, prints: lastRemoved._prints
  };
  live.trades.splice(0, removeCount);
  const firstRetained = live.trades[0].s;
  live.midpoints = live.midpoints.filter((trade) => trade.s >= firstRetained);

  // A buffer whose receipt-time floor lands well after the live floor.
  const spanUS = trades[19999].r - trades[8000].r;
  const buffer = fill(new RewindBuffer({ bufferSeconds: spanUS / 1e6, maxPrintsPerSecond: 5000 }), trades);
  assert.ok(buffer.firstSeq() > firstRetained, 'the ring floor must be above the live floor for this case');
  assert.ok(buffer.prefixBase().volume > 0, 'the ring must have rebased its prefix');
  const rewindSource = createRewindSource(buffer);

  const nowUS = trades[19500].r;
  for (const seconds of model.HORIZONS) {
    // Only windows both stores fully cover can be compared; a window crossing a
    // floor is reported as truncated instead, which is asserted separately.
    if (buffer.firstReceivedUS() > nowUS - 2 * seconds * 1e6) continue;
    assert.deepStrictEqual(
      model.computeHorizon(rewindSource, seconds, nowUS),
      model.computeHorizon(liveSource, seconds, nowUS),
      `${seconds}s horizon must survive pruning on both sides`
    );
  }
  const target = trades[19500].s;
  assert.deepStrictEqual(
    model.aggregateTickBars(rewindSource, buffer.firstSeq(), target, 10),
    model.aggregateTickBars(liveSource, buffer.firstSeq(), target, 10),
    'bars aggregated from a common anchor must be identical after pruning'
  );
}

// --------------------------------------------------- rewind bar phase
// A rewound pane must show the bars the live pane showed at that sequence, not a
// differently-phased re-aggregation of the same prints. Live boundaries depend on
// where live aggregation started, which is the first delivered sequence and is
// not generally congruent to 1 modulo the tick size.
{
  const tickSize = 10;
  const visibleBars = 2;
  // A snapshot that begins at sequence 3, so live boundaries are 3, 13, 23, ...
  const trades = makeTape(60, { startSeq: 3 });
  const source = createStreamSource(liveState(trades));
  const liveBars = model.aggregateTickBars(source, 0, trades.at(-1).s, tickSize);
  assert.deepEqual(liveBars.slice(0, 3).map((bar) => bar.firstSeq), [3, 13, 23], 'live boundaries');

  const targetSeq = 25;
  const floorSeq = source.firstSeq();
  const start = model.rewindWindowStart({ liveBars, liveTickSize: tickSize, tickSize, targetSeq, floorSeq, visibleBars });
  const boundaries = liveBars.map((bar) => bar.firstSeq);
  assert.ok(boundaries.includes(start), `window start ${start} must be a live bar boundary`);
  assert.equal(start, 3, 'the window rounds down to the enclosing live boundary');

  // The bug this replaces: a plain offset back from the target starts mid-bar and
  // every bar in the pane is then shifted against live.
  const unanchored = Math.max(floorSeq, targetSeq - visibleBars * tickSize + 1);
  assert.equal(unanchored, 6, 'the unanchored formula lands mid-bar');
  assert.ok(!boundaries.includes(unanchored), 'the unanchored start is not a live boundary');
  assert.deepEqual(
    model.aggregateTickBars(source, unanchored, targetSeq, tickSize).map((bar) => bar.firstSeq),
    [6, 16],
    'the unanchored window produces shifted bars'
  );

  // Anchored, every rewound bar is identical to the live bar covering the same
  // sequences, including the one still forming at the target. The window is a
  // superset of the requested bars; the renderer keeps the trailing visibleBars.
  const rewound = model.aggregateTickBars(source, start, targetSeq, tickSize);
  const live = liveBars.filter((bar) => bar.firstSeq >= start && bar.firstSeq <= targetSeq);
  assert.equal(rewound.length, live.length, 'bar count at the rewound instant');
  assert.ok(rewound.length >= visibleBars, 'the window must cover at least the visible bars');
  for (let index = 0; index < rewound.length - 1; index++) {
    assert.deepStrictEqual(rewound[index], live[index], `completed bar ${index} must match live exactly`);
  }
  const formingLive = model.aggregateTickBars(source, live.at(-1).firstSeq, targetSeq, tickSize).at(-1);
  assert.deepStrictEqual(rewound.at(-1), formingLive, 'the forming bar must match what live showed at that sequence');
  assert.equal(rewound.at(-1).firstSeq, 23, 'the forming bar starts on the live boundary');
  assert.equal(rewound.at(-1).count, targetSeq - 23 + 1, 'the forming bar holds only prints up to the target');

  // A boundary evicted from the buffer must not produce a partial leading bar.
  const raisedFloor = 15;
  assert.equal(
    model.rewindWindowStart({ liveBars, liveTickSize: tickSize, tickSize, targetSeq, floorSeq: raisedFloor, visibleBars }),
    23,
    'a boundary below the buffer floor must be skipped forward, not sliced'
  );
  // A different granularity has no live phase to match.
  assert.equal(
    model.rewindWindowStart({ liveBars, liveTickSize: 1, tickSize, targetSeq, floorSeq, visibleBars }),
    6,
    'a re-aggregation at another granularity uses the plain window'
  );
  assert.equal(
    model.rewindWindowStart({ liveBars: [], liveTickSize: tickSize, tickSize, targetSeq, floorSeq, visibleBars }),
    6,
    'no live bars means no anchor'
  );
}

// ----------------------------------------- independent bar granularity
{
  const trades = makeTape(5000);
  const buffer = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), trades);
  const source = createRewindSource(buffer);
  const target = trades[4999].s;
  const fine = model.aggregateTickBars(source, 1, target, 1);
  const coarse = model.aggregateTickBars(source, 1, target, 100);
  assert.equal(fine.length, 5000, 'a 1T re-aggregation must produce one bar per print');
  assert.equal(coarse.length, 50, 'a 100T re-aggregation of the same window must produce 50 bars');
  assert.equal(
    coarse.reduce((total, bar) => total + bar.volume, 0),
    fine.reduce((total, bar) => total + bar.volume, 0),
    're-aggregating at a different granularity must conserve volume'
  );
  // Bar phase is anchored on a sequence, so a coarse bar starts where the live
  // pane would have started one.
  assert.equal(coarse[0].firstSeq, fine[0].firstSeq);
  assert.equal(coarse[1].firstSeq, fine[100].firstSeq);
}

// ------------------------------------------------- forming minute and RVOL
{
  // Spaced so the fixture spans several minutes: the forming candle can only be
  // trusted when the buffer also holds the print that opened it.
  const trades = makeTape(6000, { stepUS: 40000 });
  const buffer = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), trades);
  const source = createRewindSource(buffer);
  const target = trades[5000];
  const forming = source.formingMinuteAt(target.s);
  assert.ok(forming && forming.complete, 'the forming minute must be complete inside a 600s buffer');
  const expected = trades
    .filter((trade) => trade.s <= target.s && Math.floor(trade.t / 60000) === Math.floor(target.t / 60000))
    .reduce((total, trade) => total + trade.z, 0);
  assert.equal(forming.bar.volume, expected, 'the forming candle volume must be recomputed for the instant');
  assert.equal(forming.bar.close, target.p);

  // With a floor inside the forming minute, RVOL has to stay unavailable.
  const shallow = fill(new RewindBuffer({ bufferSeconds: 5, maxPrintsPerSecond: 5000 }), trades);
  const shallowSource = createRewindSource(shallow);
  const shallowForming = shallowSource.formingMinuteAt(shallow.lastSeq());
  assert.equal(shallowForming.complete, false, 'a floor inside the minute must be reported');
}

// -------------------------------------------------------- documented size
{
  assert.equal(rewindBufferBytes(180, 2000), 180 * 2000 * 82, 'the documented worst case must hold');
  const buffer = new RewindBuffer({ bufferSeconds: 180, maxPrintsPerSecond: 2000 });
  assert.equal(buffer.capacity, 360000);
  assert.equal(buffer.bytes, 29520000);
  const measured = [buffer.seq, buffer.receivedUS, buffer.exchangeMS, buffer.price, buffer.size, buffer.bid,
    buffer.ask, buffer.prefixVolume, buffer.prefixBuyer, buffer.prefixSeller, buffer.side, buffer.klass]
    .reduce((total, column) => total + column.byteLength, 0);
  assert.equal(measured, buffer.bytes, `columns measure ${measured}B, documented ${buffer.bytes}B`);
}

// ------------------------------------------------- shared-model golden values
// The stream source is what live mode and historical replay both read, so these
// pinned values are what "replay output is unchanged" means on the browser side.
// They were verified equal, comparison by comparison, against the pre-refactor
// implementation of calculateHorizon, totalsBetween, addTradeToBars,
// calculateCurrentCandleRVOL, and updatePriceScale on identical input.
{
  const trades = makeTape(2000);
  const source = createStreamSource(liveState(trades));
  const nowUS = trades[1800].r;
  assert.deepStrictEqual(model.computeHorizon(source, 5, nowUS), {
    volume: 1538551, buyer: 745171, seller: 793380, prints: 1599, delta: -48209,
    deltaPercent: -3.1334027926276082, sharesRate: 307710.2, printsRate: 319.8,
    midTicks: -58.99999999999963, relativePace: null, truncated: false
  }, 'the 5 second horizon must not drift');
  assert.deepStrictEqual(model.computeHorizon(source, 15, nowUS), {
    volume: 1740973, buyer: 837741, seller: 903232, prints: 1801, delta: -65491,
    deltaPercent: -3.7617470230727297, sharesRate: 116064.86666666667, printsRate: 120.06666666666666,
    midTicks: -39.00000000000006, relativePace: null, truncated: true
  }, 'the 15 second horizon must not drift');
  assert.equal(model.computeTapeRate(source, nowUS), 425, 'the one-second tape rate must not drift');
  assert.deepStrictEqual(
    [1, 10, 100].map((tickSize) => model.aggregateTickBars(source, 1, trades[1800].s, tickSize).length),
    [1801, 181, 19],
    'tick-bar counts must not drift'
  );
  const lastBar = model.aggregateTickBars(source, 1, trades[1800].s, 10).at(-1);
  assert.deepStrictEqual(lastBar, {
    count: 1, open: 42.12, high: 42.12, low: 42.12, close: 42.12, volume: 10, delta: -10,
    time: 1784726405000, received: 1784726405811000, className: 'below', firstSeq: 1801
  }, 'the forming tick bar must not drift');
  // The price-scale hysteresis the live and replay panes share.
  const initial = model.updatePriceScale(null, 99, 101, 0);
  const expanded = model.updatePriceScale(initial, 94, 101, 10);
  const candidate = model.updatePriceScale(expanded, 99, 101, 20);
  assert.equal(expanded.minimum, 94, 'expansion must be immediate');
  assert.equal(model.updatePriceScale(candidate, 99, 101, 1000).minimum, 94, 'contraction must wait');
  const direct = model.updatePriceScale(candidate, 99, 101, 2720);
  const split = model.updatePriceScale(model.updatePriceScale(candidate, 99, 101, 1520), 99, 101, 2720);
  assert.ok(Math.abs(direct.minimum - split.minimum) < 1e-9, 'contraction must not depend on frame rate');
}

// --------------------------------------------------------- rewind emits no audio
// Structural, not behavioural: the rewind modules and the rewind section of
// app.js must not be able to reach the audio path at all. The AudioWorklet is a
// live-state signal; replayed prints must never enter it.
{
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  // Comments discuss the audio path deliberately; code must not touch it.
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const path of ['../internal/server/web/tape-rewind.js', '../internal/server/web/tape-model.js', '../internal/server/web/tape-source.js']) {
    assert.ok(!/audio/i.test(code(read(path))), `${path} must not reference the audio path`);
  }
  const app = read('../internal/server/web/app.js');
  const section = app.slice(app.indexOf('// ------------------------------------------------------------- Live Rewind'), app.indexOf('function animationLoop'));
  assert.ok(section.length > 2000, 'the Live Rewind section was not found');
  assert.ok(!/audio\s*\.\s*(push|setTapeRate|start|sync|setEnabled)/.test(section),
    'the Live Rewind section must never call into the audio mixer');
  assert.ok(/ears live, eyes rewound/i.test(section), 'the audio rationale must stay documented in the code');
}

// ------------------------------------------------------------- benchmarks
// Section 6 budgets: recompute under 8ms, seek plus full pane re-aggregation
// under 100ms at 30000 buffered events.
function measure(label, iterations, run) {
  run();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) run();
  const each = (performance.now() - started) / iterations;
  console.log(`  ${label}: ${each.toFixed(3)} ms`);
  return each;
}

{
  const trades = makeTape(30000);
  const buffer = fill(new RewindBuffer({ bufferSeconds: 600, maxPrintsPerSecond: 2000 }), trades);
  const source = createRewindSource(buffer);
  assert.equal(buffer.count, 30000);
  const targetSeq = trades[29000].s;
  const nowUS = trades[29000].r;
  const floorSeq = buffer.firstSeq();

  console.log('rewind benchmarks at 30000 buffered events:');
  const recompute = measure('aggregate recompute (3 horizons + baselines + forming minute)', 200, () => {
    for (const seconds of model.HORIZONS) model.computeHorizon(source, seconds, nowUS);
    model.computeTapeRate(source, nowUS);
    source.formingMinuteAt(targetSeq);
    source.quoteAt(targetSeq);
  });
  const seek = measure('seek + 360 visible bars at 1T', 100, () => {
    for (const seconds of model.HORIZONS) model.computeHorizon(source, seconds, nowUS);
    model.aggregateTickBars(source, targetSeq - 360, targetSeq, 1);
  });
  const worst = measure('whole-buffer re-aggregation at 1000T', 50, () => {
    model.aggregateTickBars(source, floorSeq, targetSeq, 1000);
  });
  const push = measure('10000 pushes with eviction', 20, () => {
    const ring = new RewindBuffer({ bufferSeconds: 5, maxPrintsPerSecond: 2000 });
    for (let index = 0; index < 10000; index++) ring.push(trades[index]);
  }) / 10000;

  assert.ok(recompute < 8, `aggregate recompute ${recompute.toFixed(3)}ms exceeds the 8ms budget`);
  assert.ok(seek < 100, `seek ${seek.toFixed(3)}ms exceeds the 100ms budget`);
  assert.ok(worst < 100, `worst-case re-aggregation ${worst.toFixed(3)}ms exceeds the 100ms budget`);
  assert.ok(push < 0.002, `${(push * 1000).toFixed(1)}us per push is too slow for the delivery path`);
  console.log(`  keyframes are unnecessary: recompute is ${(8 / recompute).toFixed(0)}x inside the 8ms budget`);
}

console.log('rewind check: eviction, gaps, backfill, determinism, and budgets passed');
