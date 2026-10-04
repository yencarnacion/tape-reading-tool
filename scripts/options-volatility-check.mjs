import assert from 'node:assert/strict';
import { selectOptions, VolatilityModel } from '../internal/server/web/options-volatility-model.js';

const start=Date.parse('2026-07-24T13:30:00Z');
function chain(now,iv=.60,skew=.1) {
  return [99,100,101].flatMap(strike=>['call','put'].map(kind=>({ticker:`O:TEST-${strike}-${kind}`,expiry:'2026-07-31',kind,strike,iv,
    delta:kind==='call'?.5:-.5,bid:2,ask:2.1,quoteMS:now,timeframe:'REAL-TIME',volume:100,openInterest:500})))
    .concat([{ticker:'O:PUT25',kind:'put',delta:-.25,strike:95,iv:iv+skew},{ticker:'O:CALL25',kind:'call',delta:.25,strike:105,iv}]
      .map(c=>({...c,expiry:'2026-07-31',bid:2,ask:2.1,quoteMS:now,timeframe:'REAL-TIME',volume:100,openInterest:500})));
}
const reply=(now,iv=.6,spot=100)=>({schemaVersion:1,symbol:'TEST',status:'ready',generation:1,asOfMS:now,spot,contracts:chain(now,iv)});
assert.equal(selectOptions(chain(start),100,start).contracts,6);
assert.ok(Math.abs(selectOptions(chain(start),100,start).skew-10)<1e-9);
for(const change of [{quoteMS:start-20001},{quoteMS:start+2001},{timeframe:'DELAYED'},{bid:0},{bid:3,ask:2},{bid:1,ask:3},{volume:0,openInterest:0},{iv:NaN},{expiry:'2026-07-23'}]) {
  assert.equal(selectOptions(chain(start).map(c=>({...c,...change})),100,start).status,'poor-quality',JSON.stringify(change));
}
assert.equal(selectOptions(chain(start).filter(c=>c.kind==='call'),100,start).status,'poor-quality');
assert.equal(selectOptions(chain(start).filter(c=>c.strike===100),100,start).status,'poor-quality');
assert.equal(selectOptions(chain(start).map(c=>({...c,iv:c.kind==='put'?3:.6})),100,start).status,'poor-quality');
assert.equal(selectOptions([],100,start).status,'no-options');
assert.equal(selectOptions(chain(start),0,start).status,'waiting-tape');
const original=selectOptions(chain(start),100,start);
const extra=chain(start).filter(c=>c.strike===101).map(c=>({...c,strike:102,ticker:c.ticker+'-102'}));
assert.equal(selectOptions([...chain(start),...extra],100.8,start,original.basis).basis,original.basis,'retain a comparable still-valid basket through small stock moves');
const later=chain(start).map(c=>({...c,expiry:'2026-08-07'}));
assert.equal(selectOptions([...chain(start).map(c=>({...c,bid:0})),...later],100,start).expiry,'2026-08-07');

const model=new VolatilityModel('TEST',start);
for(let i=0;i<=60;i++) {model.accept(reply(start+i*5000,.6+i*.001),start+i*5000);}
assert.ok(Math.abs(model.delta(30)-.6)<1e-9);
assert.ok(Math.abs(model.delta(60)-1.2)<1e-9);
assert.ok(Math.abs(model.delta(300)-6)<1e-9);
assert.equal(model.baseline.iv,.6,'expected move must stay frozen as IV rises');
assert.ok(Math.abs(model.baseline.move-100*.6/Math.sqrt(252))<1e-12);
const before=model.history.length;model.accept(reply(start+300000,.9),start+300000);
assert.equal(model.history.length,before,'same cached response must not create a new observation');
model.accept({...reply(start+305000),contracts:chain(start+305000).map(c=>({...c,ticker:c.ticker+'-ROLL'}))},start+305000);
assert.equal(model.delta(60),null,'rolling the ATM basket cannot manufacture an impulse');
assert.equal(model.peak,.6,'peak restarts on a different basket');
assert.equal(model.peakSince,start+305000);
assert.equal(model.baseline.iv,.6,'basket resets do not rewrite the frozen initial expected move');
model.accept(reply(start+400000),start+400000);
assert.equal(model.delta(60),null,'gaps reset comparison windows');
assert.equal(model.reading(start+425000).status,'stale');
model.accept({...reply(start),symbol:'OTHER'},start);
assert.equal(model.status,'context-changed');
model.accept({...reply(start),asOfMS:start-30000},start);
assert.equal(model.status,'stale');

