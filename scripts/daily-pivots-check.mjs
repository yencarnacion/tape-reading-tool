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
const originalExpected = {
  pp: 100, r1: 110, s1: 90, r2: 120, s2: 80, r3: 130, s3: 70, priorRange: 20
};
for (const [key, value] of Object.entries(originalExpected)) assert.equal(symmetric[key], value, key);
for (let level = 4; level <= 10; level++) {
  assert.equal(symmetric[`r${level}`], 130 + (level - 3) * 20);
  assert.equal(symmetric[`s${level}`], 70 - (level - 3) * 20);
}
const fullLevels = dailyPivotLevels(calculateDailyPivots({ high: 102, low: 98, close: 100 }));
assert.equal(fullLevels.length, 21, 'ten resistance levels, central pivot, and ten support levels');
assert.equal(fullLevels[0].key, 'R10');
assert.equal(fullLevels[0].price, 134);
assert.equal(fullLevels.at(-1).key, 'S10');
assert.equal(fullLevels.at(-1).price, 66);
for (let price = 60; price <= 140; price += 0.5) {
  const selection = selectDailyPivotContext(fullLevels, price).selected;
  assert.ok(selection.length <= 4, 'the expanded ladder must never display more than four levels');
}
assert.deepEqual(selectDailyPivotContext(fullLevels, 128).selected.map(level => level.key), ['R9', 'R10', 'R8', 'R7']);
assert.deepEqual(selectDailyPivotContext(fullLevels, 72).selected.map(level => level.key), ['S8', 'S7', 'S9', 'S10']);

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
assert.deepEqual(levels.map((level) => level.key), [
  'R10', 'R9', 'R8', 'R7', 'R6', 'R5', 'R4', 'R3', 'R2', 'R1',
  'PP', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'
], 'nonpositive support prices must not be displayed');
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
assert.deepEqual(selected.selected.map((level) => level.key), ['R1', 'R2', 'PP', 'S1']);

selected = selectDailyPivotContext(levels, 109.95, null, symmetric.priorRange, 85, 125);
assert.equal(selected.near.key, 'R1');
assert.equal(selected.up.key, 'R1', 'proximity must not shift the selection anchor');
assert.equal(selected.down.key, 'PP', 'near R1 should preserve the next pivot below as context');
assert.deepEqual(selected.selected.map((level) => level.key), ['R1', 'R2', 'PP', 'S1']);

selected = selectDailyPivotContext(levels, 105, null, symmetric.priorRange, 104, 106);
assert.equal(selected.up.key, 'R1');
assert.equal(selected.down.key, 'PP');
assert.deepEqual(selected.selected.map((level) => level.key), ['R1', 'R2', 'PP', 'S1'], 'distance must not hide pivots');
assert.ok(selected.selected.every(level => !level.inView));
selected = selectDailyPivotContext(levels, 110, null, 20, 65, 135);
assert.deepEqual(selected.selected.map(level => level.key), ['R1', 'R2', 'PP', 'S1'], 'exact-price level occupies one upper slot');
selected = selectDailyPivotContext(levels, 140, null, 20, 65, 145);
assert.deepEqual(selected.selected.map(level => level.key), ['R4', 'R5', 'R3', 'R2']);
selected = selectDailyPivotContext(levels, 280, null, 20, 65, 285);
assert.deepEqual(selected.selected.map(level => level.key), ['R10', 'R9'], 'do not invent levels above the pivot ladder');

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
  constructor() { this.text = []; this.rects = []; this.strokes = 0; this.widths = []; }
  save() {}
  restore() {}
  setLineDash() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() { this.strokes++; this.widths.push(this.lineWidth); }
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
assert.ok(contextLabels.text.some(({ text }) => text.startsWith('↓ S1 90.00')));
assert.equal(contextLabels.text.some(({ text }) => /R3|S2|S3/.test(text)), false,
  'only two pivots on each side should be labeled');

const lineContext = new FakeContext();
drawDailyPivotLines(lineContext, {
  levels, priceY: (price) => 120 - (price - 65) / 70 * 100,
  minimum: 65, maximum: 135, left: 7, right: 500, currentPrice: 109.95,
  priorRange: symmetric.priorRange, top: 20, bottom: 120
});
assert.equal(lineContext.strokes, 4, 'draw two pivots on either side when all are in view');
assert.deepEqual(lineContext.widths, [2.8, 1.8, 2.2, 1.8], 'pivot strokes are twice their original widths');

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
assert.equal(farContext.text.length, 4, 'far pivots retain edge labels without rescaling');

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
