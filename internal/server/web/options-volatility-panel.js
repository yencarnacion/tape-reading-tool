import { VolatilityModel } from './options-volatility-model.js';
import { marketParts, displayNumber } from './adr-rth-extension-model.js';

export const OPTIONS_MARKUP = `<section class="options-vol" aria-label="Options volatility context">
  <header class="vol-heading"><strong class="vol-state">OPTIONS LOADING</strong><span class="vol-quality">LIVE</span></header>
  <div class="vol-reason">Waiting for fresh options quotes</div>
  <div class="vol-metrics">
    <div title="Median of paired ATM strikes in the nearest usable expiry. Historical IV is reconstructed, not vendor-observed."><span>ATM IV</span><strong class="vol-iv">--</strong><small class="vol-change">1m --</small></div>
    <div title="One-minute IV change in volatility points. The 30-second and five-minute changes use the same comparable basket."><span>IV IMPULSE · 1m</span><strong class="vol-impulse">--</strong><small class="vol-impulse-windows">30s -- · 5m --</small></div>
    <div title="Stock displacement since tracking began / frozen daily IV projection. Can exceed 100%; never a price limit."><span>IV MOVE USED</span><strong class="vol-used">--</strong><small class="vol-move">1D est. --</small></div>
    <div title="Percentage below the highest IV observed in this comparable basket. Resets after data gaps or basket changes."><span>OFF IV PEAK</span><strong class="vol-peak">--</strong><small class="vol-peak-since">observed peak</small></div>
    <div title="Five-minute realized volatility divided by ATM IV. Raw realized volatility remains available when options are unreliable."><span>ACTUAL PACE</span><strong class="vol-pace">--</strong><small class="vol-ratio">RV/IV -- · RV5m --</small></div>
    <div title="25-delta put IV minus call IV. Direction compares the same wings over five minutes; missing wings are not zero."><span>PUT FEAR</span><strong class="vol-skew">--</strong><small class="vol-skew-change">5m change --</small></div>
  </div>
  <div class="vol-flow-row" data-side="neutral" title="Green BUY / coral SELL identifies the previously dominant classified share flow. FASTER / SLOWER compares its last completed 30 seconds with the preceding 30 seconds; slowing sells still means sell flow, not buying. Requires a full minute, at least ten prints per window, and a fresh stock print."><strong class="vol-flow-side">TAPE FLOW</strong><strong class="vol-flow">BUILDING</strong><span class="vol-flow-change">60s of tape needed</span></div>
  <div class="vol-confirmations" aria-label="Downside IV divergence confirmations"><span class="vol-check-caption">DIVERGENCE</span><span class="vol-check-low">— NEW 5m LOW</span><span class="vol-check-iv">— IV EASING</span><span class="vol-check-skew">— FEAR EASING</span><span class="vol-check-sell">— SELLS SLOWING</span></div>
  <footer class="vol-footer"><span class="vol-coverage">Quality checked before signals</span>
    <details class="vol-details"><summary aria-label="Volatility calculation details">DETAILS</summary><div class="vol-detail-body"><strong>OPTIONS CONTEXT</strong><dl class="vol-detail-values"></dl><p>IV / ADR describe stretch and risk. The tape remains your trigger. States are descriptive heuristics, not entry signals.</p><p>1D estimate = first observed stock price × first ATM IV / √252. This is a daily projection from the nearest liquid expiry, not a 0DTE move or a reconstructed opening estimate. Event risk can distort it.</p><p>RV uses 30 completed 10-second log returns, annualized by 252 × 390 RTH minutes. Missing bins stay unavailable. Snapshots refresh every 5 seconds; IV itself has no independent provider timestamp.</p></div></details>
  </footer>
</section>`;

