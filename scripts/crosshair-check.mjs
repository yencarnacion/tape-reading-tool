import assert from 'node:assert/strict';
import { crosshairReading } from '../internal/server/web/chart-crosshair.js';

const at = Date.parse('2026-11-13T14:32:00Z');
const chart = {
  left: 7, right: 407, top: 25, bottom: 480, priceBottom: 380,
  minimum: 90, maximum: 110, step: 40, count: 8,
  timeAt: index => at + index * 60000
};
assert.deepEqual(crosshairReading(chart, { x: 108, y: 202.5 }), {
  index: 2, time: at + 120000, x: 107, y: 202.5, price: 100
});
assert.equal(crosshairReading(chart, { x: 7, y: 25 }).price, 110);
assert.equal(crosshairReading(chart, { x: 407, y: 380 }).price, 90);
assert.equal(crosshairReading(chart, { x: 407, y: 100 }).time, at + 7 * 60000, 'right gap cannot invent a future candle');
assert.equal(crosshairReading(chart, { x: 108, y: 420 }).price, null, 'volume pane must not display a false price');
for (const point of [{x:6,y:100},{x:408,y:100},{x:20,y:24},{x:20,y:481},{x:NaN,y:100}])
  assert.equal(crosshairReading(chart, point), null);
for (const invalid of [null, {...chart,count:0}, {...chart,maximum:90}, {...chart,step:0}, {...chart,timeAt:()=>NaN}])
  assert.equal(crosshairReading(invalid, {x:108,y:100}), null);
// Use the current painted scale after an autoscale/resize, not its prior range.
assert.equal(crosshairReading({...chart,minimum:190,maximum:210,top:50,priceBottom:450}, {x:108,y:250}).price, 200);
console.log('Crosshair checks passed: exact price/time, bar snapping, bounds, volume, missing data and scale changes.');
