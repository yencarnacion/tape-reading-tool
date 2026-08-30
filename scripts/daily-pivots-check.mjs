import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceURL = new URL('../internal/server/web/daily-pivots.js', import.meta.url);
const source = await readFile(sourceURL, 'utf8');
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const {
  calculateDailyPivots, dailyPivotLevels, dailyPivotProximity,
  drawDailyPivotLabels, drawDailyPivotLines, layoutDailyPivotLabels,
  selectDailyPivotContext
} = await import(moduleURL);

const symmetric = calculateDailyPivots({ high: 110, low: 90, close: 100 });
assert.deepEqual(symmetric, {
  pp: 100, r1: 110, s1: 90, r2: 120, s2: 80, r3: 130, s3: 70, priorRange: 20
});

const asymmetric = calculateDailyPivots({ high: 25.6, low: 20.2, close: 22.1 });
const expected = {
  pp: 22.633333333333333,
  r1: 25.066666666666666,
  s1: 19.666666666666664,
  r2: 28.03333333333333,
  s2: 17.233333333333334,
  r3: 30.46666666666666,
  s3: 14.26666666666667
};
for (const [key, value] of Object.entries(expected)) assert.ok(Math.abs(asymmetric[key] - value) < 1e-12, key);
assert.equal(calculateDailyPivots({ high: 10, low: 11, close: 10 }), null);
assert.equal(calculateDailyPivots({ high: 10, low: 9, close: NaN }), null);

const levels = dailyPivotLevels(symmetric);
assert.deepEqual(levels.map((level) => level.key), ['R3', 'R2', 'R1', 'PP', 'S1', 'S2', 'S3']);
assert.equal(levels.find((level) => level.key === 'PP').price, 100);

const priceY = (price) => 300 - price * 2;
let proximity = dailyPivotProximity(levels, 109.95, priceY, symmetric.priorRange);
assert.equal(proximity.level.key, 'R1');
assert.equal(proximity.near, true);
proximity = dailyPivotProximity(levels, 105, priceY, symmetric.priorRange);
assert.equal(proximity.level.key, 'R1');
assert.equal(proximity.near, true, 'screen-space proximity should remain salient');
proximity = dailyPivotProximity(levels, 105, null, symmetric.priorRange);
assert.equal(proximity.near, false);

const volatile = calculateDailyPivots({ high: 150, low: 50, close: 100 });
proximity = dailyPivotProximity(dailyPivotLevels(volatile), 149, null, volatile.priorRange);
assert.equal(proximity.level.key, 'R1');
assert.equal(proximity.near, false, 'an extreme prior range must not make a one-dollar gap look near');
assert.ok(proximity.normalizedThreshold <= 149 * 0.004 + Number.EPSILON);

let selected = selectDailyPivotContext(levels, 105, null, symmetric.priorRange, 95, 115);
assert.equal(selected.near, null);
assert.equal(selected.up.key, 'R1');
assert.equal(selected.down.key, 'PP');
assert.deepEqual(selected.selected.map((level) => level.role), ['up', 'down']);

selected = selectDailyPivotContext(levels, 109.95, null, symmetric.priorRange, 85, 125);
assert.equal(selected.near.key, 'R1');
assert.equal(selected.up.key, 'R2', 'near R1 should preserve the next pivot above as context');
assert.equal(selected.down.key, 'PP', 'near R1 should preserve the next pivot below as context');
assert.deepEqual(selected.selected.map((level) => level.role), ['near', 'up', 'down']);

selected = selectDailyPivotContext(levels, 105, null, symmetric.priorRange, 104, 106);
assert.equal(selected.up.key, 'R1');
assert.equal(selected.down.key, 'PP');
assert.deepEqual(selected.selected, [], 'remote up/down pivots should be omitted from a tight chart');
assert.ok(selected.contextDistanceLimit < 5);

const closeEdgeLevels = [
  { key: 'UP', price: 100.6, color: '#fff', dash: [], width: 1 },
  { key: 'DOWN', price: 99.4, color: '#fff', dash: [], width: 1 }
];
selected = selectDailyPivotContext(closeEdgeLevels, 100, null, 2, 99.8, 100.2);
assert.deepEqual(selected.selected.map((level) => level.role), ['up', 'down']);
assert.ok(selected.selected.every((level) => !level.inView), 'nearby offscreen context should use edge cues, not scale changes');

