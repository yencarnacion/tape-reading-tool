import assert from 'node:assert/strict';
import { GEXOverlayController } from '../internal/server/web/gex-overlay-controller.js';
import { drawGEXOverlay, drawGEXOverlayLabels, gexOverlayGeometry, gexOverlayHit, gexOverlayDescription, GEX_COLORS } from '../internal/server/web/gex-overlay.js';
import { gexFixture, GEX_TIME } from './gex-check.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const base = { enabled: true, symbol: 'AAPL', generation: 1, mode: 'live',
  status: { connected: true }, clockUS: GEX_TIME * 1000, spot: 100, maxDTE: 120, identity: 'live/1' };
function harness(input = base) {
  let now = 0, changes = 0;
  const requests = [];
  const study = new GEXOverlayController({ now: () => now, changed: () => changes++,
    fetcher: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) });
  return { study, requests, sync: (extra = {}) => study.sync({ ...input, ...extra }),
    time: value => { now = value; }, changes: () => changes,
    async finish(index, result = gexFixture(input.symbol, input.generation, input.clockUS / 1000, input.maxDTE)) {
      requests[index].resolve({ ok: true, json: async () => result }); await tick();
    }, async reject(index) { requests[index].reject(new Error('offline')); await tick(); } };
}

// Default-off and unsupported modes never request chains. Activation
// is independent of which lower analytics panel happens to be mounted.
{
  const h = harness(); h.sync({ enabled: false });
  assert.equal(h.requests.length, 0); assert.equal(h.study.view, null);
  for (const change of [
    { mode: 'demo' }
  ]) { h.sync(change); assert.equal(h.requests.length, 0); assert.equal(h.study.result, null); }
  h.sync(); assert.equal(h.requests.length, 1); assert.equal(h.study.view.status, 'loading');
  assert.equal(h.requests[0].url, '/api/panel-data/gex?symbol=AAPL&dte=120');
  await h.finish(0); assert.equal(h.study.view.usable, true); assert.equal(h.study.result.symbol, 'AAPL');
  h.sync({ clockUS: base.clockUS + 20000 });
  h.sync({ clockUS: base.clockUS + 10000 });
  assert.equal(h.requests.length, 1, '10ms live clock correction must not restart the request lifecycle');
  const changed = h.changes();
  for (let i = 0; i < 100; i++) h.sync();
  assert.equal(h.requests.length, 1, 'animation frames must not become API polling');
  assert.equal(h.changes(), changed, 'unchanged frames must not invalidate the chart');
  h.time(14999); h.sync(); assert.equal(h.requests.length, 1);
  h.time(15000); h.sync(); assert.equal(h.requests.length, 2, 'live polling resumes at 15 seconds');
  h.sync({ enabled: false });
  assert.ok(h.requests[1].options.signal.aborted, 'disabling aborts in-flight work');
  await h.finish(1); assert.equal(h.study.result, null); assert.equal(h.study.view, null);
  h.time(1e6); h.sync({ enabled: false }); assert.equal(h.requests.length, 2);
  assert.equal(h.study.debug().active, false);
}

// Old responses are deliberately delivered after their replacements. A fake
// transport ignoring AbortSignal must still never restore the wrong identity.
{
  const h = harness(); h.sync();
  h.sync({ symbol: 'MSFT' }); assert.ok(h.requests[0].options.signal.aborted);
  await h.finish(1, gexFixture('MSFT')); await h.finish(0);
  assert.equal(h.study.result.symbol, 'MSFT');
  h.sync({ symbol: 'MSFT', generation: 2 }); assert.equal(h.study.result, null);
  h.sync({ symbol: 'MSFT', generation: 2, maxDTE: 30 }); assert.ok(h.requests[2].options.signal.aborted);
  await h.finish(2, gexFixture('MSFT', 2));
  assert.equal(h.study.result, null, 'old scope cannot return while the new scope is loading');
  await h.finish(3, gexFixture('MSFT', 2, GEX_TIME, 30));
  assert.equal(h.study.result.maxDTE, 30);
  h.sync({ symbol: 'MSFT', generation: 2, maxDTE: 30, identity: 'new-timeline' });
  assert.equal(h.study.view.status, 'loading', 'external replay epoch invalidates equal symbol/generation');
  h.study.reset(); await h.finish(4, gexFixture('MSFT', 2, GEX_TIME, 30));
  assert.equal(h.study.result, null); assert.equal(h.study.view, null);
}

