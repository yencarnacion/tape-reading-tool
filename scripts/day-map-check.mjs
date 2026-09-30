import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../internal/server/web/day-map.js', import.meta.url), 'utf8');
const { DailyMapHistory, dailyMapModel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const history = Array.from({ length: 90 }, (_, index) => ({
  timeUS: index + 1, open: 100 + index, high: 102 + index, low: 99 + index, close: 101 + index
}));
const model = dailyMapModel(history, 200);
assert.equal(model.bars.length, 60);
assert.equal(model.bars[0].sma20, 121.5, 'average is warmed by candles before the visible window');
assert.equal(model.sma20, 180.5);
assert.equal(model.direction, 'above');
assert.equal(model.high, 200, 'premarket gaps must remain inside the plotted range');
assert.equal(dailyMapModel(history, 80).low, 80);
assert.equal(dailyMapModel(history, 80).direction, 'below', 'readout follows the current price rather than yesterday’s close');
assert.equal(dailyMapModel(history, NaN).price, 190);
assert.equal(dailyMapModel(history, NaN).live, false);
assert.equal(dailyMapModel(history.slice(0, 5), 102).sma20, null);
assert.equal(dailyMapModel([], 102), null);

const requests = [], updates = [];
let now = 0;
const loader = new DailyMapHistory({
  apply: (value) => updates.push(value), now: () => now,
  fetcher: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }))
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
const raw = (date, complete = true) => ({ sessionDateET: date, complete, startUS: Date.parse(`${date}T13:30:00Z`) * 1000,
  open: 100, high: 105, low: 99, close: 104 });
const reply = (index, symbol, bars, status = 'ready') => requests[index].resolve({ ok: true,
  json: async () => ({ symbol, bars, status, beforeSessionDateET: '2026-09-30' }) });
loader.ensure('AAPL|day1', 'AAPL', '2026-09-30');
loader.ensure('AAPL|day1', 'AAPL', '2026-09-30');
assert.equal(requests.length, 1, 'same ticker snapshots do not refetch');
loader.ensure('NVDA|day1', 'NVDA', '2026-09-30');
assert.equal(requests[0].options.signal.aborted, true);
reply(0, 'AAPL', [raw('2026-09-29')]);
await settle();
assert.equal(updates.length, 2, 'old ticker response must not populate the new chart');
assert.equal(loader.controller.signal, requests[1].options.signal, 'old completion must not release new request');
loader.ensure('AAPL|day1', 'AAPL', '2026-09-30');
reply(1, 'NVDA', [raw('2026-09-29')]);
reply(2, 'AAPL', [raw('2026-09-29'), raw('2026-09-30'), raw('2026-10-01'), raw('2026-09-28', false)]);
await settle();
assert.deepEqual(updates.at(-1).bars.map((bar) => bar.sessionDateET), ['2026-09-29'], 'forming and future sessions are excluded');
loader.ensure('AAPL|day1', 'AAPL', '2026-09-30');
assert.equal(requests.length, 3);
loader.ensure('AAPL|day2', 'AAPL', '2026-10-01');
requests[3].reject(new Error('temporary outage'));
await settle();
assert.equal(updates.at(-1).status, 'unavailable');
loader.ensure('AAPL|day2', 'AAPL', '2026-10-01');
assert.equal(requests.length, 4, 'failure retries are paced');
now = 30001;
loader.ensure('AAPL|day2', 'AAPL', '2026-10-01');
assert.equal(requests.length, 5, 'unavailable history can recover without changing ticker');
loader.reset();
assert.equal(requests[4].options.signal.aborted, true);
console.log('daily map arithmetic, replay boundary, and request lifecycle checks passed');
