import { gexView } from './gex-model.js';
import { classifyRTH } from './adr-rth-extension-model.js';

export const GEX_LOOKBACKS = Object.freeze([1,5,15,30]);
export const GEX_HISTORY_COLORS = Object.freeze({1:'#f0f4f8',5:'#62b5ff',15:'#c698ff',30:'#f4cf65'});
export const gexTime = ms => new Date(ms).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
const session = ms => classifyRTH(ms*1000).sessionDateET;

// Validate historical observations at their own times. Never label a newer
// snapshot as a prior lookback, carry data across sessions, or zero-fill gaps.
export function gexComparisons(current) {
  const h=current?.history;
  if(!h || h.status!=='ready' || h.anchorMS!==current.asOfMS || !Array.isArray(h.comparisons)) return [];
  const seen=new Set();
  return h.comparisons.filter(c=>{
    const r=c?.snapshot;
    if(c?.status!=='ready' || !Number.isFinite(r?.asOfMS) || r.asOfMS<=0 || r.asOfMS>8.64e15 || !GEX_LOOKBACKS.includes(c.minutes) || seen.has(c.minutes) || !r ||
      c.targetMS!==current.asOfMS-c.minutes*60000 || r.asOfMS>c.targetMS || c.targetMS-r.asOfMS>90000 ||
      r.symbol!==current.symbol || r.generation!==current.generation || r.maxDTE!==current.maxDTE || session(r.asOfMS)!==session(current.asOfMS)) return false;
    try {
      if(!gexView({...r,replay:true},r.asOfMS,{symbol:current.symbol,generation:current.generation,maxDTE:current.maxDTE,mode:'replay',spot:r.spot}).usable) return false;
    } catch { return false; }
    seen.add(c.minutes); return true;
  }).sort((a,b)=>a.minutes-b.minutes);
}

export function gexStrikeChanges(current, comparison) {
  if(!comparison) return [];
  const prior=new Map(comparison.snapshot.strikes.map(row=>[row.strike,row]));
  // An absent strike can mean missing inputs, so it is not an observed zero.
  return current.strikes.filter(row=>prior.has(row.strike)).map(row=>({
    strike:row.strike,net:row.net,prior:prior.get(row.strike).net,delta:row.net-prior.get(row.strike).net
  })).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta)||a.strike-b.strike);
}

export function gexHistoryTimeline(reply, throughMS) {
  const points=reply?.history?.timeline;
  if(!Array.isArray(points) || points.length>4096) return [];
  const byTime=new Map();
  for(const p of points) {
    if(!Number.isFinite(p?.asOfMS) || p.asOfMS<=0 || p.asOfMS>8.64e15 || p.asOfMS>throughMS || !Number.isFinite(p.spot) || p.spot<=0 ||
      session(p.asOfMS)!==reply.history.session) continue;
    byTime.set(p.asOfMS,{...p,net:p.status==='ready'&&Number.isFinite(p.net)?p.net:null});
  }
  return [...byTime.values()].sort((a,b)=>a.asOfMS-b.asOfMS);
}