// Time gates update without any new quote, request, or canvas data event.
{
  const h = harness(); h.sync(); await h.finish(0);
  h.sync({ clockUS: (GEX_TIME + 90000) * 1000 });
  assert.equal(h.study.view.usable, true, '90 seconds is inclusive');
  const before = h.changes();
  h.sync({ clockUS: (GEX_TIME + 90001) * 1000 });
  assert.equal(h.study.view.status, 'stale'); assert.equal(h.study.result, null);
  assert.ok(h.changes() > before, 'clock-only expiry must repaint the canvas immediately');
  assert.equal(h.requests.length, 1, 'fake polling wall clock did not advance');
  h.study.reset();
}
{
  const h = harness(); h.sync(); await h.finish(0);
  h.sync({ spot: 100.5 }); assert.equal(h.study.view.spot, 100.5);
  assert.equal(h.study.result.spot, 100, 'current price does not silently reprice old gamma');
  h.sync({ spot: 102 }); assert.equal(h.study.view.status, 'price-moved'); assert.equal(h.study.result, null);
  h.sync({ spot: 100.25 }); assert.equal(h.study.view.usable, true, 'original fresh snapshot can be re-evaluated');
  h.study.reset();
}

for (const [name, modify, status] of [
  ['inconsistent total', r => { r.net++; }, 'invalid-data'],
  ['null bucket', r => { r.strikes[0] = null; }, 'invalid-data'],
  ['partial chain', r => { r.complete = false; }, 'invalid-data'],
  ['poor OI coverage', r => { r.coverage.missingOI = 1; }, 'poor-coverage'],
  ['provider delayed', r => { r.status = 'delayed'; }, 'delayed'],
  ['missing underlying timestamp', r => { r.underlyingMS = 0; }, 'freshness-unknown'],
  ['old underlying timestamp', r => { r.underlyingMS -= 90001; }, 'stale'],
  ['future snapshot', r => { r.asOfMS += 2001; }, 'invalid-data'],
  ['foreign symbol', r => { r.symbol = 'MSFT'; }, 'context-changed'],
  ['foreign scope', r => { r.maxDTE = 30; }, 'context-changed'],
  ['live response marked replay', r => { r.replay = true; }, 'invalid-data']
]) {
  const h = harness(); h.sync(); const reply = gexFixture(); modify(reply); await h.finish(0, reply);
  assert.equal(h.study.view.status, status, name); assert.equal(h.study.result, null, name);
  h.study.reset();
}

// Errors clear the visible exposure and retry on the same bounded schedule.
{
  const h = harness(); h.sync(); await h.finish(0);
  h.time(15000); h.sync(); await h.reject(1);
  assert.equal(h.study.view.status, 'gateway-offline'); assert.equal(h.study.result, null);
  h.time(29999); h.sync(); assert.equal(h.requests.length, 2);
  h.time(30000); h.sync(); assert.equal(h.requests.length, 3);
  h.requests[2].resolve({ ok: false }); await tick();
  assert.equal(h.study.view.status, 'gateway-offline'); h.study.reset();
}

