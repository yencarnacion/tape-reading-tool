import assert from 'node:assert/strict';
import { calculateMomentum, calculateDailyStretch, calculateExhaustion, calculateFlow, volumeProfiles, MomentumContextModel } from '../internal/server/web/momentum-context-model.js';
import { createStreamSource } from '../internal/server/web/tape-source.js';
const MINUTE = 6e7, start = Date.parse('2026-10-09T14:00:00Z') * 1000;
const scenario = (prices, climax = true) => prices.map((close, i) => {
  const open = i ? prices[i - 1] : close;
  return { timeUS: start + i * MINUTE, open, close, high: Math.max(open, close) + .01, low: Math.min(open, close) - .01,
    volume: climax && i >= 4 && i <= 6 ? 400 : 100 };
});
const profiles = ['2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-02']
  .map(date => ({ date, volume: new Map(Array.from({ length: 20 }, (_, i) => [600 + i, 100])) }));
const steady = scenario([100, 100.1, 100.2, 100.3, 100.4, 100.5, 100.6]);
const blowoff = scenario([100, 100.1, 100.2, 100.3, 100.7, 101.5, 102.5]);
const turnBars = scenario([100, 100.1, 100.2, 100.3, 100.7, 101.5, 102.5, 101.6, 100.4]);
assert.equal(calculateExhaustion(steady, start + 7 * MINUTE, 1, profiles).exhaustion, 0);
assert.equal(calculateExhaustion(steady, start + 7 * MINUTE, 1, profiles).relativeVolume, 4);
const climax = calculateExhaustion(blowoff, start + 7 * MINUTE, 1, profiles);
assert.equal(climax.exhaustion, 85); assert.equal(climax.turnDirection, 0);
assert.equal(calculateExhaustion(turnBars, start + 8 * MINUTE, 1, profiles).turnDirection, 0);
const turn = calculateExhaustion(turnBars, start + 9 * MINUTE, 1, profiles);
assert.equal(turn.turnDirection, -1); assert.equal(turn.exhaustion, 85); assert.notEqual(turn.clock, turn.setupClock);
const future = { timeUS: start + 9 * MINUTE, open: 100, high: 999, low: 1, close: 1, volume: 1e9 };
assert.deepEqual(calculateExhaustion([...turnBars, future], start + 9.5 * MINUTE, 1, profiles), turn);
assert.deepEqual(calculateExhaustion([...turnBars, { ...future, timeUS: start + 9 * MINUTE - 1e6 }], start + 9 * MINUTE, 1, profiles), turn);
assert.equal(calculateExhaustion(turnBars.slice(0, -1), start + 9 * MINUTE, 1, profiles).ready, false);
assert.equal(calculateExhaustion([...turnBars.slice(0, 6), ...turnBars.slice(7)], start + 9 * MINUTE, 1, profiles).ready, false);
assert.equal(calculateExhaustion(blowoff, start + 7 * MINUTE, 1, profiles.slice(0, 2)).relativeVolumeReady, false);
const mirror = turnBars.map(b => ({ ...b, open: 10000 / b.open, close: 10000 / b.close, high: 10000 / b.low, low: 10000 / b.high }));
const down = calculateExhaustion(mirror, start + 9 * MINUTE, -1, profiles);
assert.equal(down.exhaustion, turn.exhaustion); assert.equal(down.turnDirection, 1);
const wick = turnBars.map(b => ({ ...b })); Object.assign(wick.at(-1), { close: 101.6, high: 101.61, low: 1 });
assert.equal(calculateExhaustion(wick, start + 9 * MINUTE, 1, profiles).turnDirection, 0);
const recorded = JSON.stringify(turnBars); calculateExhaustion(turnBars, start + 9 * MINUTE, 1, profiles); assert.equal(JSON.stringify(turnBars), recorded);
const momentum = scenario([...Array(14).fill(100), 104], false), momentumNow = start + 14.5 * MINUTE;
const up = calculateMomentum(momentum, momentumNow);
assert.equal(up.side, 1); assert.equal(up.forming, true); assert.ok(Math.abs(up.ratio - 104 / ((1400 + 104) / 15)) < 1e-12);
assert.equal(calculateMomentum(momentum.slice(0, 14), momentumNow).ready, false);
// A fresh LAST snapshot before the first forming-minute print uses the same C.
const quoteOnly = calculateMomentum(momentum.slice(0, 14), momentumNow, 1.02, .98, 104, momentumNow);
assert.equal(quoteOnly.side, 1); assert.equal(quoteOnly.ratio, up.ratio);
assert.equal(calculateMomentum(momentum.slice(0, 14), momentumNow, 1.02, .98, 104, momentumNow + 1).ready, false);
assert.equal(calculateMomentum(momentum.slice(0, 14), momentumNow, 1.02, .98, 104, start).ready, false);

