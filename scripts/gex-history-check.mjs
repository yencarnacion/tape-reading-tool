import assert from 'node:assert/strict';
import {gexFixture,GEX_TIME} from './gex-check.mjs';
import {gexComparisons,gexStrikeChanges,gexHistoryTimeline} from '../internal/server/web/gex-history-model.js';
import {gexOverlayGeometry,gexOverlayDescription} from '../internal/server/web/gex-overlay.js';

export function historyFixture(symbol='AAPL',generation=1,at=GEX_TIME,dte=120){
 const current=gexFixture(symbol,generation,at,dte);
 current.history={status:'ready',anchorMS:at,throughMS:at,session:'2026-07-24',timeline:[],comparisons:[]};
 for(const minutes of [1,5,15,30]){
  const r=gexFixture(symbol,generation,at-minutes*60000,dte);r.replay=true;
  // The old +100 strike is twice as large, while the old -95 is smaller.
  r.call=40000;r.put=-2500;r.net=37500;r.gross=42500;
  r.strikes=[{strike:95,call:0,put:-2500,net:-2500},{strike:100,call:40000,put:0,net:40000}];
  r.expiries=[{expiry:'2026-07-31',call:r.call,put:r.put,net:r.net}];
  current.history.comparisons.push({minutes,targetMS:r.asOfMS,status:'ready',snapshot:r});
  current.history.timeline.push({asOfMS:r.asOfMS,spot:100,net:r.net,status:'ready'});
 }
 current.history.timeline.push({asOfMS:at,spot:100,net:current.net,status:'ready'});
 return current;
}
export function runHistoryChecks(){
 const current=historyFixture(),comparisons=gexComparisons(current);
 assert.equal(comparisons.length,4);
 const changes=gexStrikeChanges(current,comparisons[1]);
 assert.equal(changes[0].strike,100);assert.equal(changes[0].delta,-20000);assert.equal(changes[1].delta,-2500);
 const g=gexOverlayGeometry(current.strikes,{priceY:n=>200-n,left:0,right:600,top:0,bottom:300,comparisons});
 assert.equal(g.scaleMax,40000,'older exposures must set the same signed scale');
 const row=g.rows.find(r=>r.strike===100);
 assert.equal(row.history.length,4);assert.ok(row.history[0].x>row.x+row.width,'old larger endpoint lies beyond today’s bar');
 assert.match(gexOverlayDescription(row,current),/5m prior:.*change −\$20K/);
 for(const [name,mutate] of [
  ['future observation',c=>c.snapshot.asOfMS=c.targetMS+1],
  ['gap',c=>c.snapshot.asOfMS=c.targetMS-90001],
  ['wrong symbol',c=>c.snapshot.symbol='MSFT'],
  ['wrong expiry window',c=>c.snapshot.maxDTE=30],
  ['bad quality',c=>c.snapshot.status='poor-coverage'],
  ['bad totals',c=>c.snapshot.net++],
  ['wrong lookback target',c=>c.targetMS++],
  ['other session',c=>{c.targetMS-=86400000;c.snapshot.asOfMS-=86400000;}]
 ]){const r=historyFixture();mutate(r.history.comparisons[0]);assert.equal(gexComparisons(r).length,3,name);}
 const crossed=structuredClone(comparisons[0]);crossed.snapshot.strikes[1].net=-40000;
 const flip=gexOverlayGeometry(current.strikes,{priceY:n=>200-n,left:0,right:600,top:0,bottom:300,comparisons:[crossed]}).rows.find(r=>r.strike===100);
 assert.ok(flip.history[0].x<flip.baseline&&flip.x===flip.baseline,'a prior negative endpoint stays left when current exposure turns positive');
 assert.equal(flip.history[0].delta,60000,'sign changes use a signed difference');
 const duplicate=historyFixture();duplicate.history.comparisons.push(duplicate.history.comparisons[0]);assert.equal(gexComparisons(duplicate).length,4);
 const missing=structuredClone(comparisons[0]);missing.snapshot.strikes.pop();assert.equal(gexStrikeChanges(current,missing).length,1,'missing strike is not a zero');
 const points=gexHistoryTimeline(current,GEX_TIME-60000);assert.equal(points.length,4);assert.ok(points.every(p=>p.asOfMS<=GEX_TIME-60000));
 current.history.timeline[0].net=null;assert.equal(gexHistoryTimeline(current,GEX_TIME).find(p=>p.asOfMS===GEX_TIME-60000).net,null,'gap is not zero');
 console.log('GEX history checks passed: signed common scale, actual deltas, missing strikes, gaps, quality, session and replay boundaries.');
}
if(process.argv[1]?.endsWith('/gex-history-check.mjs'))runHistoryChecks();