const replayInput = { ...base, mode: 'replay', identity: 'replay/1', status: { connected: false, state: 'paused' } };
const recorded = (at = GEX_TIME) => ({ ...gexFixture('AAPL', 1, at), replay: true });
{
  const h = harness(replayInput); h.sync(); await h.reject(0);
  assert.equal(h.study.view.status, 'gateway-offline');
  h.time(500); h.sync(); assert.equal(h.requests.length, 1, 'paused transport failures must not retry at moving replay frequency');
  h.time(14999); h.sync(); assert.equal(h.requests.length, 1);
  h.time(15000); h.sync(); assert.equal(h.requests.length, 2, 'a failed paused lookup retries after 15 seconds without advancing the clock');
  await h.finish(1, recorded()); assert.equal(h.study.view.usable, true);
  h.time(60000); h.sync(); assert.equal(h.requests.length, 2, 'successful retry restores one lookup per paused clock');
  h.study.reset();
}
{
  const h = harness(replayInput); h.sync();
  await h.finish(0, { symbol: 'AAPL', generation: 1, maxDTE: 120, replay: true, status: 'replay-unavailable' });
  assert.equal(h.study.view.status, 'replay-unavailable');
  h.time(60000); h.sync(); assert.equal(h.requests.length, 1, 'authoritative no-recording result is not a transport failure');
  h.study.reset();
}
{
  const h = harness(replayInput); h.sync(); await h.finish(0, recorded());
  assert.equal(h.study.view.usable, true);
  h.time(60000); for (let i = 0; i < 100; i++) h.sync();
  assert.equal(h.requests.length, 1, 'paused replay looks up each clock once');
  h.sync({ clockUS: (GEX_TIME + 1000) * 1000 }); assert.equal(h.requests.length, 2);
  h.sync({ clockUS: (GEX_TIME - 60000) * 1000 });
  assert.ok(h.requests[1].options.signal.aborted, 'a backward seek cancels even without a new generation');
  assert.equal(h.study.result, null); assert.equal(h.requests.length, 3);
  await h.finish(1, recorded(GEX_TIME + 1000)); assert.equal(h.study.result, null);
  await h.finish(2, recorded(GEX_TIME - 60000)); assert.equal(h.study.result.asOfMS, GEX_TIME - 60000);
  h.study.reset();
}
{
  const h = harness({ ...replayInput, status: { state: 'playing' } });
  h.sync(); await h.finish(0, recorded());
  h.time(499); h.sync({ clockUS: (GEX_TIME + 1000) * 1000 }); assert.equal(h.requests.length, 1);
  h.time(500); h.sync({ clockUS: (GEX_TIME + 2000) * 1000 }); assert.equal(h.requests.length, 2);
  await h.finish(1, recorded(GEX_TIME + 2001));
  assert.equal(h.study.view.status, 'invalid-data', 'replay forbids even a 1ms future snapshot');
  assert.equal(h.study.result, null); h.study.reset();
}
{
  const h = harness(replayInput); h.sync(); await h.finish(0, gexFixture());
  assert.equal(h.study.view.status, 'invalid-data', 'historical mode cannot display a live reply'); h.study.reset();
}