assert.equal(calculateMomentum(momentum, start + 16 * MINUTE).ready, false);
assert.equal(calculateMomentum(momentum.map(b => ({ ...b, close: b.close === 104 ? 96 : b.close })), momentumNow).side, -1);
const daily = Array.from({ length: 19 }, (_, i) => ({ sessionDateET: `2026-09-${String(i + 1).padStart(2, '0')}`, close: i === 17 ? 101 : i === 18 ? 102 : 100 }));
const stretch = calculateDailyStretch(daily, '2026-10-09', 120), mean = 2023 / 20, sd = Math.sqrt(205005 / 20 - mean ** 2);
assert.equal(stretch.days, 3); assert.equal(stretch.direction, 1); assert.ok(Math.abs(stretch.upper - (mean + 2 * sd)) < 1e-10);
assert.deepEqual(calculateDailyStretch([...daily, { sessionDateET: '2026-10-09', close: 1e4 }], '2026-10-09', 120), stretch);
assert.equal(calculateDailyStretch(daily.slice(-3), '2026-10-09', 120).bbReady, false);
assert.equal(calculateDailyStretch([], '2026-10-09', 120).streakReady, false);
assert.deepEqual(volumeProfiles([...turnBars, future], '2026-10-09'), []);

const nowUS = start + MINUTE;
function flowSource({ recentSide = 1, recentSize = 100, priceDirection = 1, priorSize = 100 } = {}) {
  let buyer = 0, seller = 0, volume = 0;
  const trades = Array.from({ length: 61 }, (_, i) => {
    const recent = i >= 31, d = recent ? recentSide : 1, z = recent ? recentSize : priorSize;
    volume += z; if (d > 0) buyer += z; else seller += z;
    return { s: i + 1, r: nowUS - 30e6 + i * .5e6, t: (nowUS - 30e6 + i * .5e6) / 1000,
      p: 100 + i * priceDirection * .01, z, d, b: 100 + i * priceDirection * .01, a: 100.01 + i * priceDirection * .01,
      _prints: i + 1, _volume: volume, _buyer: buyer, _seller: seller };
  });
  return createStreamSource({ trades, midpoints: trades, prefixBase: { prints: 0, volume: 0, buyer: 0, seller: 0 } });
}
assert.equal(calculateFlow(flowSource(), nowUS, 1).state, 'PUSH');
assert.equal(calculateFlow(flowSource({ recentSize: 20 }), nowUS, 1).state, 'EASE');
assert.equal(calculateFlow(flowSource({ recentSide: -1, priceDirection: -1 }), nowUS, 1).state, 'FLIP');
assert.equal(calculateFlow(flowSource({ priceDirection: -1 }), nowUS, 1).state, 'PULL');
assert.equal(calculateFlow(flowSource(), nowUS + 6e6, 1).state, 'BUILD');
const model = new MomentumContextModel(), reading = model.calculate({ bars: turnBars, dailyBars: daily, nowUS: start + 9 * MINUTE, price: 100.4, source: flowSource() });
assert.equal(reading.tape.turnDirection, -1);
assert.equal(model.calculate({ bars: turnBars, dailyBars: daily, nowUS: start + 8 * MINUTE, price: 101.6, source: flowSource() }).tape.turnDirection, 0);
console.log('momentum context: formula, daily bands, stock exhaustion, same-clock volume, flow, symmetry, missing data and replay cutoff passed');
