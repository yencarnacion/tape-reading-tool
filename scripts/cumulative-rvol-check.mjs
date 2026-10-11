import assert from 'node:assert/strict';
import { CumulativeRVOL, minutePaneLayout, drawCumulativeRVOL } from '../internal/server/web/cumulative-rvol.js';

const clockUS = Date.parse('2026-10-09T10:00:10-04:00') * 1000;
const input = { enabled: true, symbol: 'AAPL', identity: 'live|1', clockUS };
let changed = 0, now = 0;
const requests = [];
const study = new CumulativeRVOL({ changed: () => changed++, now: () => now,
  fetcher: (url, options) => new Promise(resolve => requests.push({url, options, resolve})) });
const answer = (symbol = 'AAPL', ratio = 4.35) => ({ symbol, status: 'ready', through_us: clockUS,
  points: [{time_us: clockUS - 70e6, ratio, up: true}], baseline_sessions: ['1','2','3','4','5'] });
async function finish(request, result) {
  request.resolve({ok: true, json: async () => result});
  await new Promise(resolve => setImmediate(resolve));
}
study.sync({...input, enabled:false});
assert.equal(requests.length,0,'default-off must not request history');
study.sync(input); study.sync(input);
assert.equal(requests.length,1,'only one request in flight');
await finish(requests[0],answer());
study.sync(input);
assert.equal(requests.length,1,'no per-frame polling');
study.sync({...input,clockUS:clockUS+51e6});
assert.equal(requests.length,1,'allow the next minute to settle');
study.sync({...input,clockUS:clockUS+60e6});
assert.equal(requests.length,2);
study.sync({...input,enabled:false});
assert.ok(requests[1].options.signal.aborted,'off cancels loading');
await finish(requests[1],answer());
assert.equal(study.result,null,'late disabled result ignored');
study.sync(input);
study.sync({...input,symbol:'MSFT'});
assert.ok(requests[2].options.signal.aborted);
await finish(requests[2],answer());
assert.equal(study.result.status,'loading','old symbol must not reappear');
await finish(requests[3],answer('MSFT',2));
assert.equal(study.result.symbol,'MSFT');
study.sync({...input,symbol:'MSFT',identity:'massive|2'});
assert.equal(study.result.status,'loading','provider change clears baseline');
await finish(requests[4],answer('MSFT'));
study.sync({...input,symbol:'MSFT',identity:'massive|2',clockUS:clockUS-60e6});
assert.equal(requests.length,6,'backward clock refreshes the result');
requests[5].resolve({ok:false});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(study.result.status,'unavailable'); assert.equal(study.points.size,0,'failed refresh must hide stale numbers');
study.sync({...input,symbol:'MSFT',identity:'massive|2',clockUS:clockUS-60e6});
assert.equal(requests.length,6,'paced retry');
now = 16000;
study.sync({...input,symbol:'MSFT',identity:'massive|2',clockUS:clockUS-60e6});
await finish(requests[6],answer('MSFT'));
study.sync({...input,symbol:'MSFT',identity:'massive|2',clockUS:clockUS+86400e6});
assert.equal(study.result.status,'loading','session rollover clears yesterday');
await finish(requests[7],answer('MSFT'));
study.reset();

for (const height of [280,500,650]) {
  const originalVolume = Math.max(45,Math.min(92,(height-25-20)*.22));
  const original = minutePaneLayout(height,true,false);
  assert.equal(original.volumeHeight,originalVolume);
  assert.equal(original.priceBottom,height-20-originalVolume-8,'off restores original price height');
  const both = minutePaneLayout(height,true,true);
  assert.ok(both.priceBottom>both.top+100,'candles retain room');
  assert.ok(both.priceBottom<both.volumeTop && both.volumeBottom<both.rvolTop,'panes cannot overlap');
  const rvolOnly = minutePaneLayout(height,false,true);
  assert.ok(rvolOnly.priceBottom>both.priceBottom,'hiding volume returns its space to candles');
  assert.equal(minutePaneLayout(height,false,false).priceBottom,height-20);
}

// Verify time alignment, the always-visible 1x reference, and below-normal RVOL.
const text = [], rects = [];
const ctx = new Proxy({}, { get: (_,name) => name === 'fillText' ? (...args)=>text.push(args)
  : name === 'fillRect' ? (...args)=>rects.push(args) : ()=>{}, set:()=>true });
study.setResult(answer('AAPL',.5));
drawCumulativeRVOL(ctx,study,{visible:[{timeUS:clockUS-130e6},{timeUS:clockUS-70e6}],xAt:i=>10+i*8,bodyWidth:4,left:7,right:500,width:556,top:100,bottom:188});
assert.ok(text.some(args=>args[0]==='1×'));
assert.ok(text.some(args=>args[0]==='0.50×'));
assert.ok(rects.some(args=>args[0]===16),'RVOL histogram aligns to second matching candle, not row zero');
study.reset();
assert.ok(changed>0);
console.log('cumulative RVOL: default-off, cancellation, stale responses, providers, retry, clock, layout, and histogram checks passed');
