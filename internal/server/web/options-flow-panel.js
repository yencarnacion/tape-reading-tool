import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';
import { computeHorizon } from './tape-model.js';
import { flowStates, flowView, direction, premium } from './options-flow-model.js';

export const optionsFlowManifest = {
 id:'options-flow', name:'OPTIONS FLOW', version:'1.0.0', panelApiVersion:PANEL_API_VERSION, dataSchemaVersion:PANEL_DATA_SCHEMA_VERSION,
 description:'Observed options premium pressure and stock-tape divergence. Near-dated selected contracts; no entry prediction.',
 supportedModes:['live','massive'], requestedCapabilities:['clock','stream','options-flow'], defaultSettings:{}, minimumWidth:240,
 factory:createOptionsFlowPanel
};
export function createOptionsFlowPanel({root,host}) {
 root.classList.add('options-flow-root');
 root.innerHTML=`<section class="of-panel" aria-label="Options flow pressure">
 <button type="button" class="of-toggle" aria-expanded="false">60s DETAIL</button>
 <div class="of-head" role="status"><strong class="of-direction">CONNECTING</strong><span class="of-verdict" hidden></span></div>
 <div class="of-empty"></div>
 <div class="of-values" hidden>
  <div class="of-windows">${[15,60,300].map(s=>`<div class="of-window" data-seconds="${s}"><span>${s===300?'5m':s+'s'} NET</span><strong class="of-lean">BUILDING</strong><output>—</output></div>`).join('')}</div>
  <div class="of-context"><span class="of-tape"></span><span class="of-pace"></span></div>
  <div class="of-quality"></div>
 </div>
 <div class="of-detail" hidden><div class="of-breakdown"></div><p>Call ask + put bid = bull · Call bid + put ask = bear<br>NBBO estimate · opening/closing unknown · no entry signal</p></div>
 <div class="of-basis">Selected contracts · 0–14 DTE · strikes ±10%</div>
 </section>`;
 const ui=Object.fromEntries(['panel','toggle','head','direction','verdict','empty','values','windows','tape','pace','quality','detail','breakdown','basis'].map(k=>[k,root.querySelector(`.of-${k}`)]));
 const cards=[...root.querySelectorAll('.of-window')];
 let stopped=false,epoch=0,pending=null,result=null,nextPoll=0,lastPaint=-1,details=false;
 let snapshot=host.currentSnapshot(),identity='';
 const current=()=>!stopped&&host.isCurrent();
 function clear(){epoch++;pending?.abort();pending=null;result=null;nextPoll=0;lastPaint=-1;}
 const abort=()=>{stopped=true;clear();};host.signal.addEventListener('abort',abort,{once:true});
 ui.toggle.addEventListener('click',()=>{details=!details;ui.toggle.setAttribute('aria-expanded',String(details));lastPaint=-1;paint(snapshot.clockUS/1000);},{signal:host.signal});
 function modeStatus(){return ['replay','render'].includes(snapshot.mode)?'replay-unavailable':!['live','massive'].includes(snapshot.mode)?'live-only':!snapshot.status?.connected?'waiting-tape':null;}
 function tapeReading(nowMS){
  const source=host.streamSource();const w=computeHorizon(source,15,Math.floor(nowMS/1000)*1e6);
  const latest=source.at(source.lastSeq());
  const classified=w.buyer+w.seller, fraction=w.volume>0?classified/w.volume:0;
  const ready=!!latest && nowMS-latest.t<=10000 && latest.t<=nowMS+1000 && !w.truncated && w.prints>=10 && fraction>=.6 && classified>0;
  const imbalance=classified>0?(w.buyer-w.seller)/classified:0;
  return {ready,side:ready&&Math.abs(imbalance)>=.2?Math.sign(imbalance):0};
 }
 function paint(nowMS){
  if(!current())return;
  const blocked=modeStatus();const view=blocked?{status:blocked}:flowView(result,nowMS,tapeReading(nowMS));
  ui.panel.dataset.side='neutral';ui.panel.dataset.divergence='false';ui.verdict.hidden=true;ui.verdict.dataset.relation='waiting';
  const usable=['ready','collecting'].includes(view.status)&&view.windows;
  ui.values.hidden=!usable||details;ui.detail.hidden=!usable||!details;ui.empty.hidden=!!usable;
  ui.toggle.hidden=!usable;ui.toggle.textContent=details?'BACK TO FLOW':'60s DETAIL';
  ui.basis.textContent=`${snapshot.symbol||'—'} · selected contracts · 0–14 DTE · ±10%`;
  if(!usable){const [label,description]=flowStates[view.status]||flowStates['invalid-data'];ui.direction.textContent=label;ui.empty.textContent=description;return;}
  const ready=view.status==='ready';
  ui.direction.textContent=!ready?'… BUILDING FLOW':view.side>0?'▲ BULLISH FLOW':view.side<0?'▼ BEARISH FLOW':'↔ MIXED FLOW';
  ui.head.title='Current 15s options pressure. Green = bullish; red = bearish; amber = stock tape opposes; gray = mixed or insufficient data. These colors do not recommend a trade.';
  ui.verdict.hidden=!ready||view.side===0;
  ui.verdict.textContent=view.divergence?'⇄ TAPE OPPOSES':view.aligned?'✓ TAPE AGREES':view.tapeLabel==='TAPE BUILDING'?'TAPE BUILDING':'TAPE MIXED';
  ui.verdict.dataset.relation=view.divergence?'opposed':view.aligned?'aligned':'waiting';
  if(view.status==='ready'){ui.panel.dataset.side=view.side>0?'bull':view.side<0?'bear':'neutral';ui.panel.dataset.divergence=String(view.divergence);}
  cards.forEach((card,i)=>{
   const w=view.windows[i],side=direction(w);
   card.dataset.side=w.ready?(side>0?'bull':side<0?'bear':'neutral'):'neutral';
   card.querySelector('output').textContent=premium(w.net,true);
   card.querySelector('.of-lean').textContent=w.observedSeconds<w.seconds?`${w.observedSeconds}/${w.seconds}s`:!w.ready?'THIN':side>0?'▲ BULL':side<0?'▼ BEAR':'↔ MIXED';
   card.setAttribute('aria-label',`${w.seconds===300?'5 minute':w.seconds+' second'} options flow: ${w.observedSeconds<w.seconds?'building':!w.ready?'insufficient data':side>0?'bullish':side<0?'bearish':'mixed'}, net ${premium(w.net,true)}`);
   card.title=`${w.seconds}s: bull ${premium(w.bull)} · bear ${premium(w.bear)} · unclassified ${premium(w.unknown)}. ${w.classifiedPrints}/${w.prints} prints classified. Net is observed premium, not a position.`;
  });
  const tapeSide=view.tapeLabel==='TAPE BUY'?'bull':view.tapeLabel==='TAPE SELL'?'bear':'neutral';
  ui.tape.dataset.side=tapeSide;
  ui.tape.textContent=tapeSide==='bull'?'TAPE ▲ BUYING':tapeSide==='bear'?'TAPE ▼ SELLING':view.tapeLabel;
  const directionalPace=ready&&view.side!==0&&['ACCELERATING','SLOWING','STEADY','PACE NEW'].includes(view.pace);
  ui.pace.dataset.side=directionalPace?(view.side>0?'bull':'bear'):'neutral';
  const paceLabel={ACCELERATING:'↑ FASTER',SLOWING:'↓ SLOWER',STEADY:'→ STEADY','PACE NEW':'NEW'}[view.pace];
  ui.pace.textContent=directionalPace?`${view.side>0?'BULL':'BEAR'} FLOW ${paceLabel}`:view.pace;
  ui.pace.title='Pace of the leading options side versus the previous 15 seconds. A slower bearish pace remains red; it does not become bullish.';
  const w=view.windows[0],age=Math.max(0,Math.floor((nowMS-result.lastTradeMS)/1000));
  ui.quality.textContent=`${view.coverage}% classified · ${w.prints} prints · ${result.lastTradeMS?age+'s ago':'no prints'}${result.recording==='recording'?' · REC':result.recording==='failed'||result.recording==='incomplete'?' · REC FAILED':''}`;
  ui.quality.title=`Confidence requires a full window, 5 classified prints, $10K classified premium, and 60% classified premium coverage. Unclassified: ${premium(w.unknown)}. Dropped old/future/overload events: ${result.rejected||0}.`;
  ui.basis.textContent=`${snapshot.symbol} · ${result.contracts} contracts${result.universeLimited?' (capped)':''} · 0–14 DTE · ±10% · estimate`;
  const minute=view.windows[1];ui.breakdown.textContent=`60s · CALL ASK ${premium(minute.callAsk)} / BID ${premium(minute.callBid)} · PUT ASK ${premium(minute.putAsk)} / BID ${premium(minute.putBid)} · UNKNOWN ${premium(minute.unknown)} · ≥$25K prints ${minute.largePrints}`;
 }
 function render(nowUS){
  if(!current())return;
  snapshot=host.currentSnapshot();const key=`${snapshot.symbol}/${snapshot.generation}/${snapshot.mode}/${!!snapshot.status?.connected}`;
  if(key!==identity){clear();identity=key;}
  const nowMS=nowUS/1000,mono=performance.now();
  const visible=!document.hidden&&root.getClientRects().length>0;
  if(!modeStatus()&&visible&&!pending&&mono>=nextPoll){
   const controller=new AbortController(),token=epoch,symbol=snapshot.symbol,generation=snapshot.generation;pending=controller;
   nextPoll=mono+1000;
   host.getOptionsFlow({symbol,signal:controller.signal}).then(reply=>{
    if(!current()||token!==epoch||controller.signal.aborted)return;
    if(reply.symbol!==symbol||reply.generation!==generation)result={schemaVersion:1,status:'context-changed',asOfMS:nowMS};else result=reply;
   }).catch(()=>{if(current()&&token===epoch&&!controller.signal.aborted)result={schemaVersion:1,status:'gateway-offline',asOfMS:nowMS};})
   .finally(()=>{if(current()&&token===epoch){pending=null;lastPaint=-1;if(result?.status&&!['ready','collecting','connecting'].includes(result.status))nextPoll=performance.now()+1000;}});
  }
  if(Math.floor(nowMS/1000)!==lastPaint){lastPaint=Math.floor(nowMS/1000);paint(nowMS);}
 }
 return {render,onEvent(event){if(event.type==='snapshot'||event.type==='modeChanged'){clear();}},unmount(){abort();host.signal.removeEventListener('abort',abort);root.classList.remove('options-flow-root');root.replaceChildren();}};
}
