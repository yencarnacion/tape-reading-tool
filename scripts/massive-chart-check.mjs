import assert from 'node:assert/strict';
import {appendMinuteBar,appendTickBar,aggregateTickBars} from '../internal/server/web/tape-model.js';
import {applyEligibleTrades,calculateADR} from '../internal/server/web/adr-rth-extension-model.js';
import {RewindBuffer, createRewindSource} from '../internal/server/web/tape-rewind.js';
const start=Date.parse('2026-10-05T14:00:00Z');
const rows=[[50,1,12],[75,100,15],[95,200,12],[74,100,14],[76,100,15],[1,100,8]].map(([p,z,f],i)=>({s:i+1,t:start+i,r:(start+i)*1000,p,z,f,d:1,c:'ask'}));
const bars=[],ticks=[];
for(const e of rows){appendMinuteBar(bars,e);appendTickBar(ticks,e,1);}
assert.equal(bars.length,1);assert.deepEqual(['open','high','low','close','volume'].map(k=>bars[0][k]),[75,76,74,76,501]);
assert.deepEqual(ticks.filter(b=>b.close!==null).map(b=>b.close),[75,76]);
assert.equal(ticks.reduce((sum,b)=>sum+b.volume,0),501);
assert.equal(ticks.reduce((sum,b)=>sum+b.delta,0),501);
const mixedTicks=[];for(const e of rows)appendTickBar(mixedTicks,e,10);
assert.deepEqual(['open','high','low','close','volume','delta'].map(k=>mixedTicks[0][k]),[75,76,74,76,501,501]);
appendMinuteBar(bars,{...rows[1],s:7,t:start+1,p:74.5});
assert.equal(bars[0].close,76,'late eligible print must not roll back close');
const state={symbol:'PCVX',sessionDateET:'2026-10-05',completeFromRTHOpen:true};
const ctx=applyEligibleTrades(state,rows,state);assert.deepEqual([ctx.open,ctx.high,ctx.low,ctx.last],[75,76,74,76]);
const flatDay={sessionDateET:'2026-10-02',complete:true,open:75,high:76,low:74,close:75};
assert.equal(calculateADR(Array(20).fill(flatDay),20,'2026-10-05').status,'insufficient','duplicate dates cannot manufacture ADR history');
const buffer=new RewindBuffer({bufferSeconds:30,maxPrintsPerSecond:100});
for(const e of rows)buffer.push(e);
assert.equal(buffer.read(0).f,12,'rewind must retain the volume-only rule');
console.log('Massive candles: field eligibility, volume-only opening reports, late close order, ADR consistency, unique sessions, and rewind flags passed');

// Regression for observed wick-producing report patterns: an odd-lot sold-last
// report above the market and an average-price report below the candle.
for (const sample of [
  {prices:[74.03,74.23,75.5478],flags:[15,15,12],low:74.03,high:74.23},
  {prices:[75.90,76.35,75.1975],flags:[15,15,12],low:75.90,high:76.35}
]) {
  const candle=[];
  sample.prices.forEach((p,i)=>appendMinuteBar(candle,{t:start+i,p,z:100,f:sample.flags[i]}));
  assert.equal(candle[0].low,sample.low);assert.equal(candle[0].high,sample.high);
}
console.log('Recorded wick patterns passed: odd-lot sold-last high and average-price low cannot stretch candle range');

// The observed premarket stream is entirely Form T/odd-lot (f=12). It must
// produce delta bars without inventing a candle price, live or in rewind.
const premarket=new RewindBuffer({bufferSeconds:30,maxPrintsPerSecond:100});
const premarketRows=[{z:19,d:-1},{z:80,d:1},{z:.25,d:-1}].map((e,i)=>({...e,s:i+1,t:start+i,r:(start+i)*1000,p:760.65,f:12,c:e.d>0?'ask':'bid'}));
for(const e of premarketRows)premarket.push(e);
const source=createRewindSource(premarket);
for(const tickSize of [1,10,100]){
 const live=[];for(const e of premarketRows)appendTickBar(live,e,tickSize);
 const rewind=aggregateTickBars(source,1,3,tickSize);
 assert.deepEqual(rewind,live);
 assert.equal(live.reduce((sum,b)=>sum+b.volume,0),99.25);
 assert.equal(live.reduce((sum,b)=>sum+b.delta,0),60.75);
 assert.ok(Math.abs(live.reduce((sum,b)=>sum+b.dollarDelta,0)-760.65*60.75)<1e-8);
 assert.ok(live.every(b=>[b.open,b.high,b.low,b.close].every(p=>p===null)));
}
const noVolume=[];appendTickBar(noVolume,{...premarketRows[0],f:11},1);
assert.equal(noVolume[0].volume,0);assert.equal(noVolume[0].delta,0);
assert.equal(appendTickBar(noVolume,{...premarketRows[0],f:8},1),null);
console.log('Premarket and odd-lot delta: shares, notional, tick sizes, live/rewind parity, and candle-price isolation passed');
