import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRENDLINE_LIMITS, packClosedBars, wilderATR, pivotStrengths, zigZag,
  evaluateTrendline, linesConflict, computeAutoTrendlines, drawAutoTrendlines
} from '../internal/server/web/auto-trendlines.js';
import { AutoTrendlinesController, TRENDLINE_STORAGE_KEY } from '../internal/server/web/auto-trendlines-controller.js';

const T0 = 1_700_000_000_000_000;
function bars(n, wave = true) {
  return Array.from({ length: n }, (_, i) => {
    const p = wave ? 100 + 0.003 * i + 2 * Math.sin(i * Math.PI / 10) + 5 * Math.sin(i * Math.PI / 150) : 12;
    return { timeUS: T0 + i * 60e6, open: p, high: p + 0.2, low: p - 0.2, close: p, volume: 1000 };
  });
}
function packedAll(items) { return packClosedBars([...items, { ...items.at(-1), timeUS: (items.at(-1)?.timeUS || T0) + 60e6 }]); }

// Algorithm and resource bounds.
test('closed-bar packing excludes forming candle, caps 5000, and never mutates input', () => {
  const input = bars(6001), saved = structuredClone(input);
  input.at(-1).high = 999999;
  const packed = packClosedBars(input);
  assert.equal(packed.length, 20000);
  assert.equal(packed.byteLength, 160000);
  assert.equal(packed[0], input[1000].timeUS);
  assert.equal(packed.at(-4), input[5999].timeUS);
  input.at(-1).high = saved.at(-1).high;
  assert.deepEqual(input, saved);
});
test('Wilder ATR warmup and subsequent recurrence', () => {
  const input = bars(15, false).map((b) => ({ ...b, high: 100, low: 98, close: 99 }));
  input[14] = { ...input[14], high: 104, low: 100, close: 102 };
  const atr = wilderATR(packedAll(input));
  assert.ok(Number.isNaN(atr[12]));
  assert.equal(atr[13], 2);
  assert.equal(atr[14], 31 / 14);
});
test('pivot requires its full right-hand confirmation and resolves plateaus to the right', () => {
  const input = bars(50, false);
  input[20].high = 20;
  assert.equal(pivotStrengths(packedAll(input.slice(0, 25)), true)[20], 4);
  assert.equal(pivotStrengths(packedAll(input.slice(0, 26)), true)[20], 5);
  input[21].high = 20;
  const strengths = pivotStrengths(packedAll(input), true);
  assert.equal(strengths[20], 0);
  assert.ok(strengths[21] >= 5);
});
test('flat market creates no trendlines', () => {
  const result = computeAutoTrendlines(packClosedBars(bars(5001, false)));
  assert.equal(result.lines.length, 0);
  assert.equal(result.stats.candidates, 0);
});
test('ZigZag alternates and filters swings using ATR at the preceding anchor', () => {
  const input = packedAll(bars(80, false)), atr = new Float64Array(80).fill(1);
  const highs = new Uint16Array(80), lows = new Uint16Array(80);
  for (const [i, p] of [[15, 10], [35, 9], [65, 10]]) { lows[i] = 5; input[i * 4 + 2] = p; }
  for (const [i, p] of [[25, 11], [45, 15]]) { highs[i] = 5; input[i * 4 + 1] = p; }
  const result = zigZag(input, atr, highs, lows, 5, 2);
  assert.deepEqual(result.map((p) => [p.index, p.side]), [[35, 1], [45, -1], [65, 1]]);
});
function candidateFixture(n = 45) {
  const data = packedAll(bars(n, false)), atr = new Float64Array(n).fill(1);
  const strengths = new Uint16Array(n);
  strengths[15] = 5; strengths[25] = 5;
  data[15 * 4 + 2] = 10; data[25 * 4 + 2] = 10;
  return { data, atr, strengths, a: { index: 15, price: 10, side: 1, strength: 5 }, b: { index: 25, price: 10, side: 1, strength: 5 } };
}
function evaluate(f) { return evaluateTrendline(f.data, f.atr, f.strengths, f.a, f.b, 'small'); }
function lowerClose(f, i) { f.data[i * 4 + 1] = 10; f.data[i * 4 + 2] = 8; f.data[i * 4 + 3] = 9; }
test('breakout requires three consecutive closes; an intervening recovery resets it', () => {
  const f = candidateFixture();
  [30, 31, 33, 34, 35].forEach((i) => lowerClose(f, i));
  const line = evaluate(f);
  assert.equal(line.broken, true);
  assert.equal(line.breakTimeUS, f.data[35 * 4]);
  assert.equal(line.end, 35);
  assert.equal(line.extend, true);
});
test('two closes alone do not break a line', () => {
  const f = candidateFixture(); [30, 31].forEach((i) => lowerClose(f, i));
  assert.equal(evaluate(f).broken, false);
});
test('base cannot span a confirmed break or an equally strong interior touch', () => {
  const f = candidateFixture(); [19, 20, 21].forEach((i) => lowerClose(f, i));
  assert.equal(evaluate(f), null);
  const g = candidateFixture(); g.strengths[20] = 5; g.data[20 * 4 + 2] = 10;
  assert.equal(evaluate(g), null);
  g.strengths[20] = 3;
  assert.equal(evaluate(g).touches, 3);
});
test('extension older than two base lengths becomes base-only', () => {
  const line = evaluate(candidateFixture(80));
  assert.equal(line.extend, false);
  assert.equal(line.end, 25);
  assert.equal(evaluate(candidateFixture()).extend, true);
});
test('unconfirmed second anchor is rejected', () => assert.equal(evaluate(candidateFixture(30)), null));
test('overlap filtering respects direction, geometry, and the strict 30% threshold', () => {
  const a = { side: 'support', a: 0, b: 100, aPrice: 10, slope: 0, zone: 0.2 };
  assert.equal(linesConflict(a, { ...a, aPrice: 10.1 }), true);
  assert.equal(linesConflict(a, { ...a, side: 'resistance' }), false);
  assert.equal(linesConflict(a, { ...a, a: 70, b: 170 }), false);
  assert.equal(linesConflict(a, { ...a, aPrice: 20 }), false);
});
test('deterministic analysis obeys all hard bounds and produces both line scales', () => {
  const data = packClosedBars(bars(5001));
  const a = computeAutoTrendlines(data), b = computeAutoTrendlines(data);
  assert.deepEqual(a, b);
  assert.ok(a.lines.length > 0);
  assert.ok(a.lines.length <= TRENDLINE_LIMITS.lines);
  assert.ok(a.stats.candidates <= 4 * 24 * 23 / 2);
  assert.ok(a.lines.some((line) => line.size === 'small'));
  assert.ok(a.lines.some((line) => line.size === 'large'));
  for (const size of ['small', 'large']) for (const side of ['support', 'resistance'])
    assert.ok(a.lines.filter((line) => line.size === size && line.side === side).length <= 3);
  for (const line of a.lines) {
    assert.ok(Number.isFinite(line.slope));
    assert.ok(line.aTimeUS < line.bTimeUS);
    assert.ok(line.confirmedAtUS <= data.at(-4));
    assert.ok(line.breakTimeUS === null || line.breakTimeUS <= data.at(-4));
  }
});
test('replay prefixes cannot acquire future pivots or breakout timestamps', () => {
  const input = bars(900);
  const early = computeAutoTrendlines(packClosedBars(input.slice(0, 450)));
  for (let i = 450; i < input.length; i++) input[i].high *= 100;
  assert.deepEqual(computeAutoTrendlines(packClosedBars(input.slice(0, 450))), early);
  assert.ok(early.lines.every((l) => l.confirmedAtUS <= input[448].timeUS));
});
test('invalid data fails explicitly; short histories are harmless', () => {
  assert.deepEqual(computeAutoTrendlines(new Float64Array()).lines, []);
  assert.throws(() => computeAutoTrendlines(new Float64Array(5)), TypeError);
  for (const bad of [NaN, Infinity, -1]) {
    const data = packClosedBars(bars(100)); data[2] = bad;
    assert.throws(() => computeAutoTrendlines(data), RangeError);
  }
  const data = packClosedBars(bars(100)); data[4] = data[0];
  assert.throws(() => computeAutoTrendlines(data), RangeError);
});
test('drawing uses bar indexes across time gaps, clips the pane, and restores context', () => {
  const input = bars(5, false); input[2].timeUS += 5e6;
  const calls = [];
  const ctx = Object.fromEntries(['save', 'restore', 'beginPath', 'rect', 'clip', 'setLineDash', 'moveTo', 'lineTo', 'stroke']
    .map((name) => [name, (...args) => calls.push([name, ...args])]));
  drawAutoTrendlines(ctx, [{ aTimeUS: input[0].timeUS, bTimeUS: input[2].timeUS, endTimeUS: input[4].timeUS,
    aPrice: 10, bPrice: 12, side: 'support', size: 'large', extend: true, broken: false }],
  { bars: input, start: 0, xAt: (i) => i * 10, priceY: (p) => 100 - p, left: 0, right: 100, top: 0, bottom: 100 });
  assert.deepEqual(calls.find((c) => c[0] === 'lineTo'), ['lineTo', 100, 80]);
  assert.ok(calls.some((c) => c[0] === 'clip'));
  assert.equal(calls.at(-1)[0], 'restore');
});

