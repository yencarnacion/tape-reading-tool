import { gexView, gexMoney } from './gex-model.js';
import { gexComparisons, gexStrikeChanges, gexHistoryTimeline, gexTime, GEX_LOOKBACKS, GEX_HISTORY_COLORS } from './gex-history-model.js';
import { classifyRTH } from './adr-rth-extension-model.js';

const price=n=>Number.isFinite(n)?'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
const replay=mode=>mode==='replay'||mode==='render';
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};

// An independent read-only review surface: scrubbing never seeks the tape.
export class GEXHistoryDialog {
  constructor({context,fetcher=(...args)=>fetch(...args)}) {
    this.context=context;this.fetcher=fetcher;this.maxDTE=120;this.epoch=0;this.timer=null;
    this.pending=null;this.data=null;this.points=[];this.manual=null;this.next=0;this.key='';this.lastClock=null;this.lastRequest='';
    this.dialog=node('dialog','gex-history-dialog');
    this.dialog.innerHTML=`<header><div><small>RECORDED OPTIONS CONTEXT</small><h2>GEX through time</h2></div><button class="gh-close" aria-label="Close GEX history">×</button></header>
      <div class="gh-controls"><label>Expiry <select class="gh-scope"><option value="30">0–30D</option><option value="60">0–60D</option><option value="120">0–120D</option></select></label><button class="gh-latest">LATEST RECORDED</button><output class="gh-status" role="status"></output></div>
      <div class="gh-scrub"><button class="gh-prev" aria-label="Previous recorded GEX snapshot">‹</button><input class="gh-slider" type="range" min="0" max="0" value="0" aria-label="Recorded GEX snapshot"><button class="gh-next" aria-label="Next recorded GEX snapshot">›</button></div>
      <div class="gh-time-range"></div><div class="gh-reading"></div>
      <figure class="gh-trend" aria-label="Recorded net GEX over time"></figure>
      <div class="gh-legend"></div>
      <p class="gh-help">Bars show the selected snapshot. Dots show earlier observations on the same signed scale. A dot farther from zero than its bar means the magnitude has since shrunk. Hover for exact times and amounts.</p>
      <div class="gh-change-controls"><strong>Largest strike changes</strong><label>Compare <select class="gh-compare"><option value="1">1m ago</option><option value="5" selected>5m ago</option><option value="15">15m ago</option><option value="30">30m ago</option></select></label></div>
      <div class="gh-changes"></div><div class="gh-profile-heading"></div><div class="gh-profile" role="list" aria-label="Strike exposure and earlier observations"></div>
      <p class="gh-footnote">C+/P− open-interest proxy · estimated $ hedge adjustment per 1% stock move. Changes can reflect stock price, Greeks and input coverage; they do not identify option buying or selling. OI follows the prior-trading-day convention. Only saved observations are shown; gaps are not filled.</p>`;
    document.body.append(this.dialog);
    this.get=name=>this.dialog.querySelector('.gh-'+name);
    for(const minutes of GEX_LOOKBACKS){
      const label=node('label');const input=document.createElement('input');input.type='checkbox';input.checked=true;input.value=String(minutes);
      const swatch=node('i');swatch.style.background=GEX_HISTORY_COLORS[minutes];
      label.append(input,swatch,node('span','',`${minutes}m`));label.dataset.minutes=String(minutes);this.get('legend').append(label);
      input.addEventListener('change',()=>this.paint());
    }
    this.get('close').addEventListener('click',()=>this.dialog.close());
    this.dialog.addEventListener('close',()=>{if(!this.dialog.open)this.stop();});
    this.get('scope').addEventListener('change',e=>{this.maxDTE=Number(e.target.value);this.reset();this.tick();});
    this.get('latest').addEventListener('click',()=>{this.manual=null;this.refresh();});
    this.get('slider').addEventListener('input',e=>this.select(Number(e.target.value)));
    this.get('prev').addEventListener('click',()=>this.select(Number(this.get('slider').value)-1));
    this.get('next').addEventListener('click',()=>this.select(Number(this.get('slider').value)+1));
    this.get('compare').addEventListener('change',()=>this.paint());
    window.addEventListener('pagehide',()=>this.stop());
  }
  abort(){this.epoch++;this.pending?.abort();this.pending=null;}
  stop(){this.abort();clearInterval(this.timer);this.timer=null;}
  reset(){this.abort();this.data=null;this.points=[];this.manual=null;this.next=0;this.lastRequest='';this.paint('Loading saved snapshots…');}
  refresh(){this.abort();this.next=0;this.lastRequest='';this.tick();}
  select(index){const point=this.points[Math.max(0,Math.min(this.points.length-1,index))];if(!point)return;this.manual=point.asOfMS;this.refresh();}
  open(maxDTE=120){
    this.maxDTE=[30,60,120].includes(maxDTE)?maxDTE:120;this.get('scope').value=String(this.maxDTE);
    this.key='';this.lastClock=null;this.reset();if(!this.dialog.open)this.dialog.showModal();
    clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),250);this.tick();
  }
  identity(c){return JSON.stringify([c.symbol,c.generation,c.mode,c.identity,this.maxDTE,classifyRTH(c.clockUS).sessionDateET]);}
  tick(){
    if(!this.dialog.open)return;
    const c=this.context(),clock=c.clockUS/1000;
    if(document.hidden||c.enabled===false){if(this.pending)this.abort();this.next=0;this.lastRequest='';if(c.enabled===false){this.data=null;this.points=[];this.paint('History paused while the tape timeline changes.');}return;}
    if(!Number.isFinite(clock)||clock<=0||!['live','massive','replay','render'].includes(c.mode)){this.abort();this.data=null;this.points=[];this.paint('Recorded GEX requires a live or recorded market session.');return;}
    const key=this.identity(c);
    if(key!==this.key||(this.lastClock!==null&&clock<this.lastClock-(replay(c.mode)?0:50))){this.reset();this.key=key;}
    this.lastClock=clock;
    const request=`${clock}/${this.manual}`;
    if(this.pending||performance.now()<this.next||(replay(c.mode)&&c.status?.state==='paused'&&this.lastRequest===request))return;
    this.lastRequest=request;this.next=performance.now()+(replay(c.mode)?500:15000);void this.load(c,key);
  }
  async load(c,key){
    const token=this.epoch,controller=new AbortController();this.pending=controller;
    this.get('status').textContent='Loading saved snapshots…';
    const query=new URLSearchParams({symbol:c.symbol,dte:String(this.maxDTE)});if(this.manual!==null)query.set('at',String(this.manual));
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await this.fetcher(`/api/panel-data/gex/history?${query}`,{signal:controller.signal});
      if(!response.ok)throw new Error('history unavailable');const result=await response.json();
      const latest=this.context();
      if(token!==this.epoch||controller.signal.aborted||!this.dialog.open||this.identity(latest)!==key||latest.clockUS<c.clockUS-(replay(c.mode)?0:50000))return;
      if(result.symbol!==c.symbol||result.generation!==c.generation||result.maxDTE!==this.maxDTE||!result.replay||result.asOfMS>latest.clockUS/1000+(replay(c.mode)?0:2000))throw new Error('history context changed');
      this.data=result;this.points=gexHistoryTimeline(result,latest.clockUS/1000);this.paint();
    }catch(error){if(token===this.epoch&&this.dialog.open){this.data=null;this.points=[];this.lastRequest='';this.next=performance.now()+15000;this.paint('Recorded GEX unavailable. Retrying shortly.');}}
    finally{clearTimeout(timeout);if(token===this.epoch)this.pending=null;}
  }
  paint(message=''){
    const r=this.data,points=this.points;
    let view=null;
    try { if(r)view=gexView(r,r.asOfMS,{mode:'replay',symbol:r.symbol,generation:r.generation,maxDTE:r.maxDTE,spot:r.spot}); } catch { message='Recorded GEX inputs are invalid.'; }
    const comparisons=view?.usable?gexComparisons(r):[];
    const selected=points.findIndex(p=>p.asOfMS===r?.asOfMS);
    const slider=this.get('slider');slider.max=String(Math.max(0,points.length-1));slider.value=String(Math.max(0,selected));slider.disabled=!points.length;
    slider.setAttribute('aria-valuetext',r?.asOfMS?`${gexTime(r.asOfMS)} Eastern, net ${gexMoney(r.net)}`:'No recorded snapshots');
    this.get('prev').disabled=selected<=0;this.get('next').disabled=selected<0||selected>=points.length-1;
    this.get('latest').classList.toggle('active',this.manual===null);
    this.get('time-range').textContent=points.length?`${r.history.session} · ${gexTime(points[0].asOfMS)} — ${gexTime(points.at(-1).asOfMS)} ET · ${points.length} saved snapshots`:'No snapshots recorded for this stock, date and expiry window.';
    this.get('status').textContent=message||(r?.asOfMS?`${this.manual===null?'LATEST SAVED':'REVIEW'} · ${gexTime(r.asOfMS)} ET`:'NO RECORDED GEX');
    const selectedMinutes=Number(this.get('compare').value),comparison=comparisons.find(c=>c.minutes===selectedMinutes);
    const changes=comparison?gexStrikeChanges(r,comparison):[];
    this.get('reading').replaceChildren();
    for(const [label,value] of [['Stock at snapshot',view?.usable?`${r.symbol} ${price(r.spot)}`:'—'],['Net GEX',view?.usable?gexMoney(r.net):'—'],[`Net change · ${selectedMinutes}m`,comparison?gexMoney(r.net-comparison.snapshot.net):'—']]){
      const cell=node('div');cell.append(node('small','',label),node('strong','',value));this.get('reading').append(cell);
    }
    for(const label of this.get('legend').children){
      const minutes=Number(label.dataset.minutes),c=comparisons.find(c=>c.minutes===minutes);
      label.dataset.available=String(!!c);label.title=c?`${minutes}m lookback: observation at ${gexTime(c.snapshot.asOfMS)} ET`:`${minutes}m: no usable observation within 90 seconds before the target time`;
      label.querySelector('span').textContent=`${minutes}m${c?'':' —'}`;
    }
    this.get('changes').replaceChildren();
    if(!comparison)this.get('changes').textContent=`${selectedMinutes}m comparison unavailable: no usable recording near that time.`;
    else {
      for(const change of changes.slice(0,5)){
        const item=node('span','gh-change');item.append(node('strong','',price(change.strike)),node('span','',`Δ ${gexMoney(change.delta)}`));
        item.title=`${gexMoney(change.prior)} at ${gexTime(comparison.snapshot.asOfMS)} ET → ${gexMoney(change.net)} at ${gexTime(r.asOfMS)} ET`;this.get('changes').append(item);
      }
      if(!changes.length)this.get('changes').textContent='No comparable strikes. Missing strike values are not treated as zero.';
    }
    this.paintTrend(points,r?.asOfMS);
    const profile=this.get('profile');profile.replaceChildren();
    if(!view?.usable){this.get('profile-heading').textContent=message||view?.reason||'Enable GEX during the session to record observations for review.';return;}
    const enabled=new Set([...this.get('legend').querySelectorAll('input:checked')].map(e=>Number(e.value)));
    const prior=comparisons.filter(c=>enabled.has(c.minutes)).map(c=>({...c,byStrike:new Map(c.snapshot.strikes.map(b=>[b.strike,b]))}));
    const rows=r.strikes.filter(b=>Math.abs(b.strike/r.spot-1)<=.1).map(b=>({...b,peak:Math.max(Math.abs(b.net),...prior.map(c=>Math.abs(c.byStrike.get(b.strike)?.net||0)))}))
      .sort((a,b)=>b.peak-a.peak||a.strike-b.strike).slice(0,60).sort((a,b)=>b.strike-a.strike);
    const scale=Math.max(0,...rows.map(b=>b.peak));
    this.get('profile-heading').textContent=`${rows.length} strikes · largest concentrations within ±10% of snapshot spot · common scale ±${gexMoney(scale,false)}`;
    for(const b of rows){
      const row=node('div','gh-profile-row');row.setAttribute('role','listitem');row.dataset.strike=String(b.strike);
      const track=node('div','gh-track');const bar=node('i','gh-bar');bar.dataset.sign=b.net<0?'negative':'positive';
      bar.style.left=`${50+(b.net<0&&scale?b.net/scale*50:0)}%`;bar.style.width=`${scale?Math.abs(b.net)/scale*50:0}%`;track.append(bar);
      const descriptions=[`${price(b.strike)} · now ${gexMoney(b.net)} at ${gexTime(r.asOfMS)} ET`];
      for(const c of [...prior].reverse()){
        const old=c.byStrike.get(b.strike);if(!old)continue;
        const dot=node('i','gh-dot');dot.style.left=`${50+(scale?old.net/scale*50:0)}%`;dot.style.background=GEX_HISTORY_COLORS[c.minutes];dot.dataset.minutes=String(c.minutes);
        dot.title=`${c.minutes}m prior: ${gexMoney(old.net)} at ${gexTime(c.snapshot.asOfMS)} ET · change ${gexMoney(b.net-old.net)}`;descriptions.push(dot.title);track.append(dot);
      }
      const value=node('strong','gh-amount',gexMoney(b.net));value.dataset.sign=b.net<0?'negative':'positive';
      row.append(node('strong','gh-strike',price(b.strike)),track,value);row.title=descriptions.join('\n');profile.append(row);
    }
  }
  paintTrend(points,selected){
    const target=this.get('trend');target.replaceChildren();const usable=points.filter(p=>p.net!==null);
    if(!usable.length)return;
    target.append(node('figcaption','',`Recorded net GEX · ${gexMoney(usable[0].net)} → ${gexMoney(usable.at(-1).net)} · gaps remain blank`));
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 800 90');svg.setAttribute('role','img');svg.setAttribute('aria-label','Net estimated GEX over the recorded session');
    const first=points[0].asOfMS,span=Math.max(1,points.at(-1).asOfMS-first),lo=Math.min(...usable.map(p=>p.net)),hi=Math.max(...usable.map(p=>p.net)),range=Math.max(1,hi-lo);
    const x=p=>8+(p.asOfMS-first)/span*784,y=p=>78-(p.net-lo)/range*66;
    let d='',last=null;
    for(const p of points){if(p.net===null){last=null;continue;}d+=`${last&&p.asOfMS-last.asOfMS<=90000?'L':'M'}${x(p).toFixed(2)},${y(p).toFixed(2)} `;last=p;}
    const path=document.createElementNS(ns,'path');path.setAttribute('d',d);path.setAttribute('class','gh-trend-line');svg.append(path);
    for(const p of usable){const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',x(p));dot.setAttribute('cy',y(p));dot.setAttribute('r',p.asOfMS===selected?'4':'1.8');dot.setAttribute('class',p.asOfMS===selected?'gh-selected-dot':'gh-trend-dot');const title=document.createElementNS(ns,'title');title.textContent=`${gexTime(p.asOfMS)} ET · ${gexMoney(p.net)}`;dot.append(title);svg.append(dot);}
    target.append(svg);
  }
}
