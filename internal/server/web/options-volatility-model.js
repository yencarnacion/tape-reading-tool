// Options are context for the stock tape. All changes are measured in actual
// volatility points; no uncalibrated -100/+100 score is presented as evidence.
import { marketParts } from './adr-rth-extension-model.js';

export const OPTION_MAX_AGE_MS = 20_000;
const DAY_SCALE = Math.sqrt(252);
const median = (values) => { const a = [...values].sort((x,y) => x-y); const i = Math.floor(a.length/2); return a.length%2 ? a[i] : (a[i-1]+a[i])/2; };
const finitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function selectOptions(contracts, spot, nowMS, previousBasis = '', estimated = false) {
  if (!finitePositive(spot)) return { status: 'waiting-tape' };
  const today = marketParts(nowMS*1000)?.sessionDateET;
  const usable = (contracts || []).filter(c => {
    const mid = (c.bid+c.ask)/2, age = nowMS-c.quoteMS;
    return typeof c.ticker === 'string' && c.ticker.startsWith('O:') && /^\d{4}-\d{2}-\d{2}$/.test(c.expiry) && c.expiry >= today
      && ['call','put'].includes(c.kind) && finitePositive(c.strike) && finitePositive(c.iv) && c.iv <= 10
      && c.timeframe === (estimated ? 'HISTORICAL' : 'REAL-TIME') && Number.isFinite(age) && age >= (estimated ? 0 : -2000) && age <= OPTION_MAX_AGE_MS
      && finitePositive(c.bid) && c.ask >= c.bid && (c.ask-c.bid)/mid <= .20
      && (estimated ? c.bidSize > 0 && c.askSize > 0 : c.volume >= 10 || c.openInterest >= 20) && Number.isFinite(c.delta);
  });
  for (const expiry of [...new Set(usable.map(c=>c.expiry))].sort()) {
    const chain = usable.filter(c=>c.expiry===expiry);
    let pairs = [...new Set(chain.map(c=>c.strike))].map(strike=>({ strike,
      call:chain.find(c=>c.strike===strike && c.kind==='call' && c.delta>=.30 && c.delta<=.70),
      put:chain.find(c=>c.strike===strike && c.kind==='put' && c.delta<=-.30 && c.delta>=-.70)
    })).filter(p=>p.call && p.put && Math.abs(p.strike/spot-1)<=.10)
      .sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot));
    const priorIDs=new Set(previousBasis.split('|'));
    const retained=pairs.filter(p=>priorIDs.has(p.call.ticker) && priorIDs.has(p.put.ticker));
    pairs=retained.length>=2 && retained.length*2===priorIDs.size ? retained : pairs.slice(0,3);
    if (pairs.length<2) continue;
    const basket=pairs.flatMap(p=>[p.call,p.put]); const iv=median(basket.map(c=>c.iv));
    if (basket.some(c=>Math.abs(c.iv/iv-1)>.25)) continue;
    const wing = (kind,delta) => chain.filter(c=>c.kind===kind && Math.abs(c.delta-delta)<=.08)
      .sort((a,b)=>Math.abs(a.delta-delta)-Math.abs(b.delta-delta) || a.ticker.localeCompare(b.ticker))[0];
    const put=wing('put',-.25), call=wing('call',.25);
    return {status:'ready',iv,expiry,basis:basket.map(c=>c.ticker).sort().join('|'),
      quoteMS:Math.min(...basket.map(c=>c.quoteMS)), contracts:basket.length,
      maxSpread:Math.max(...basket.map(c=>(c.ask-c.bid)/((c.ask+c.bid)/2))),
      skew:put && call ? (put.iv-call.iv)*100 : null,
      skewBasis:put && call ? `${put.ticker}|${call.ticker}` : '',
      skewQuoteMS:put && call ? Math.min(put.quoteMS,call.quoteMS) : null};
  }
  return {status:contracts?.length ? 'poor-quality' : 'no-options'};
}