// Browser-controller tests use injected workers/timers: no sleeps or network.
function harness(saved = null, workerError = false) {
  const workers = [], timers = new Map(), values = new Map(saved ? [[TRENDLINE_STORAGE_KEY, saved]] : []);
  let time = 0, nextTimer = 0, redraws = 0;
  const listeners = new Map();
  const button = { textContent: '', attrs: {}, classList: { toggle() {} },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type),
    setAttribute(name, value) { this.attrs[name] = value; } };
  const docEvents = new Map(), hostEvents = new Map();
  const doc = { hidden: false, addEventListener: (t, fn) => docEvents.set(t, fn), removeEventListener: (t) => docEvents.delete(t) };
  const host = { addEventListener: (t, fn) => hostEvents.set(t, fn), removeEventListener: (t) => hostEvents.delete(t) };
  const controller = new AutoTrendlinesController({ button, document: doc, host,
    storage: { getItem: (key) => values.get(key), setItem: (key, v) => values.set(key, v) },
    now: () => time, redraw: () => redraws++,
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    workerFactory: () => {
      if (workerError) throw new Error('CSP blocked worker');
      const worker = { posts: [], terminated: false, postMessage(message) { this.posts.push(message); }, terminate() { this.terminated = true; } };
      workers.push(worker); return worker;
    }
  });
  const reply = (worker, index = 0, tag = 'line') => worker.onmessage({ data: { id: worker.posts[index].id,
    result: { lines: [{ tag }], stats: { bars: 180 } }, elapsedMS: 2 } });
  const advance = (ms) => { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } };
  return { controller, workers, timers, values, button, listeners, doc, docEvents, hostEvents, reply, advance, redraws: () => redraws };
}
test('default is ON, preference persists, and OFF does no computation', () => {
  const h = harness(); assert.equal(h.controller.enabled, true);
  assert.equal(h.button.attrs['aria-pressed'], 'true');
  h.controller.setEnabled(false); h.controller.update(bars(181), 'QQQ');
  assert.equal(h.workers.length, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.values.get(TRENDLINE_STORAGE_KEY), 'off');
  assert.equal(harness('off').controller.enabled, false);
});
test('thousands of intrabar updates never resubmit an unchanged closed history', () => {
  const h = harness(), input = bars(181);
  h.controller.update(input, 'QQQ');
  for (let i = 0; i < 2000; i++) { input.at(-1).high += 0.001; h.controller.update(input, 'QQQ'); }
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].posts.length, 1);
  h.reply(h.workers[0]);
  for (let i = 0; i < 100; i++) h.controller.update(input, 'QQQ');
  assert.equal(h.workers[0].posts.length, 1); assert.equal(h.timers.size, 0);
});
test('busy worker coalesces updates and discards an outdated result', () => {
  const h = harness(), input = bars(181);
  h.controller.update(input, 'QQQ');
  for (let i = 0; i < 10; i++) {
    input.push({ ...input.at(-1), timeUS: input.at(-1).timeUS + 60e6 }); h.controller.update(input, 'QQQ');
  }
  const w = h.workers[0]; assert.equal(w.posts.length, 1);
  h.reply(w); assert.equal(h.controller.lines.length, 0); assert.equal(h.timers.size, 1);
  h.advance(1000); assert.equal(w.posts.length, 2);
  h.reply(w, 1, 'latest'); assert.equal(h.controller.lines[0].tag, 'latest');
});
test('ticker switch / history replacement / backward seek reject stale worker replies', () => {
  const h = harness(); h.controller.update(bars(500), 'QQQ', 'replay');
  const old = h.workers[0];
  h.controller.update(bars(180), 'AAPL', 'replay');
  assert.equal(old.terminated, true); h.reply(old, 0, 'future');
  assert.equal(h.controller.lines.length, 0);
  h.reply(h.workers[1], 0, 'new'); assert.equal(h.controller.lines[0].tag, 'new');
});
test('OFF terminates worker, drops queued work, and ignores its late response', () => {
  const h = harness(); h.controller.update(bars(181), 'QQQ'); const w = h.workers[0];
  h.controller.setEnabled(false); h.reply(w);
  assert.equal(w.terminated, true); assert.equal(h.controller.lines.length, 0); assert.equal(h.timers.size, 0);
});
test('late-print invalidation preserves the one-second computation throttle', () => {
  const h = harness(), input = bars(181); h.controller.update(input, 'QQQ'); h.reply(h.workers[0]);
  h.controller.invalidate(); input[100].high += 1; h.controller.update(input, 'QQQ');
  assert.equal(h.workers.length, 1); assert.equal(h.timers.size, 1);
  h.advance(1000); assert.equal(h.workers.length, 2);
});
test('hidden page and inactive chart release work; bfcache restore can redraw', () => {
  const h = harness(), input = bars(181); h.controller.update(input, 'QQQ');
  h.doc.hidden = true; h.docEvents.get('visibilitychange')();
  assert.equal(h.workers[0].terminated, true); h.controller.update(input, 'QQQ'); assert.equal(h.workers.length, 1);
  h.doc.hidden = false; h.docEvents.get('visibilitychange')(); h.controller.update(input, 'QQQ');
  assert.equal(h.workers.length, 2);
  h.hostEvents.get('pagehide')(); assert.equal(h.workers[1].terminated, true);
  h.hostEvents.get('pageshow')(); h.controller.update(input, 'QQQ'); assert.equal(h.workers.length, 3);
  h.controller.setActive(false); assert.equal(h.workers[2].terminated, true);
});
test('worker failure leaves the chart usable and does not create a retry loop', () => {
  const h = harness(null, true), input = bars(181); h.controller.update(input, 'QQQ');
  for (let i = 0; i < 100; i++) h.controller.update(input, 'QQQ');
  assert.equal(h.controller.failed, true); assert.equal(h.timers.size, 0);
  assert.equal(h.controller.lines.length, 0); assert.match(h.button.title, /unavailable/);
});
test('blocked localStorage falls back to ON and does not break the toggle', () => {
  const c = new AutoTrendlinesController({ document: null, host: null,
    storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  assert.equal(c.enabled, true); assert.doesNotThrow(() => c.setEnabled(false)); c.dispose();
});
test('dispose is idempotent and removes all listeners', () => {
  const h = harness(); h.controller.update(bars(181), 'QQQ'); h.controller.dispose(); h.controller.dispose();
  assert.equal(h.workers[0].terminated, true); assert.equal(h.listeners.size, 0);
  assert.equal(h.docEvents.size, 0); assert.equal(h.hostEvents.size, 0);
});
