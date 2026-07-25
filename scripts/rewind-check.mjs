// Dependency-free validation of the Live Rewind buffer and of the one property
// the feature stands on: aggregate state recomputed at a sequence through the
// rewind source must equal the state the live path held at that same sequence.
// A rewound panel that disagrees with the live panel is a correctness bug that
// can be read as a trade signal, so the comparison here is exact, not tolerant.
//
//   node scripts/rewind-check.mjs

import assert from 'node:assert/strict';

const model = await import('../internal/server/web/tape-model.js');
const { createStreamSource } = await import('../internal/server/web/tape-source.js');
const { RewindBuffer, createRewindSource, rewindBufferBytes } = await import('../internal/server/web/tape-rewind.js');

const BASE_US = 1_784_726_400_000_000; // 2026-07-22 13:30:00Z, a fixed instant.

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