// Canvas coordinates must follow stock prices without changing the candle
// domain. Strong strikes outside the visible prices cannot distort bar scaling.
const plot = { left: 10, right: 510, top: 20, bottom: 300, priceY: price => 300 - (price - 90) * 10 };
const strikes = [
  { strike: 95, call: 0, put: -100, net: -100 },
  { strike: 100, call: 200, put: 0, net: 200 },
  { strike: 105, call: 50, put: -50, net: 0 },
  { strike: 200, call: 1e9, put: 0, net: 1e9 }
];
{
  const geometry = gexOverlayGeometry(strikes, plot);
  assert.deepEqual(geometry.rows.map(r => r.strike), [105, 100, 95]);
  assert.deepEqual(geometry.rows.map(r => r.y), [150, 200, 250]);
  assert.equal(geometry.scaleMax, 200, 'offscreen strike must not compress visible exposures');
  const negative = geometry.rows.find(r => r.net < 0), positive = geometry.rows.find(r => r.net > 0), zero = geometry.rows.find(r => r.net === 0);
  assert.equal(negative.x + negative.width, geometry.baseline); assert.equal(positive.x, geometry.baseline);
  assert.equal(positive.width, negative.width * 2); assert.equal(zero.width, 0);
  assert.equal(positive.color, GEX_COLORS.positive); assert.equal(negative.color, GEX_COLORS.negative);
  const opposite = gexOverlayGeometry(strikes, { ...plot, side: 'left' });
  assert.ok(opposite.baseline < geometry.baseline); assert.equal(opposite.rows[1].y, positive.y);
  const allZero = gexOverlayGeometry([strikes[2]], plot);
  assert.equal(allZero.scaleMax, 0); assert.equal(allZero.rows[0].width, 0);
  assert.equal(gexOverlayGeometry([strikes[3]], plot).rows.length, 0);
}
function canvasRecorder() {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, name) => name === 'measureText'
    ? text => ({ width: text.length * 6 }) : (...args) => calls.push({ name, args }), set: () => true });
  return { ctx, calls };
}
{
  const { ctx, calls } = canvasRecorder();
  const dense = Array.from({ length: 100 }, (_, i) => ({ strike: 91 + i * .1, call: i + 1, put: 0, net: i + 1 }));
  const geometry = drawGEXOverlay(ctx, dense, { ...plot, right: 150 });
  drawGEXOverlayLabels(ctx, geometry);
  assert.equal(geometry.rows.length, 100, 'label density must not hide strike bars');
  assert.ok(geometry.rows.every(row => row.height > 0 && row.width >= 0 && row.x >= geometry.profileLeft && row.x + row.width <= geometry.profileRight));
  const labeled = geometry.rows.filter(row => row.labelBox);
  assert.ok(labeled.length > 0 && labeled.length < dense.length);
  for (let a = 0; a < labeled.length; a++) for (let b = a + 1; b < labeled.length; b++) {
    assert.ok(Math.abs(labeled[a].y - labeled[b].y) >= 18, 'neighbor labels must not collide');
  }
  assert.ok(labeled.some(row => row.net === 100), 'largest local exposure wins a text collision');
  const clip = calls.find(call => call.name === 'rect');
  assert.deepEqual(clip.args, [10, 20, 140, 280], 'bars and labels remain clipped to the price pane');
  assert.equal(calls[0].name, 'save'); assert.equal(calls.at(-1).name, 'restore');
  assert.equal(gexOverlayHit(geometry, plot.left - 1, geometry.rows[0].y), null);
  assert.equal(gexOverlayHit(geometry, geometry.baseline, geometry.rows[0].y).strike, geometry.rows[0].strike);
  assert.equal(gexOverlayHit(null, 100, 200), null);
}
{
  const { ctx } = canvasRecorder();
  const geometry = drawGEXOverlay(ctx, strikes, plot);
  drawGEXOverlayLabels(ctx, geometry);
  const row = geometry.rows.find(row => row.labelBox);
  assert.equal(gexOverlayHit(geometry, row.labelBox.x + 2, row.labelBox.y + 2).strike, row.strike);
  const description = gexOverlayDescription(row, gexFixture());
  assert.match(description, /AAPL strike/); assert.match(description, /per 1% stock move/);
  assert.match(description, /0–120 days/); assert.match(description, /assumed; not actual dealer inventory/);
}

console.log('GEX overlay checks passed: bounded lifecycle, races, quality, idle expiry, clock safety, strike scaling, clipping, dense labels, and hit testing');


// A local policy lookup is allowed before stock connectivity/RTH, and a
// terminal disabled reply stays neutral without further polling.
for (const extra of [{status:{connected:false}}, {clockUS:Date.parse('2026-07-24T12:00:00Z')*1000}]) {
 const h=harness({...base,...extra});h.sync();assert.equal(h.requests.length,1);
 await h.finish(0,{symbol:'AAPL',generation:1,maxDTE:120,status:'subscription-disabled'});
 assert.equal(h.study.view.status,'subscription-disabled');assert.equal(h.study.result,null);
 h.time(60000);h.sync();assert.equal(h.requests.length,1);h.study.reset();
}
