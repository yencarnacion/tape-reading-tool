import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../internal/server/web/chart-history.js', import.meta.url), 'utf8');
const { ChartHistoryLoader, mergeChartHistory } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const raw = (time) => ({ time_us: time, open: 10, high: 11, low: 9, close: 10 });
const current = [{ timeUS: 120e6, close: 12 }, { timeUS: 180e6, close: 13 }];
const merged = mergeChartHistory(current, [raw(60e6), raw(120e6), raw(180e6), raw(240e6)], 180e6);
assert.deepEqual(merged.map(b => b.timeUS), [60e6, 120e6, 180e6]);
assert.equal(merged[1].close, 12, 'do not overwrite live data');
assert.equal(merged[2].close, 13, 'preserve forming candle');
assert.equal(mergeChartHistory([], Array.from({length:6000}, (_,i)=>raw((i+1)*60e6)), 7000*60e6).length, 5001);
let scheduled, delay, applied = 0, resolveFetch, signal;
const loader = new ChartHistoryLoader({
  apply: () => applied++, setTimer: (fn, ms) => { scheduled=fn; delay=ms; return 1; }, clearTimer: () => {},
  fetcher: (_,options) => { signal=options.signal; assert.equal(options.priority,'low'); return new Promise(resolve=>{resolveFetch=resolve;}); }
});
loader.ensure('AAPL/live','AAPL');
assert.equal(delay,2500,'initial delay lets first paint and warmup finish');
scheduled();
const oldSignal=signal;
loader.ensure('MSFT/live','MSFT');
assert.equal(oldSignal.aborted,true,'switching ticker cancels old request');
resolveFetch({ok:true,status:200,json:async()=>({symbol:'AAPL',bars:[]})});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(applied,0,'stale response rejected');
scheduled();
resolveFetch({ok:true,status:200,json:async()=>({symbol:'MSFT',bars:[]})});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(applied,1);
assert.equal(loader.done,true);
loader.reset();
// Browser timer functions reject the loader object as their receiver. Keep
// default calls unbound instead of assigning Window methods directly to it.
const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
try {
  globalThis.setTimeout = function () { assert.equal(this, undefined); return 1; };
  globalThis.clearTimeout = function () { assert.equal(this, undefined); };
  const defaults = new ChartHistoryLoader({ apply: () => {} });
  defaults.ensure('AAPL/live', 'AAPL');
  defaults.reset();
} finally {
  globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
}
console.log('chart history checks passed');