const STATUS = {

  'replay-unavailable':['OPTIONS NOT PREPARED','Prepare historical options quotes for this symbol and date'],
  'replay-outside-range':['OUTSIDE OPTIONS REPLAY','This time is outside the prepared options window'],
  loading:['OPTIONS LOADING','Waiting for fresh options quotes'],
  'live-only':['OPTIONS LIVE ONLY','Historical IV was not recorded · ADR remains available'],
  'market-closed':['OPTIONS MARKET CLOSED','Live RTH readings resume with fresh quotes'],
  'waiting-tape':['WAITING FOR TAPE','Fresh stock prints required for volatility context'],
  'poor-quality':['OPTIONS TOO THIN','No reliable paired ATM quotes · use ADR + tape'],
  'no-options':['NO USABLE OPTIONS','No standard contracts in the nearby expiry / strike window'],
  delayed:['OPTIONS DELAYED','Real-time option quotes are required · use ADR + tape'],
  stale:['OPTIONS STALE','Readings paused until fresh quotes arrive'],
  'not-configured':['OPTIONS OPTIONAL','Connect a local options gateway · ADR + tape are ready'],
  'gateway-offline':['OPTIONS OFFLINE','Start the configured local options gateway'],
  'gateway-unavailable':['OPTIONS UNAVAILABLE','The gateway could not obtain an options snapshot'],
  'gateway-config':['OPTIONS CONFIG','Check TAPE_OPTIONS_GATEWAY_URL in backend settings'],
  'gateway-update':['UPDATE GATEWAY','The options snapshot gateway route is unavailable'],
  'access-denied':['OPTIONS ACCESS DENIED','Check the gateway token and provider options entitlement'],
  'rate-limited':['OPTIONS RATE LIMITED','Pausing before the next refresh'],
  'chain-too-large':['OPTIONS INCOMPLETE','Bounded chain limit reached · no signal calculated'],
  'context-changed':['OPTIONS RESETTING','Stock or timeline changed'],
  unavailable:['OPTIONS UNAVAILABLE','Waiting for options data'],
  'invalid-data':['OPTIONS UNAVAILABLE','Incomplete or invalid options snapshot'],
  busy:['OPTIONS BUSY','Waiting for a gateway request slot']
};
const time = ms => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));
const number = (n,d=1) => displayNumber(n,d);
const signed = n => n===null || n===undefined ? '--' : `${n>=0?'+':''}${number(n)}`;