// Known ten-second log returns annualize to the expected RV; a missing bin is
// unavailable rather than forward-filled or reported as a quiet market.
const rv=new VolatilityModel('TEST',start);
const r=.0002;
rv.trades(Array.from({length:311},(_,i)=>({s:i+1,t:start+i*1000,p:100*Math.exp(r*Math.floor(i/10)),z:100,d:i%2?1:-1})),start+310000);
const actual=rv.tape(start+310000).rv;
assert.ok(Math.abs(actual-r*Math.sqrt(252*390*6))<1e-9);
rv.bins.delete(Math.floor(start/10000)+15);
assert.equal(rv.tape(start+310000).rv,null);
assert.equal(rv.tape(start+340000).weakening,false,'stale underlying cannot signal slowing');
rv.trades([{s:10000,t:start+350000,p:999,z:1,d:-1}],start+310000);
assert.notEqual(rv.lastPrice,999,'future prints cannot enter the model');

// A complete five-minute downside scenario needs ALL confirmations. IV falling
// alone cannot create the divergence alert or an exhaustion-watch signal.
const divergence=new VolatilityModel('TEST',start);
for(let i=0;i<=310;i++) {
 const now=start+i*1000, iv=i<180 ? .6+i*.001 : .78-(i-180)*.001;
 divergence.trades([{s:i+1,t:now,p:100-i*.002,z:i<280?100:30,d:-1}],now);
 if(i%5===0) {
  const data=reply(now,iv,100-i*.002);
  data.contracts=chain(now,iv,i<180?.10:.10-(i-180)*.0003);
  divergence.accept(data,now);
 }
}
const watch=divergence.reading(start+310000,1.1);
assert.equal(watch.state,'IV DIVERGENCE');
assert.equal(watch.tape.weakening,true);
assert.ok(watch.offPeak< -5);
assert.ok(watch.skewDelta<0);
assert.equal(divergence.reading(start+350000,1.1).status,'stale');
// Missing skew cannot be substituted with zero (and must suppress divergence).
divergence.current.skewQuoteMS=null;
assert.notEqual(divergence.reading(start+310000,1.1).state,'IV DIVERGENCE');
const noSkew=selectOptions(chain(start).filter(c=>Math.abs(c.delta)>.3),100,start);
assert.equal(noSkew.skew,null);
const historical=new VolatilityModel('TEST',start);
const historicalReply={...reply(start),estimated:true,contracts:chain(start).map(c=>({...c,timeframe:'HISTORICAL',volume:0,openInterest:0,bidSize:1,askSize:1}))};
historical.accept(historicalReply,start);
assert.equal(historical.status,'ready','historical size gate is explicit and independent of unavailable OI');
assert.notEqual(selectOptions(historicalReply.contracts,100,start).status,'ready','historical contracts cannot masquerade as live snapshots');
historical.accept({...historicalReply,status:'poor-quality',quality:{ivBid:.5,ivAsk:.9,maxSpread:.5,contracts:6}},start);
const wide=historical.reading(start);
assert.equal(wide.status,'poor-quality');assert.equal(wide.qualityRange.ivBid,.5);assert.equal(wide.state,undefined,'wide quotes produce no trade state');
assert.equal(historical.reading(start+21000).qualityRange,null,'wide range expires with replay time');
historical.accept({...historicalReply,asOfMS:start+1},start);
assert.equal(historical.status,'stale','historical IV cannot use a future sample');
console.log('Options model: quality, freshness, robust basket, IV windows, roll/gap resets, fixed move, RV, and confirmed divergence passed');

// Underlying tape context stays useful when option quotes fail, without creating
// an options trend or treating a stale tape as exhaustion.
const fresh= start+310000;
assert.equal(watch.tape.flowState,'SLOWING');
assert.ok(watch.tape.flowChange < -25);
assert.deepEqual(watch.checks,{low:true,iv:true,skew:true,sell:true});
divergence.accept({schemaVersion:1,symbol:'TEST',status:'poor-quality',estimated:true,asOfMS:fresh,quality:{ivBid:.5,ivAsk:.9,maxSpread:.5,contracts:6}},fresh);
const qualityBlocked=divergence.reading(fresh);
assert.equal(qualityBlocked.state,undefined);
assert.equal(qualityBlocked.checks,undefined);
assert.equal(qualityBlocked.tape.flowState,'SLOWING');
assert.ok(qualityBlocked.tape.rv>0,'RV is independent of unreliable IV');
assert.equal(qualityBlocked.ratio,undefined,'no RV/IV ratio without reliable IV');
const staleTape=divergence.reading(fresh+21000);
assert.equal(staleTape.tape.flowState,'STALE');assert.equal(staleTape.tape.rv,null);
const accel=new VolatilityModel('TEST',start);
for(let i=0;i<=90;i++) accel.trades([{s:i+1,t:start+i*1000,p:100,z:i<60?100:200,d:1}],start+i*1000);
assert.equal(accel.tape(start+90000).flowState,'ACCELERATING');
assert.equal(accel.tape(start+90000).flowChange,100);
console.log('Expanded context: evidence gates, independent RV/tape, stale withholding, and real flow acceleration passed');