export class VolatilityModel {
  constructor(symbol, nowMS) {
    const parts=marketParts(nowMS*1000);
    this.symbol=symbol; this.session=parts?.sessionDateET;
    this.rthOpenMS=parts ? Math.floor(nowMS/1000)*1000-(parts.seconds-34200)*1000 : NaN;
    this.history=[]; this.seconds=new Map(); this.bins=new Map(); this.lastSeq=0;
    this.lastPrice=null; this.lastPriceMS=0; this.baseline=null; this.peak=null; this.peakSince=null;
    this.current=null; this.status='loading'; this.lastAsOf=0;
  }
  trades(trades, nowMS) {
    if(!Number.isFinite(this.rthOpenMS))return;
    for (const t of trades || []) {
      if (!finitePositive(t.p) || !finitePositive(t.t) || t.t>nowMS || t.t<nowMS-370_000 || (t.s && t.s<=this.lastSeq)) continue;
      if (t.s) this.lastSeq=t.s;
      if(t.t<this.rthOpenMS || t.t>=this.rthOpenMS+390*60*1000) continue;
      if (t.t>=this.lastPriceMS) {this.lastPrice=t.p; this.lastPriceMS=t.t;}
      const sec=Math.floor(t.t/1000), bin=Math.floor(t.t/10000);
      const b=this.bins.get(bin);
      if (!b || t.t>=b.at) this.bins.set(bin,{price:t.p,at:t.t});
      const v=this.seconds.get(sec) || {buy:0,sell:0,low:t.p,high:t.p,prints:0};
      v.low=Math.min(v.low,t.p); v.high=Math.max(v.high,t.p); v.prints++;
      if (Number.isFinite(t.z) && t.z>0) {if(t.d>0) v.buy+=t.z; if(t.d<0) v.sell+=t.z;}
      this.seconds.set(sec,v);
    }
    this.prune(nowMS);
  }
  prune(nowMS) {
    for(const key of this.bins.keys()) if(key<Math.floor(nowMS/10000)-37) this.bins.delete(key);
    for(const key of this.seconds.keys()) if(key<Math.floor(nowMS/1000)-370) this.seconds.delete(key);
  }
  unavailable(status) {this.status=status; this.current=null; this.history=[]; this.peak=null; this.peakSince=null; this.qualityRange=null;}
  accept(payload, nowMS) {
    if (payload?.symbol!==this.symbol || payload?.schemaVersion!==1) {this.unavailable('context-changed'); return;}
    if (payload.status!=='ready') {
      this.unavailable(payload.status || 'unavailable');
      const q=payload.quality;
      if(payload.estimated && payload.status==='poor-quality' && Number.isFinite(payload.asOfMS) && payload.asOfMS<=nowMS && nowMS-payload.asOfMS<=OPTION_MAX_AGE_MS && finitePositive(q?.ivBid) && q.ivAsk>=q.ivBid && q.ivAsk<=10 && q.contracts>=4 && q.maxSpread>.2 && q.maxSpread<=1) {
        this.qualityRange={...q,at:payload.asOfMS};
      }
      return;
    }
    if (!Number.isFinite(payload.asOfMS) || nowMS-payload.asOfMS>OPTION_MAX_AGE_MS || payload.asOfMS>nowMS+(payload.estimated?0:2000)) {this.unavailable('stale'); return;}
    const selected=selectOptions(payload.contracts,payload.spot,nowMS,this.current?.basis,payload.estimated===true);
    if(selected.status!=='ready') {this.unavailable(selected.status); return;}
    if(payload.asOfMS<=this.lastAsOf) return;
    if(!this.current || selected.basis!==this.current.basis || payload.asOfMS-this.lastAsOf>OPTION_MAX_AGE_MS) {
      this.history=[]; this.peak=selected.iv; this.peakSince=payload.asOfMS;
    }
    this.lastAsOf=payload.asOfMS; this.status='ready'; this.current=selected; this.estimated=payload.estimated===true;
    this.peak=Math.max(this.peak ?? selected.iv,selected.iv);
    // Freeze a one-trading-day projection when tracking starts. A later IV jump
    // cannot move the denominator and make consumed movement disappear. It is
    // explicitly NOT a reconstructed 09:30 IV or a move to the option's expiry.
    if(!this.baseline) this.baseline={at:payload.asOfMS,price:payload.spot,iv:selected.iv,move:payload.spot*selected.iv/DAY_SCALE};
    this.history.push({at:payload.asOfMS,iv:selected.iv,skew:selected.skew,skewBasis:selected.skewBasis,price:payload.spot});
    this.history=this.history.filter(p=>p.at>=payload.asOfMS-330_000).slice(-80);
  }
  delta(seconds, field='iv') {
    const latest=this.history.at(-1); if(!latest) return null;
    const target=latest.at-seconds*1000;
    const prior=[...this.history].reverse().find(p=>p.at<=target);
    if(!prior || target-prior.at>10_000 || latest[field]===null || prior[field]===null || (field==='skew' && latest.skewBasis!==prior.skewBasis)) return null;
    return (latest[field]-prior[field])*(field==='iv'?100:1);
  }
  tape(nowMS) {
    this.prune(nowMS);
    const sec=Math.floor(nowMS/1000), volume=(lo,hi)=>{
      let buy=0,sell=0,prints=0;
      for(const [s,v] of this.seconds) if(s>=lo && s<hi) {buy+=v.buy;sell+=v.sell;prints+=v.prints;}
      return {buy,sell,prints};
    };
    const recent=volume(sec-30,sec), prior=volume(sec-60,sec-30);
    const side=prior.sell>prior.buy ? 'sell' : 'buy';
    // Require a full minute of observed prints, meaningful classified flow, and
    // fresh underlying data. Silence/halts must never become "exhaustion".
    const times=[...this.seconds.keys()]; const earliest=times.length?Math.min(...times):sec;
    const fresh=this.lastPriceMS>0 && nowMS-this.lastPriceMS<=10_000;
    const flowReady=fresh && earliest<=sec-60 && prior.prints>=10 && recent.prints>=10 && prior[side]>0;
    const dominant=prior[side] > prior[side==='sell'?'buy':'sell']*1.2;
    const flowChange=flowReady && dominant ? (recent[side]/prior[side]-1)*100 : null;
    const weakening=flowChange!==null && flowChange < -25;
    const flowState=!fresh?'STALE':!flowReady?'BUILDING':!dominant?'MIXED':weakening?'SLOWING':flowChange>=25?'ACCELERATING':'STEADY';
    const past=[...this.seconds].filter(([s])=>s>=sec-300 && s<sec-5).map(([,v])=>v);
    const fullWindow=earliest<=sec-300 && past.length>=150;
    const newLow=fullWindow && fresh && this.lastPrice<Math.min(...past.map(v=>v.low));
    const newHigh=fullWindow && fresh && this.lastPrice>Math.max(...past.map(v=>v.high));
    // Thirty non-overlapping 10-second log returns, all from completed bins.
    // No forward-fill through feed gaps. Annualization uses 252 x 390 RTH minutes.
    const end=Math.floor(nowMS/10000)-1; let sum=0, valid=true;
    for(let i=end-29;i<=end;i++) {
      const a=this.bins.get(i-1),b=this.bins.get(i);
      if(!a || !b) {valid=false;break;}
      sum+=Math.log(b.price/a.price)**2;
    }
    return {fresh,side,weakening,flowReady,flowChange,flowState,newLow,newHigh,fullWindow,rv:fresh && valid?Math.sqrt(sum/30*252*390*6):null};
  }
  reading(nowMS, adrExtension=null) {
    const c=this.current;
    const tape=this.tape(nowMS);
    if(this.status!=='ready' || !c) return {status:this.status,tape,qualityRange:this.qualityRange && nowMS-this.qualityRange.at<=OPTION_MAX_AGE_MS?this.qualityRange:null};
    if(nowMS-this.lastAsOf>OPTION_MAX_AGE_MS || nowMS-c.quoteMS>OPTION_MAX_AGE_MS) return {status:'stale',tape};
    if(!tape.fresh) return {status:'waiting-tape',tape};
    const d30=this.delta(30),d60=this.delta(60),d300=this.delta(300);
    const skewFresh=c.skewQuoteMS!==null && nowMS-c.skewQuoteMS<=OPTION_MAX_AGE_MS;
    const skewDelta=skewFresh?this.delta(300,'skew'):null;
    const ratio=tape.rv===null?null:tape.rv/c.iv;
    const offPeak=(c.iv/this.peak-1)*100;
    const used=Math.abs(this.lastPrice-this.baseline.price)/this.baseline.move*100;
    const threshold=Math.max(.2,c.iv*100*.005); // deadband in volatility points
    let state=d60===null?'BUILDING IV TREND':d60>threshold?'VOL EXPANDING':d60< -threshold?'VOL COOLING':'VOL STEADY';
    let tone=d60===null?'muted':d60>threshold?'expanding':d60< -threshold?'cooling':'neutral';
    let reason=d60===null?'60 seconds of comparable quotes needed':`IV ${d60>=0?'+':''}${d60.toFixed(1)} pts / 1m`;
    // A conservative downside-only divergence: full five-minute comparison,
    // lower IV, non-increasing 25-delta put skew, and actual sell deceleration.
    const divergence=tape.newLow && tape.side==='sell' && tape.weakening && d60!==null && d60< -threshold && d300!==null && offPeak<=-3 && skewDelta!==null && skewDelta<=0;
    const exhaustion=(used>=80 || adrExtension>=1) && offPeak<=-5 && d60!==null && d60< -threshold && tape.weakening && (tape.side!=='sell' || (skewDelta!==null && skewDelta<=0));
    if(divergence) {state='IV DIVERGENCE';tone='watch';reason='New 5m low · IV / skew easing · sell flow slowing';}
    else if(exhaustion) {state='EXHAUSTION WATCH';tone='watch';reason=`Stretch + IV cooling + ${tape.side} flow slowing`;}
    return {status:'ready',...c,skew:skewFresh?c.skew:null,quoteAge:Math.max(0,(nowMS-c.quoteMS)/1000),d30,d60,d300,skewDelta,offPeak,peakSince:this.peakSince,
      used,move:this.baseline.move,movePct:this.baseline.iv/DAY_SCALE*100,baseline:this.baseline,
      direction:this.lastPrice<this.baseline.price?'↓':this.lastPrice>this.baseline.price?'↑':'↔',ratio,
      pace:ratio===null?'BUILDING':ratio<.75?'QUIET':ratio<1.25?'NORMAL':ratio<1.75?'ELEVATED':'EXTREME',
      checks:{low:tape.fullWindow?tape.newLow:null,iv:d300===null || d60===null?null:d60< -threshold && offPeak<=-3,
        skew:skewDelta===null?null:skewDelta<=0,sell:tape.flowReady?tape.side==='sell' && tape.weakening:null},
      state,tone,reason,tape};
  }
}
