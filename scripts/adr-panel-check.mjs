import assert from 'node:assert/strict';
import {
  applyEligibleTrades, calculateADR, calculateExtension, classifyRTH, displayNumber, seedRTHContext, validCompletedDailyBar
} from '../internal/server/web/adr-rth-extension-model.js';

const date = (index) => `2026-07-${String(index + 1).padStart(2, '0')}`;
const bars = Array.from({ length: 24 }, (_, index) => ({
  sessionDateET: date(index), open: 100, high: 105 + index / 10, low: 100, close: 101, complete: true
}));

const adr20 = calculateADR(bars, 20, '2026-07-25');
assert.equal(adr20.status, 'ready');
assert.equal(adr20.bars.length, 20, 'ADR20 must use exactly 20 sessions');
const expected = bars.slice(-20).reduce((sum, bar) => sum + bar.high / bar.low - 1, 0) / 20;
assert.ok(Math.abs(adr20.adr - expected) < 1e-12, 'formula must be High / Low - 1');
const wrongCloseFormula = bars.slice(-20).reduce((sum, bar) => sum + (bar.high - bar.low) / bar.close, 0) / 20;
assert.notEqual(adr20.adr, wrongCloseFormula, 'close-denominator formula must not be used');
assert.ok(!adr20.bars.some((bar) => bar.sessionDateET >= '2026-07-25'), 'current and future sessions must be excluded');
assert.deepEqual(calculateADR([...bars, { ...bars[0], sessionDateET: '2026-08-01', high: 999 }], 20, '2026-07-25'), adr20, 'later replay sessions must not alter the baseline');
assert.equal(validCompletedDailyBar({ ...bars[0], high: 90 }, '2026-08-01'), false);
assert.equal(validCompletedDailyBar({ ...bars[0], complete: false }, '2026-08-01'), false);
assert.equal(calculateADR(bars.slice(0, 17), 20, '2026-08-01').status, 'insufficient');
const flat = Array.from({ length: 20 }, (_, i) => ({ ...bars[0], sessionDateET: date(i), high: 100 }));
assert.equal(calculateADR(flat, 20, '2026-08-01').status, 'unavailable', 'zero ADR must not divide');

const context = { status: 'ready', symbol: 'AAPL', sessionDateET: '2026-07-24', low: 100, lowTimeUS: 1, last: 100, lastTimeUS: 2, eligibleTradeCount: 2, completeFromRTHOpen: true };
assert.equal(calculateExtension({ status: 'ready', adr: .08 }, context).extension, 0);
assert.ok(Math.abs(calculateExtension({ status: 'ready', adr: .08 }, { ...context, last: 104 }).extension - .5) < 1e-12);
const lower = applyEligibleTrades({ ...context, last: 104 }, [{ p: 98, t: Date.parse('2026-07-24T13:35:00Z') }], { symbol: 'AAPL', sessionDateET: '2026-07-24' });
assert.equal(lower.low, 98); assert.equal(lower.last, 98); assert.equal(calculateExtension({ status: 'ready', adr: .08 }, lower).extension, 0);
const excludedByTime = applyEligibleTrades(context, [{ p: 50, t: Date.parse('2026-07-24T12:00:00Z') }], { symbol: 'AAPL', sessionDateET: '2026-07-24' });
assert.equal(excludedByTime.low, 100, 'premarket lower trade must not alter RTH low');
const early = applyEligibleTrades(context, [{ p: 99, t: Date.parse('2026-07-24T13:36:00Z') }], { symbol: 'AAPL', sessionDateET: '2026-07-24' });
const later = applyEligibleTrades(early, [{ p: 90, t: Date.parse('2026-07-24T13:47:00Z') }], { symbol: 'AAPL', sessionDateET: '2026-07-24' });
assert.equal(early.low, 99); assert.equal(later.low, 90, 'future lower low must exist only after delivery');

assert.equal(classifyRTH(Date.parse('2026-07-24T13:29:59Z') * 1000).phase, 'before-open');
assert.equal(classifyRTH(Date.parse('2026-07-24T13:30:00Z') * 1000).phase, 'open');
assert.equal(classifyRTH(Date.parse('2026-07-24T20:00:00Z') * 1000).phase, 'closed');
assert.equal(classifyRTH(Date.parse('2026-03-09T13:30:00Z') * 1000).phase, 'open', 'DST open must be timezone aware');
assert.equal(classifyRTH(Date.parse('2026-11-02T14:30:00Z') * 1000).phase, 'open', 'standard-time open must be timezone aware');
assert.equal(seedRTHContext({ schemaVersion: 1, symbol: 'MSFT', sessionDateET: '2026-07-24' }, { symbol: 'AAPL', sessionDateET: '2026-07-24' }).status, 'stale');
assert.equal(seedRTHContext({ schemaVersion: 1, symbol: 'AAPL', sessionDateET: '2026-07-24', status: 'incomplete', completeFromRTHOpen: false }, { symbol: 'AAPL', sessionDateET: '2026-07-24' }).status, 'incomplete');
assert.equal(displayNumber(null), '--'); assert.equal(displayNumber(Number.NaN), '--');
assert.equal(calculateADR(bars, 10, '2026-07-25').lookback, 10); assert.equal(calculateADR(bars, 10, '2026-07-25').bars.length, 10);

console.log('ADR panel check: formula, completeness, RTH boundaries, no-look-ahead, and formatting passed');