const placed = layoutDailyPivotLabels([
  { key: 'R1', lineY: 100 }, { key: 'PP', lineY: 104 }, { key: 'S1', lineY: 108 }
], 90, 150, [123], 17);
for (let index = 1; index < placed.length; index++) {
  assert.ok(placed[index].labelY - placed[index - 1].labelY >= 17);
}
assert.ok(placed.every((item) => item.labelY >= 98 && item.labelY <= 142));

class FakeContext {
  constructor() { this.text = []; this.rects = []; this.strokes = 0; }
  save() {}
  restore() {}
  setLineDash() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() { this.strokes++; }
  fillRect(...args) { this.rects.push(args); }
  fillText(text, x, y) { this.text.push({ text: String(text), x, y }); }
  measureText(text) { return { width: String(text).length * 6 }; }
}

const contextLabels = new FakeContext();
drawDailyPivotLabels(contextLabels, {
  levels, priceY: (price) => 120 - (price - 85) / 40 * 100,
  minimum: 85, maximum: 125, left: 7, currentPrice: 109.95,
  priorRange: symmetric.priorRange, top: 20, bottom: 120,
  background: '#000', formatPrice: (value) => value.toFixed(2)
});
assert.ok(contextLabels.text.some(({ text }) => text.startsWith('NEAR R1 110.00')));
assert.ok(contextLabels.text.some(({ text }) => text.startsWith('↑ R2 120.00')));
assert.ok(contextLabels.text.some(({ text }) => text.startsWith('↓ PP 100.00')));
assert.equal(contextLabels.text.some(({ text }) => /R3|S1|S2|S3/.test(text)), false,
  'only near/up/down context should be labeled');

const lineContext = new FakeContext();
drawDailyPivotLines(lineContext, {
  levels, priceY: (price) => 120 - (price - 65) / 70 * 100,
  minimum: 65, maximum: 135, left: 7, right: 500, currentPrice: 109.95,
  priorRange: symmetric.priorRange, top: 20, bottom: 120
});
assert.equal(lineContext.strokes, 3, 'even with all seven pivots visible, only near/up/down lines should draw');

const edgeContext = new FakeContext();
drawDailyPivotLabels(edgeContext, {
  levels: closeEdgeLevels,
  priceY: (price) => 100 - (price - 99.8) / 0.4 * 80,
  minimum: 99.8, maximum: 100.2, left: 7, currentPrice: 100,
  priorRange: 2, top: 20, bottom: 100, background: '#000',
  formatPrice: (value) => value.toFixed(2)
});
assert.ok(edgeContext.text.some(({ text }) => text.startsWith('↑ UP 100.60')));
assert.ok(edgeContext.text.some(({ text }) => text.startsWith('↓ DOWN 99.40')));

const farContext = new FakeContext();
drawDailyPivotLabels(farContext, {
  levels, priceY: (price) => 100 - (price - 104) / 2 * 80,
  minimum: 104, maximum: 106, left: 7, currentPrice: 105,
  priorRange: symmetric.priorRange, top: 20, bottom: 100,
  background: '#000', formatPrice: (value) => value.toFixed(2)
});
assert.equal(farContext.text.length, 0, 'far pivots should not produce edge badges');

const atContext = new FakeContext();
drawDailyPivotLabels(atContext, {
  levels, priceY: (price) => 120 - (price - 90) / 35 * 100,
  minimum: 90, maximum: 125, left: 7, currentPrice: 110.001,
  priorRange: symmetric.priorRange, top: 20, bottom: 120,
  background: '#000', formatPrice: (value) => value.toFixed(2)
});
assert.ok(atContext.text.some(({ text }) => text === 'AT R1 110.00'));
assert.ok(atContext.text.some(({ text }) => text.startsWith('↑ R2 120.00')));
assert.ok(atContext.text.some(({ text }) => text.startsWith('↓ PP 100.00')));

console.log('daily pivot checks passed');
