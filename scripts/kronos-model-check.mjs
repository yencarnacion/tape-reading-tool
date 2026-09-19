import assert from 'node:assert/strict';
import { eventReading, forecastReading, percent, etTime } from '../internal/server/web/kronos-model.js';
import { lowerPanelSettings } from '../internal/server/web/lower-panel-slot.js';

// Deliberately fabricated distribution for contract/UI tests, not inference.
export function mockForecast(symbol = 'QQQ', originMS = Date.parse('2026-09-18T14:17:00Z'), reference = 600) {
  const event = (yes, comparator, h, unknown = 0) => ({ count_true: yes, count_false: 32-yes-unknown, count_unknown: unknown, denominator: 32,
    probability: unknown ? null : yes/32, identified_bounds: [yes/32,(yes+unknown)/32], calibrated_probability: null, probability_basis: 'native_samples',
    definition: { event: 'terminal_close', comparator, horizon_bars: h, reference_price: reference, barrier_price: reference } });
  return { schema_version: '1.0', model_id: 'kronos-base', mode: 'live', symbol, forecast_origin: new Date(originMS).toISOString(), reference_price: reference,
    reference_kind: 'last_closed_close', paths_attempted: 32, bar_seconds: 60, status: 'ok', unique_decoded_paths: 32, input_bar_count: 240,
    calibration: { status: 'not_fitted', artifact_id: null }, expected_value_usd: null,
    horizon_close_times: Object.fromEntries([1,3,5,10].map(h => [h,new Date(originMS+h*60000).toISOString()])),
    horizons: Object.fromEntries([1,3,5,10].map(h => [h,{ horizon_bars: h, paths_price_valid: 32, paths_price_unknown: 0,
      close_above_reference: event(20, '>', h), close_below_reference: event(11, '<', h), close_equal_reference: event(1, '==', h),
      terminal_return_bps_distribution: { status: 'available', quantiles: { '0.5': 4 } } }])) };
}

const r = mockForecast(), now = Date.parse(r.forecast_origin)*1000+2e6;
const reading = forecastReading(r, 5, now);
assert.equal(reading.above.value, 20/32); assert.equal(reading.below.value, 11/32); assert.equal(reading.equal.yes, 1);
assert.equal(percent(reading.above.value), '63%'); assert.equal(percent(null), '—'); assert.equal(percent(0), '0%');
assert.equal(reading.close-reading.origin, 300000); assert.equal(etTime(reading.origin), '10:17');
const replayResult = { ...r, mode: 'replay' };
assert.equal(forecastReading(replayResult, 5, now).above.value, 20/32);
assert.equal(forecastReading(replayResult, 5, now).expired, false); // Paused replay clock, not wall time.
assert.ok(reading.above.interval[0] < .5 && reading.above.interval[1] > .75);
assert.equal(forecastReading(r, 5, now+60e6).expired, true); assert.equal(forecastReading(r, 5, now-3e6).expired, true);
for (const mutation of [
  x => x.horizons['5'].close_above_reference.probability = .9,
  x => x.horizons['5'].close_below_reference.definition.comparator = '<=',
  x => x.horizons['5'].close_above_reference.calibrated_probability = .625,
  x => x.horizons['5'].close_above_reference.count_false = 99,
  x => x.horizons['5'].close_equal_reference.count_true = -1,
  x => x.horizons['5'].close_above_reference.identified_bounds = [0,1],
  x => x.horizon_close_times['5'] = x.forecast_origin,
  x => x.unique_decoded_paths = 1,
  x => x.calibration.status = 'validated_in_scope',
  x => x.expected_value_usd = 2,
  x => x.reference_kind = 'current_price',
  x => x.mode = 'demo',
  x => x.paths_attempted = 0,
  x => x.horizons['5'].paths_price_unknown = 1,
  x => delete x.horizons['5'],
]) { const bad = structuredClone(r); mutation(bad); assert.throws(() => forecastReading(bad, 5, now)); }
const unknown = structuredClone(r);
for (const field of ['close_above_reference','close_below_reference','close_equal_reference']) {
  const e = unknown.horizons['5'][field]; e.count_unknown = 1; e.count_false--; e.probability = null; e.identified_bounds[1] += 1/32;
}
const eq = unknown.horizons['5'].close_equal_reference;
eq.count_true = 0; eq.count_false++; eq.identified_bounds = [0,1/32];
unknown.horizons['5'].paths_price_valid = 31; unknown.horizons['5'].paths_price_unknown = 1;
assert.equal(forecastReading(unknown, 5, now).above.value, null);
assert.equal(forecastReading(unknown, 5, now).median, null);
const partial = forecastReading(unknown, 5, now);
assert.equal(partial.above.validValue, 20/31);
assert.deepEqual(partial.above.bounds, [20/32, 21/32]);
assert.equal(partial.above.interval, null); // No confidence interval for selected survivors.
// Exercise every possible usable count, including zero and one: never invent
// a 50% result, and keep conditional estimates separate from all-path odds.
for (let usable = 0; usable <= 32; usable++) {
  const sample = structuredClone(r), h = sample.horizons['5'];
  const above = Math.floor(usable * .75), below = usable-above;
  for (const [field, yes] of [['close_above_reference',above],['close_below_reference',below],['close_equal_reference',0]]) {
    Object.assign(h[field], { count_true: yes, count_false: usable-yes, count_unknown: 32-usable,
      probability: usable === 32 ? yes/32 : null, identified_bounds: [yes/32,(yes+32-usable)/32] });
  }
  h.paths_price_valid = usable; h.paths_price_unknown = 32-usable;
  const v = forecastReading(sample, 5, now);
  assert.equal(v.above.validValue, usable ? above/usable : null);
  assert.equal(v.above.value, usable === 32 ? above/32 : null);
  assert.deepEqual(v.above.bounds, [above/32,(above+32-usable)/32]);
  if (usable === 24) { assert.equal(v.above.validValue,.75); assert.deepEqual(v.above.bounds,[.5625,.8125]); }
  if (usable) assert.equal(v.above.validValue + v.below.validValue, 1);
}
const panels = { slots: { primaryAnalytics: { activePanelId: 'adr-rth-extension' } }, settings: {} };
assert.equal(lowerPanelSettings(panels, {}).slots.lowerAnalytics.activePanelId, 'kronos-forecast');
assert.equal(lowerPanelSettings(panels, { slots: { lowerAnalytics: { activePanelId: 'tick-chart' } } }).slots.lowerAnalytics.activePanelId, 'tick-chart');
assert.equal(lowerPanelSettings(panels, { slots: { lowerAnalytics: { activePanelId: 'remote-url' } } }).slots.lowerAnalytics.activePanelId, 'kronos-forecast');
assert.equal(panels.slots.primaryAnalytics.activePanelId, 'adr-rth-extension');
console.log('kronos model check: counts, definitions, Wilson intervals, unknowns, clocks, nulls, and settings migration passed');
