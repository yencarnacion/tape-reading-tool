import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceURL = new URL('../internal/server/web/daily-pivots.js', import.meta.url);
const source = await readFile(sourceURL, 'utf8');
const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const {
  calculateDailyPivots, dailyPivotLevels, dailyPivotProximity, layoutDailyPivotLabels
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
assert.equal(proximity.near, true);
proximity = dailyPivotProximity(levels, 105, null, symmetric.priorRange);
assert.equal(proximity.near, false);

const placed = layoutDailyPivotLabels([
  { key: 'R1', lineY: 100 }, { key: 'PP', lineY: 104 }, { key: 'S1', lineY: 108 }
], 90, 140, [118], 14);
for (let index = 1; index < placed.length; index++) {
  assert.ok(placed[index].labelY - placed[index - 1].labelY >= 14);
}
assert.ok(placed.every((item) => item.labelY >= 97 && item.labelY <= 133));

console.log('daily pivot checks passed');
