import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';
import { gexView, gexMoney, validGEXPayload } from './gex-model.js';

export const gexManifest = {
  id:'estimated-gex', name:'ESTIMATED GEX', version:'1.1.0', panelApiVersion:PANEL_API_VERSION, dataSchemaVersion:PANEL_DATA_SCHEMA_VERSION,
  description:'Calls+/puts− gamma positioning proxy; color means damping or amplification, not up/down price direction.',
  supportedModes:['live','massive','replay','render'], requestedCapabilities:['clock','options-gex','settings'],
  defaultSettings:{maxDTE:120}, minimumWidth:240, factory:createGEXPanel
};

export function createGEXPanel({root,host,settings}) {
  root.classList.add('gex-root');
  root.innerHTML=`<section class="gex-panel" aria-label="Estimated gamma exposure">
    <button class="gex-details" type="button">DETAILS</button>
    <button class="gex-details gex-history-launch" type="button">HISTORY</button>
    <strong class="gex-bias" role="status">GEX LOADING</strong>
    <div class="gex-reading"><output class="gex-net">—</output><span>est. $ hedge / 1% move</span></div>
    <div class="gex-levels"><div><div><span>LARGEST +</span><strong class="gex-positive">—</strong></div><small class="gex-positive-distance">—</small></div><div><div><span>LARGEST −</span><strong class="gex-negative">—</strong></div><small class="gex-negative-distance">—</small></div></div>
    <div class="gex-coverage"></div>
    <div class="gex-assumption">C+/P− ASSUMED · NO PRICE TARGET</div>
  </section>`;
  const box=root.querySelector('.gex-panel'), get=name=>root.querySelector('.gex-'+name);
  const dialog=document.createElement('dialog'); dialog.className='gex-dialog';
  dialog.innerHTML=`<header><strong>Estimated GEX · positions assumed</strong><button type="button" class="gex-close" aria-label="Close GEX details">×</button></header>
    <label>Expiry window <select class="gex-dte"><option value="30">0–30 days</option><option value="60">0–60 days</option><option value="120">0–120 days</option></select></label>
    <p class="gex-legend"><span>↔ Teal: range / fade bias</span><span>⇅ Amber: expansion bias</span><span>Gray: balanced, stale or incomplete</span></p>
    <p>Positive is not bullish; negative is not bearish. This proxy assumes long dealer calls and short dealer puts. Open interest cannot identify dealer inventory. Confirm a trade with the stock tape.</p>
    <div class="gex-guide"></div>
    <h3>Nearby strike concentrations</h3><figure class="gex-profile"></figure><h3>Snapshot and exposure context</h3><dl class="gex-facts"></dl>
    <h3>Largest strike concentrations · all strikes</h3><div class="gex-strike-table"></div><h3>Exposure by expiry</h3><div class="gex-expiry-table"></div>
    <p>Formula: gamma × open interest × 100 × stock price² × 0.01; calls positive, puts negative. Units: estimated dollar hedge adjustment for a 1% stock move. Standard 100-share contracts only; all strikes within the selected expiry window. Concentrations are not guaranteed support/resistance; no gamma flip is inferred.</p>
    <p>Greeks have no individual calculation timestamp in this feed. Freshness checks use the underlying snapshot as a proxy. Open interest follows the provider’s prior-trading-day convention; its reporting date is not supplied. Same-day opening/closing activity and actual dealer positions are unknown.</p>
    <p>Bias labels require a complete chain, ≥90% of known open interest and ≥80% of returned contracts included, with no missing OI. These are data-quality gates, not statistical confidence. A net below 10% of gross is labeled balanced. Magnitude is not scaled for stock liquidity.</p>`;
  document.body.append(dialog);
  let maxDTE=[30,60,120].includes(settings.maxDTE)?settings.maxDTE:120;
  dialog.querySelector('.gex-dte').value=String(maxDTE);
  let stopped=false,epoch=0,pending=null,result=null,nextPoll=0,identity='',lastClock=0,lastPaint='',lastReplayRequest=-1;
  let snapshot=host.currentSnapshot();
  const current=()=>!stopped&&host.isCurrent();
  function clear(){epoch++;pending?.abort();pending=null;result=null;nextPoll=0;lastPaint='';lastReplayRequest=-1;}
  function abort(){stopped=true;clear();dialog.close();dialog.remove();}
  host.signal.addEventListener('abort',abort,{once:true});
  get('history-launch').addEventListener('click',()=>host.openGEXHistory?.({maxDTE}),{signal:host.signal});
  get('details').addEventListener('click',()=>{paintDetails();dialog.showModal();},{signal:host.signal});
  dialog.querySelector('.gex-close').addEventListener('click',()=>dialog.close(),{signal:host.signal});
  dialog.querySelector('.gex-dte').addEventListener('change',event=>{
    maxDTE=Number(event.target.value);host.savePanelSettings({maxDTE});clear();paint(snapshot.clockUS/1000);
  },{signal:host.signal});
  const price=value=>Number.isFinite(value)?'$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const distance=(strike,spot)=>Math.abs(strike/spot-1)<.00005 ? 'at last' : `${(Math.abs(strike/spot-1)*100).toFixed(1)}% ${strike>spot?'above':'below'} last`;
  const time=value=>value>0?new Date(value).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
  function paintDetails() {
    const list=dialog.querySelector('.gex-facts');list.replaceChildren();
    const view=gexView(result,snapshot.clockUS/1000,{...snapshot,maxDTE});
    dialog.dataset.tone=view.tone;
    const guide=dialog.querySelector('.gex-guide');
    guide.textContent=!view.usable ? view.reason : view.tone==='dampen'
      ? 'Estimated damping: assumed hedging may oppose a move. A stall or failed breakout on the tape is consistent with this reading. No mean price or reversion target is calculated.'
      : view.tone==='amplify'
        ? 'Estimated amplification: assumed hedging may reinforce a move in either direction. Look for actual acceleration on the tape. This reading does not choose a direction or a price target.'
        : 'Calls and puts largely offset in this model. GEX gives no damping or amplification preference and no price target.';
    const c=result?.coverage;
    const facts=[['Status',view.label],['Meaning',view.reason],['Scope',`${snapshot.symbol} · 0–${maxDTE} days · all strikes`],
      ['Snapshot',result?.asOfMS?`${time(result.asOfMS)} ET · ${result.replay?'recorded':'live fetch'} · spot ${price(result.spot)}`:'No snapshot'],
      ['Last stock price',view.usable?price(view.spot):'No current reading'],
      ['Net / gross',`${gexMoney(result?.net)} / ${gexMoney(result?.gross,false)} per 1% stock move`],
      ['Net / gross balance',view.usable&&result.gross>0?`${Math.round(Math.abs(result.net)/result.gross*100)}% · exposure balance, not confidence`:'—'],
      ['Expiring in 0–7 days',view.usable&&view.nearTermGrossFraction!==null?`${Math.round(view.nearTermGrossFraction*100)}% of gross exposure in the selected expiry window`:'—'],
      ['Calls / puts',`${gexMoney(result?.call)} / ${gexMoney(result?.put)}`],
      ['Included',c?`${c.included}/${c.seen} contracts · ${Math.round(c.oiFraction*100)}% of known OI`:'—'],
      ['Excluded',c?`gamma ${c.missingGamma} · OI ${c.missingOI} · nonstandard ${c.nonstandard} · invalid ${c.invalid}`:'—'],
      ['Underlying freshness',result?.underlyingMS?`${time(result.underlyingMS)} ET (oldest included input)`:'Timestamp unavailable'],
      ['Recording',result?.recording==='recorded'?'Snapshot saved for replay':result?.recording==='failed'?'Recording failed':result?.replay?'Historical snapshot only':'No recorded snapshot'],
      ['OI date','Prior trading day by provider convention; reporting date not supplied']];
    for(const [label,value] of facts){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;list.append(dt,dd);}
    const profile=dialog.querySelector('.gex-profile');profile.replaceChildren();
    if(!view.usable){profile.textContent=`No current strike profile: ${view.reason}`;}
    else {
      const caption=document.createElement('figcaption');
      caption.textContent=`Last ${price(view.spot)} · up to 12 largest net concentrations within ±10% of snapshot spot ${price(result.spot)}. Values are calculated at that snapshot price, not by moving the stock to each strike.`;
      profile.append(caption);
      const scale=Math.max(0,...view.concentrations.map(bucket=>Math.abs(bucket.net)));
      const list=document.createElement('div');list.className='gex-profile-rows';list.setAttribute('role','list');
      for(const bucket of view.concentrations){
        const row=document.createElement('div');row.className='gex-profile-row';row.setAttribute('role','listitem');
        row.dataset.sign=bucket.net>0?'positive':bucket.net<0?'negative':'zero';
        const strike=document.createElement('strong');strike.textContent=price(bucket.strike);
        const track=document.createElement('span');track.className='gex-profile-track';track.setAttribute('aria-hidden','true');
        const bar=document.createElement('span');bar.className='gex-profile-bar';bar.style.width=`${scale>0?Math.abs(bucket.net)/scale*50:0}%`;track.append(bar);
        const value=document.createElement('span');value.textContent=gexMoney(bucket.net);
        const offset=document.createElement('span');offset.textContent=distance(bucket.strike,view.spot);
        row.append(strike,track,value,offset);list.append(row);
      }
      profile.append(list);
      const note=document.createElement('p');note.textContent='− left / + right · estimated $ hedge adjustment per 1% stock move. These are options concentrations, not support/resistance or destinations.';profile.append(note);
    }
    function table(selector,buckets,key) {
      const target=dialog.querySelector(selector);target.replaceChildren();
      if(!validGEXPayload(result)){target.textContent='No usable breakdown';return;}
      const table=document.createElement('table');
      for(const bucket of buckets){const row=document.createElement('tr');for(const value of [key==='strike'?price(bucket.strike):bucket.expiry,gexMoney(bucket.call),gexMoney(bucket.put),gexMoney(bucket.net)]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}table.append(row);}
      const caption=document.createElement('caption');caption.textContent=`${key==='strike'?'Strike (largest 12)':'Expiry'} · Calls+ · Puts− · Net ($ / 1%)`;table.prepend(caption);target.append(table);
    }
    table('.gex-strike-table',[...(result?.strikes||[])].sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)).slice(0,12),'strike');
    table('.gex-expiry-table',result?.expiries||[],'expiry');
  }
  function paint(nowMS) {
    if(!current())return;
    const view=gexView(result,nowMS,{...snapshot,maxDTE});
    const signature=JSON.stringify([view,result?.asOfMS,maxDTE]);if(signature===lastPaint)return;lastPaint=signature;
    box.dataset.tone=view.tone;get('bias').textContent=view.label;get('bias').title=view.reason;
    get('net').textContent=view.usable?gexMoney(result.net):'—';
    function level(name,bucket){
      const node=get(name),offset=get(name+'-distance');
      node.textContent=view.usable&&bucket?price(bucket.strike):'—';
      offset.textContent=view.usable&&bucket?`${distance(bucket.strike,view.spot)} · ${gexMoney(bucket.net)}`:'—';
      node.title=offset.title=view.usable&&bucket?`${gexMoney(bucket.net)} / 1% from options at strike ${price(bucket.strike)}; ${distance(bucket.strike,view.spot)}. Largest net ${name==='positive'?'positive':'negative'} concentration within ±10% of snapshot spot; no price target or support/resistance forecast.`:'';
    }
    level('positive',view.positive);level('negative',view.negative);
    const c=result?.coverage;
    get('coverage').textContent=view.usable?`${Math.round(c.oiFraction*100)}% known OI · ${c.included}/${c.seen} contracts · ${view.age}s${result.replay?' · REPLAY':result.recording==='recorded'?' · REC':result.recording==='failed'?' · REC FAILED':''}`:view.reason;
    get('assumption').textContent=`C+/P− ASSUMED · 0–${maxDTE}D · NO PRICE TARGET`;
    get('assumption').title='Open interest is from the prior trading day by provider convention; its actual reporting date and dealer inventory are not supplied.';
    if(dialog.open)paintDetails();
  }
  function render(nowUS) {
    if(!current())return;
    snapshot=host.currentSnapshot();const nowMS=nowUS/1000;
    const key=`${snapshot.symbol}/${snapshot.generation}/${snapshot.mode}/${!!snapshot.status?.connected}/${maxDTE}`;
    if(identity!==key || nowMS<lastClock-50){clear();identity=key;}lastClock=nowMS;
    const replay=['replay','render'].includes(snapshot.mode);
    const visible=!document.hidden&&root.getClientRects().length>0;
    const allowed=['live','massive','replay','render'].includes(snapshot.mode) && (replay||snapshot.status?.connected);
    const paused=replay&&snapshot.status?.state==='paused';
    if(visible&&allowed&&!pending&&performance.now()>=nextPoll && (!paused||lastReplayRequest!==nowMS)) {
      const controller=new AbortController(),token=epoch,requested={symbol:snapshot.symbol,generation:snapshot.generation,dte:maxDTE};pending=controller;
      nextPoll=performance.now()+(replay?500:15000);lastReplayRequest=nowMS;
      host.getGEXSnapshot({symbol:requested.symbol,maxDTE:requested.dte,signal:controller.signal}).then(reply=>{
        if(!current()||controller.signal.aborted||token!==epoch)return;
        result=reply.symbol===requested.symbol&&reply.generation===requested.generation&&reply.maxDTE===requested.dte?reply:{symbol:requested.symbol,generation:requested.generation,maxDTE:requested.dte,replay,status:'context-changed'};
      }).catch(()=>{if(current()&&token===epoch&&!controller.signal.aborted)result={symbol:requested.symbol,generation:requested.generation,maxDTE:requested.dte,replay,status:'gateway-offline'};})
      .finally(()=>{if(current()&&token===epoch){pending=null;lastPaint='';}});
    }
    paint(nowMS);
  }
  return {render,onEvent(){},unmount(){abort();host.signal.removeEventListener('abort',abort);root.classList.remove('gex-root');root.replaceChildren();}};
}
