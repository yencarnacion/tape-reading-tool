import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gexView,gexMoney,validGEXPayload} from '../internal/server/web/gex-model.js';
import {lowerPanelSettings,DEFAULT_LOWER_PANEL} from '../internal/server/web/lower-panel-slot.js';

export const GEX_TIME=Date.parse('2026-07-24T14:00:00Z');
export function gexFixture(symbol='AAPL',generation=1,asOfMS=GEX_TIME,maxDTE=120){
  const through=new Date(asOfMS);through.setUTCDate(through.getUTCDate()+maxDTE);
  return {schemaVersion:1,symbol,generation,status:'ready',asOfMS,spot:100,spotMS:asOfMS,underlyingMS:asOfMS,
    maxDTE,throughExpiry:through.toISOString().slice(0,10),model:'calls-positive-puts-negative',oiConvention:'previous trading day; reporting date not supplied',greekTimeKnown:false,
    complete:true,net:15000,gross:25000,call:20000,put:-5000,source:'Synthetic GEX test fixture',recording:'recorded',
    coverage:{seen:2,included:2,missingGamma:0,missingOI:0,nonstandard:0,invalid:0,knownOI:150,includedOI:150,oiFraction:1},
    strikes:[{strike:95,call:0,put:-5000,net:-5000},{strike:100,call:20000,put:0,net:20000}],
    expiries:[{expiry:'2026-07-31',call:20000,put:-5000,net:15000}]};
}
export function negativeGEX(r){
  r.net=-15000;r.call=5000;r.put=-20000;
  r.strikes=[{strike:95,call:0,put:-20000,net:-20000},{strike:100,call:5000,put:0,net:5000}];
  r.expiries=[{expiry:'2026-07-31',call:5000,put:-20000,net:-15000}];return r;
}
export function runGEXChecks(){
  const context={mode:'live',symbol:'AAPL',generation:1,maxDTE:120,spot:100,status:{connected:true}};
  const r=gexFixture(),view=(r,now=GEX_TIME,c=context)=>gexView(r,now,c);
  for(const status of ['subscription-disabled','access-denied']) {
    const disabled={symbol:'AAPL',generation:1,maxDTE:120,status};
    assert.equal(view(disabled,Date.parse('2026-07-24T12:00:00Z'),{...context,status:{connected:false}}).status,status);
    assert.equal(view({...disabled,symbol:'MSFT'}).status,'context-changed');
  }
  assert.ok(validGEXPayload(r));assert.equal(view(r).tone,'dampen');assert.equal(view(r).label,'↔ RANGE / FADE BIAS');
  const negative=negativeGEX(gexFixture());assert.ok(validGEXPayload(negative));assert.equal(view(negative).tone,'amplify');assert.equal(view(negative).label,'⇅ EXPANSION BIAS');
  assert.equal(view(r).positive.strike,100);assert.equal(view(r).negative.strike,95);
  assert.equal(view(r).spot,100);
  assert.deepEqual(view(r).concentrations.map(bucket=>bucket.strike),[95,100]);
  assert.equal(view(r).nearTermGrossFraction,1,'expiry exactly seven calendar days away is included');
  const split=gexFixture();split.expiries=[{expiry:'2026-07-31',call:10000,put:0,net:10000},{expiry:'2026-08-01',call:10000,put:-5000,net:5000}];
  assert.ok(validGEXPayload(split));assert.equal(view(split).nearTermGrossFraction,.4,'later exposure is excluded from the near-term share');
  const changedPrice=view(r,GEX_TIME,{...context,spot:100.5});
  assert.equal(changedPrice.spot,100.5,'distances can use the latest stock price without pretending the chain was repriced');
  assert.equal(changedPrice.positive.strike,100,'concentrations still belong to the same snapshot');
  const outside=gexFixture();outside.strikes[1].strike=120;
  assert.ok(validGEXPayload(outside));assert.equal(view(outside).positive,null);
  assert.deepEqual(view(outside).concentrations.map(bucket=>bucket.strike),[95],'profile excludes distant strikes');
  const many=gexFixture();many.strikes=Array.from({length:17},(_,i)=>({strike:92+i,call:(i+1)*1000,put:0,net:(i+1)*1000}));
  many.call=many.net=many.gross=many.strikes.reduce((sum,b)=>sum+b.call,0);many.put=0;
  many.expiries=[{expiry:'2026-07-31',call:many.call,put:0,net:many.net}];
  assert.ok(validGEXPayload(many));assert.deepEqual(view(many).concentrations.map(b=>b.strike),Array.from({length:12},(_,i)=>97+i),'profile selects the largest twelve then orders them by price');
  const zero=gexFixture();zero.net=zero.gross=zero.call=zero.put=0;for(const b of [...zero.strikes,...zero.expiries])b.call=b.put=b.net=0;
  assert.equal(view(zero).label,'↔ BALANCED PROXY');assert.equal(view(zero).usable,true);
  assert.equal(view(zero).nearTermGrossFraction,null,'zero exposure has no percentage denominator');
  const balanced=gexFixture();balanced.put=-19000;balanced.gross=39000;balanced.net=1000;balanced.strikes[0].put=balanced.strikes[0].net=-19000;balanced.expiries[0].put=-19000;balanced.expiries[0].net=1000;
  assert.equal(view(balanced).tone,'neutral');
  for(const status of ['poor-coverage','delayed','stale','freshness-unknown','chain-too-large','no-options','replay-unavailable','rate-limited']){
    const v=view({...r,status});assert.equal(v.tone,'neutral');assert.equal(v.usable,false);
  }
  for(const mutate of [
    r=>r.net=1,r=>r.put=5000,r=>r.complete=false,r=>r.net=NaN,r=>r.strikes[0].net=900,
    r=>r.coverage.oiFraction=1.5,r=>r.coverage.includedOI=500,r=>r.coverage.missingGamma=-1,r=>r.expiries=[],
    r=>r.strikes[0].strike=-1,r=>r.strikes[0].strike=r.strikes[1].strike,r=>r.expiries[0].expiry='2030-01-01',
  ]){const bad=gexFixture();mutate(bad);assert.equal(validGEXPayload(bad),false);assert.equal(view(bad).usable,false);}
  assert.equal(view({...r,symbol:'MSFT'}).status,'context-changed');
  assert.equal(view({...r,generation:0}).status,'context-changed');
  assert.equal(view({...r,maxDTE:30}).status,'context-changed');
  assert.equal(view({...r,asOfMS:GEX_TIME+2001}).status,'invalid-data');
  assert.equal(view(r,GEX_TIME+90001).status,'stale');
  assert.equal(view({...r,underlyingMS:0}).status,'freshness-unknown');
  assert.equal(view({...r,underlyingMS:GEX_TIME-90001}).status,'stale');
  assert.equal(view(r,GEX_TIME,{...context,spot:102}).status,'price-moved');
  assert.equal(view(r,GEX_TIME,{...context,status:{connected:false}}).status,'waiting-tape');
  assert.equal(view(r,GEX_TIME,{...context,mode:'demo'}).status,'live-only');
  assert.equal(view(r,Date.parse('2026-07-24T13:29:59Z')).status,'market-closed');
  const replay={...context,mode:'replay'},recorded={...r,replay:true};
  assert.equal(view(recorded,GEX_TIME,replay).tone,'dampen');
  assert.equal(view(r,GEX_TIME,replay).status,'invalid-data');
  assert.equal(view({...recorded,asOfMS:GEX_TIME+1},GEX_TIME,replay).status,'invalid-data');
  assert.equal(view({...recorded,underlyingMS:GEX_TIME+1},GEX_TIME,replay).status,'stale');
  assert.equal(view(recorded,GEX_TIME+90001,replay).status,'replay-gap');
  assert.equal(gexMoney(15000),'+$15K');assert.equal(gexMoney(-5000),'−$5K');assert.equal(gexMoney(null),'—');assert.equal(gexMoney(0),'$0');
  assert.equal(DEFAULT_LOWER_PANEL,'options-flow');
  assert.equal(lowerPanelSettings({slots:{}},null).slots.lowerAnalytics.activePanelId,'options-flow');
  assert.equal(lowerPanelSettings({slots:{}},{slots:{lowerAnalytics:{activePanelId:'estimated-gex'}}}).slots.lowerAnalytics.activePanelId,'estimated-gex');
  console.log('GEX model checks passed: units, sign, balanced/zero, quality, freshness, timeline, settings');
}
if(process.argv[1]===fileURLToPath(import.meta.url))runGEXChecks();