export function createOptionsView({root,host,getSnapshot,getADRExtension}) {
  if(typeof host.getOptionsSnapshot!=='function') return {event(){},render(){},unmount(){}};
  const $=s=>root.querySelector(s), box=$('.options-vol');
  let model=null, snapshot=null, pending=null, epoch=0, nextPoll=0, lastRender=0, mounted=true, displayed='', replayMeta=null, archiveCursor=0;
  function reset() {
    pending?.abort(); pending=null; epoch++; nextPoll=0;
    snapshot=getSnapshot(); model=new VolatilityModel(snapshot.symbol,snapshot.clockUS/1000);
    model.trades(snapshot.trades,snapshot.clockUS/1000); displayed=''; replayMeta=null; archiveCursor=0;
  }
  function paint(v) {
    // DOM writes at 4Hz at most, independent of the tape's print frequency.
    const signature=JSON.stringify(v); if(signature===displayed)return; displayed=signature;
    const ready=v.status==='ready', status=STATUS[v.status] || STATUS.unavailable;
    const range=!ready?v.qualityRange:null;
    box.dataset.tone=ready?v.tone:'muted';
    $('.vol-state').textContent=range?'OPTIONS WIDE':ready?v.state:status[0];
    $('.vol-state').title=ready?v.reason:status[1];
    $('.vol-reason').textContent=range?`Spreads up to ${number(range.maxSpread*100,0)}% · IV signals withheld`:ready?v.reason:status[1];
    $('.vol-reason').title=$('.vol-reason').textContent;
    $('.vol-quality').textContent=replayMeta?'REPLAY · EST.':ready?`${Math.floor(v.quoteAge)}s · ${v.contracts} ATM`:v.status==='not-configured'?'OPTIONAL':'LIVE';
    $('.vol-quality').title=replayMeta?.method || 'Local options snapshots';
    $('.vol-iv').textContent=range?`${number(range.ivBid*100,0)}–${number(range.ivAsk*100,0)}%`:ready?`${replayMeta?'≈':''}${number(v.iv*100)}%`:'--';
    $('.vol-change').textContent=range?'bid–ask IV estimate':ready?`expiry ${v.expiry.slice(5)}`:'no reliable quote';
    $('.vol-impulse').textContent=ready && v.d60!==null?`${signed(v.d60)} pts`:'--';
    $('.vol-impulse').dataset.direction=ready && v.d60>0?'up':ready && v.d60<0?'down':'neutral';
    $('.vol-impulse-windows').textContent=ready?`30s ${signed(v.d30)} · 5m ${signed(v.d300)}`:'30s -- · 5m --';
    $('.vol-peak').textContent=ready?`${number(v.offPeak)}%`:'--';
    $('.vol-peak-since').textContent=ready?`since ${time(v.peakSince)}`:'observed peak';
    $('.vol-used').textContent=ready?`${v.direction} ${number(v.used,0)}%`:'--';
    $('.vol-move').textContent=ready?`±$${number(v.move,2)} · ${number(v.movePct,1)}% / 1D`:'1D est. --';
    const tape=v.tape, rv=tape?.rv;
    $('.vol-pace').textContent=ready?v.pace:rv!=null?'RV ONLY':'BUILDING';
    $('.vol-ratio').textContent=`${ready && v.ratio!==null?number(v.ratio,2)+'× IV':'IV --'} · RV5m ${rv!=null?number(rv*100,1)+'%':'--'}`;
    const fear=ready && v.skewDelta!==null?v.skewDelta>.2?'RISING ↑':v.skewDelta<-.2?'EASING ↓':'STEADY':ready && v.skew!==null?'BUILDING':'--';
    $('.vol-skew').textContent=fear;
    $('.vol-skew-change').textContent=ready && v.skew!==null?`${signed(v.skew)} pts · 5m ${signed(v.skewDelta)}`:'25Δ wings unavailable';
    const flowValid=tape?.flowChange!=null && ['ACCELERATING','SLOWING','STEADY'].includes(tape.flowState);
    $('.vol-flow-row').dataset.side=flowValid?tape.side:'neutral';
    $('.vol-flow-side').textContent=flowValid?`${tape.side.toUpperCase()} FLOW`:'TAPE FLOW';
    $('.vol-flow').textContent=({ACCELERATING:'FASTER',SLOWING:'SLOWER'})[tape?.flowState] || tape?.flowState || 'BUILDING';
    $('.vol-flow').dataset.state=tape?.flowState || '';
    $('.vol-flow-change').textContent=flowValid?`${signed(tape.flowChange)}% · 30s`:tape?.flowState==='MIXED'?'no dominant side':tape?.flowState==='STALE'?'await fresh prints':'60s of tape needed';
    for(const [key,label] of [['low','NEW LOW'],['iv','IV ↓'],['skew','SKEW ↓'],['sell','SELLS ↓']]) {
      const value=ready?v.checks?.[key]:null, node=$('.vol-check-'+key);
      node.textContent=`${value===true?'✓':value===false?'·':'—'} ${label}`;
      node.dataset.confirmed=value===true?'yes':value===false?'no':'unknown';
      node.title=({low:'New five-minute stock low',iv:'IV falling for one minute and at least 3% off peak; full five-minute comparison',skew:'Same 25-delta wings: put-minus-call IV not rising over five minutes',sell:'Classified sell volume slowing across adjacent 30-second windows'})[key]+': '+(value===true?'met':value===false?'not met':'insufficient comparable data');
    }
    $('.vol-coverage').textContent=range?`${range.contracts} quotes · ≤20% spread needed`:ready?`${v.contracts} ATM · spread ${number(v.maxSpread*100,0)}% · ref ${time(v.baseline.at)}`:'No options signal without reliable quotes';
    const rows=ready?[
      ['Source',replayMeta?'Historical options quotes · 5s reconstruction':'Local options gateway · 5s snapshots'],
      ...(replayMeta?[['IV estimate',replayMeta.method],['Historical liquidity','Positive bid/ask sizes and ≤20% spread; historical OI/volume unavailable']]:[]),
      ['ATM expiry',v.expiry],['Quality',`${v.contracts} contracts · max spread ${number(v.maxSpread*100)}% · oldest quote ${number(v.quoteAge)}s`],
      ['IV Δ 30s / 1m / 5m',`${signed(v.d30)} / ${signed(v.d60)} / ${signed(v.d300)} pts`],
      ['Observed peak since',`${time(v.peakSince)} ET · resets on basket change / gap`],
      ['Frozen 1D estimate',`±$${number(v.move,2)} (±${number(v.movePct,2)}%)`],
      ['Move reference',`$${number(v.baseline.price,2)} at ${time(v.baseline.at)} ET`],
      ['Realized / implied',`${number(v.ratio,2)} · ${v.pace} (5m)`],
      ['25Δ put − call IV',`${signed(v.skew)} pts · 5m Δ ${signed(v.skewDelta)}`],
      ['Tape',v.tape.weakening?`${v.tape.side.toUpperCase()} flow slowing`:'No confirmed flow slowdown'],
      ['State evidence',v.reason]
    ]:[['Status',range?'Wide historical options: bid–ask IV range only; directional signals withheld':status[1]],['Source',replayMeta?'Historical options quotes':'Local options gateway · no direct provider key'],...(replayMeta?[['IV estimate',replayMeta.method]]:[])];
    const dl=$('.vol-detail-values'); dl.replaceChildren();
    for(const [label,value] of rows) {const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}
  }
  async function poll(nowMS) {
    const current=++epoch, symbol=snapshot.symbol, generation=snapshot.generation;
    const controller=new AbortController(); pending=controller;
    const signal=AbortSignal.any([host.signal,controller.signal,AbortSignal.timeout(8000)]);
    try {
      const replay=['replay','render'].includes(snapshot.mode);
      const payload=await host.getOptionsSnapshot({symbol,signal,...(replay?{afterMS:archiveCursor}:{})});
      if(!mounted || current!==epoch || !host.isCurrent())return;
      if(payload.generation!==generation) {model.unavailable('context-changed');return;}
      const clock=getSnapshot().clockUS/1000;
      if(replay) {
        if(!payload.replay) {model.unavailable('invalid-data');return;}
        replayMeta={method:payload.method || 'Quote-derived IV estimate; no historical provider IV'};
        // The server is the authority. Never accept a current snapshot or a
        // sample later than the replay clock, including during a backward seek.
        const samples=payload.samples?.length?payload.samples:[payload];
        for(const sample of samples) {
          if(!sample.estimated || sample.asOfMS>clock)continue;
          model.accept(sample,sample.asOfMS);
        }
        if(!['ready','poor-quality'].includes(payload.status))model.unavailable(payload.status);
        if(payload.asOfMS<=clock)archiveCursor=Math.max(archiveCursor,payload.asOfMS||0);
      } else model.accept(payload,clock);
    } catch(error) {
      if(mounted && current===epoch && !controller.signal.aborted)model.unavailable('gateway-offline');
    } finally {
      if(current===epoch) {pending=null;nextPoll=performance.now()+(['replay','render'].includes(snapshot.mode)?500:model.status==='ready'?5000:15000);}
    }
  }
  return {
    event(event) {
      if(event.type==='snapshot') reset();
      else if(event.type==='tradeBatch' && event.symbol===model?.symbol) model.trades(event.trades,event.clockUS/1000);
      else if(event.type==='modeChanged') {snapshot=getSnapshot(); if(!['live','massive','replay','render'].includes(snapshot.mode) || snapshot.status?.connected===false) {pending?.abort();pending=null;epoch++;model?.unavailable('waiting-tape');}nextPoll=0;}
    },
    render(nowUS) {
      if(!mounted || !host.isCurrent())return;
      if(!model)reset(); snapshot=getSnapshot();
      const nowMS=nowUS/1000, session=marketParts(nowUS)?.sessionDateET;
      if(model.symbol!==snapshot.symbol || model.session!==session)reset();
      const mono=performance.now(); if(mono-lastRender<250)return;lastRender=mono;
      if(!['live','massive','replay','render'].includes(snapshot.mode)) {paint({status:'live-only'});return;}
      const parts=marketParts(nowUS); const weekday=new Date(`${parts.sessionDateET}T12:00:00Z`).getUTCDay();
      if(weekday===0 || weekday===6 || parts.seconds<34200 || parts.seconds>=57600) {paint({status:'market-closed'});return;}
      if(snapshot.status?.connected===false) {paint({status:'waiting-tape'});return;}
      if(!pending && mono>=nextPoll) void poll(nowMS);
      paint(model.reading(nowMS,getADRExtension()));
    },
    unmount(){mounted=false;epoch++;pending?.abort();}
  };
}
