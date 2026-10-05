import assert from 'node:assert/strict';
import {formatTradeSize, tradeSizeLabel} from '../internal/server/web/trade-size.js';
import {computeHorizon, aggregateTickBars} from '../internal/server/web/tape-model.js';
import {RewindBuffer, createRewindSource} from '../internal/server/web/tape-rewind.js';
for (const size of [0.013374, 0.000001, 0.25, 0.999999]) {
  assert.equal(formatTradeSize(size), '<1');
  assert.equal(tradeSizeLabel(size), `${size} shares`);
}
for (const size of [0, -1, undefined, NaN, Infinity]) {
  assert.equal(formatTradeSize(size), '—');
  assert.equal(tradeSizeLabel(size), 'Size unavailable in this record');
}
assert.equal(formatTradeSize(1), '1');
assert.equal(tradeSizeLabel(1), '1 share');
assert.equal(formatTradeSize(1.25), '1.25');
assert.equal(tradeSizeLabel(125.013374), '125.013374 shares');
assert.equal(formatTradeSize(1500), '1.5K');
console.log('Trade sizes: fractions, six-decimal labels, unknown legacy sizes and whole-share compatibility passed');

const buffer = new RewindBuffer({bufferSeconds: 60, maxPrintsPerSecond: 10});
const sizes = [0.013374, 0.000001, 1.25];
sizes.forEach((z, i) => buffer.push({s: i + 1, r: 100000000 + i * 1000, t: 100000 + i, p: 747.7, z, d: i === 2 ? -1 : 1, c: 'mid', b: 747.69, a: 747.71}));
const source = createRewindSource(buffer);
const totals = computeHorizon(source, 5, 100005000);
assert.ok(Math.abs(totals.volume - 1.263375) < 1e-10);
assert.ok(Math.abs(totals.buyer - 0.013375) < 1e-10);
assert.equal(totals.seller, 1.25);
assert.ok(Math.abs(aggregateTickBars(source, 1, 3, 3)[0].volume - totals.volume) < 1e-10);
console.log('Fractional share volume and buyer/seller totals survive rewind and tick aggregation');
