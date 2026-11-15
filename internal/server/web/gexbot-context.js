/* Shared with Tape Reading Tool. Price/flow context, never a calibrated forecast. */
(function(root) {
  'use strict';
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const sign = n => finite(n) ? Math.sign(n) : 0;
  // Preserve API units: transaction DEX is not a stock-volume or cash-spend figure.
  const money = n => !finite(n) ? '—' : `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(n).toLocaleString('en-US',{maximumFractionDigits:2})}`;
  const scopes = {both:'Near + next',gex_zero:'Nearest',gex_one:'Next',gex_full:'0–90D'};
  const expiryLabel = p => p?.kind === 'gex_full' ? '0–90D' : p?.expiry ? `${p.dte === 0 ? 'TODAY' : p.kind === 'gex_one' ? 'NEXT' : 'NEAR'} ${p.expiry.slice(5)}` : p?.kind === 'gex_one' ? 'NEXT' : 'NEAR';
  const empty = status => ({status,usable:false,headline:({'off':'GEXBOT OFF','market-closed':'GEXBOT · MARKET CLOSED','access-denied':'GEXBOT · CHECK KEY / PLAN','not-recorded':'NO RECORDED GEXBOT','unavailable':'GEXBOT UNAVAILABLE','stale':'GEXBOT STALE','loading':'GEXBOT LOADING','preparing-history':'DOWNLOADING GEXBOT HISTORY…','history-unavailable':'GEXBOT HISTORY UNAVAILABLE','waiting-tape':'WAITING FOR LIVE PRICE'})[status] || 'GEXBOT UNAVAILABLE',tone:'neutral',evidence:'',levels:[],windows:[],details:[]});
  function model(reply, clock, spot, scope='both') {
    if (!reply || reply.version!==1 || !finite(clock)) return empty(reply?.status || 'loading');
    if (reply.status!=='ready') return empty(reply.replay&&reply.status==='unavailable'?'not-recorded':reply.status);
    const valid=p=>p.status==='ready' && finite(p.timeMS) && p.timeMS<=clock && clock-p.timeMS<=15000;
    const profiles=(reply.profiles || []).filter(p=>valid(p) && (scope==='both' ? p.kind!=='gex_full' : p.kind===scope));
    if (!profiles.length) return empty(reply.replay ? 'not-recorded' : 'stale');
    if (!finite(spot) || spot<=0) spot=profiles[0].spot;
    if (!finite(spot)||spot<=0) return empty('waiting-tape');
    // Profile price drift matters even when a response has a recent timestamp.
    const usable=profiles.filter(p=>finite(p.spot)&&Math.abs(p.spot/spot-1)<=.02);
    if (!usable.length) return empty('stale');
    const flowKinds=scope==='gex_one' ? ['gex_one'] : scope==='both' ? ['gex_zero','gex_one'] : ['gex_zero'];
    const flows=(reply.flows||[]).filter(f=>flowKinds.includes(f.kind)&&valid(f));
    const windows=[15,60,300].map(seconds=>{
      const parts=flows.map(f=>f.windows?.find(w=>w.seconds===seconds));
      if (flows.length!==flowKinds.length || parts.some(w=>w?.status!=='ready'||!finite(w.delta))) return {seconds,status:'warming',delta:null};
      return {seconds,status:'ready',delta:parts.reduce((a,w)=>a+w.delta,0),agreement:Math.min(...parts.map(w=>w.agreement),Math.abs(parts.reduce((a,w)=>a+w.delta,0))/(parts.reduce((a,w)=>a+Math.abs(w.delta),0)||1)),prior:parts.every(w=>finite(w.prior))?parts.reduce((a,w)=>a+w.prior,0):null};
    });
    const short=windows[0],medium=windows[1],long=windows[2],direction=sign(medium.delta);
    let headline='→ FLOW BUILDING',evidence='Waiting for 60s',tone='neutral';
    if(medium.status==='ready') {
      const aligned=direction && sign(short.delta)===direction;
      headline=direction>0?'↑ BUYING PRESSURE':direction<0?'↓ SELLING PRESSURE':'→ BALANCED FLOW';
      tone=direction>0?'up':direction<0?'down':'neutral';
      evidence=!direction?'Balanced':!aligned?'Mixed windows':long.status==='ready'&&sign(long.delta)===direction&&medium.agreement>=.55?'Strong agreement':medium.agreement<.25?'Low agreement':'Some agreement';
      if (!aligned && short.status==='ready') {headline='↕ MIXED FLOW';tone='neutral';}
    }
    const levels=[];
    for(const p of usable) {
      const rows=(p.strikes||[]).filter(a=>Array.isArray(a)&&finite(a[0])&&a[0]>0&&finite(a[1])&&a[1]!==0);
      const peak=Math.max(0,...rows.map(a=>Math.abs(a[1])));
      const nearby=rows.filter(a=>Math.abs(a[0]/spot-1)<=.05&&Math.abs(a[1])>=peak*.15).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,3);
      for(const [price,value] of nearby) levels.push({price,value,kind:p.kind,expiry:p.expiry,label:expiryLabel(p),strength:peak?Math.abs(value)/peak:0,color:p.kind==='gex_one'?'#70b7ff':p.kind==='gex_full'?'#b8c2d0':'#cd9bff',dash:p.kind==='gex_one',distance:(price/spot-1)*100});
    }
    const candidates=levels.filter(l=>Math.abs(l.distance)<=3 && (!direction || sign(l.distance)===direction));
    const magnet=candidates.sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)||Math.abs(a.distance)-Math.abs(b.distance))[0];
    for(const l of levels) {
      l.role=l===magnet?'MAGNET?':l.price<spot?'SUPPORT?':'RESIST?';
      l.text=`${l.label} ${l.role} ${l.price.toFixed(2)} ${l.strength>=.6?'◆◆◆':l.strength>=.3?'◆◆':'◆'}`;
      l.description=`${l.label}: ${l.price.toFixed(2)}, ${l.distance.toFixed(2)}% from price. ${l.value>0?'Call':'Put'}-dominated classified gamma imbalance. ${Math.round(l.strength*100)}% of this expiry profile’s largest magnitude (strength, NOT win probability). ${l.role==='MAGNET?'?'Largest nearby concentration in the 60s flow direction: a candidate to watch, not a promised destination.':'Potential reaction area based on its location relative to price, not proof that dealers will defend it.'}`;
    }
    const sources=[...new Set([...usable,...flows].map(p=>p.origin))];
    return {status:'ready',usable:true,headline,tone,evidence,levels,windows,scope,spot,
      age:Math.max(...usable.map(p=>Math.max(0,Math.floor((clock-p.timeMS)/1000)))),
      source:sources.includes('provider-history')?'HISTORICAL MODEL':reply.replay?'RECORDED':'LIVE',
      details:[...usable.map(p=>`${expiryLabel(p)} · classified gamma imbalance · as of ${new Date(p.timeMS).toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false})} ET`),
        'Direction = change in cumulative transaction delta over 60s; compare 15s and 5m. This is options buying/selling pressure, not a price forecast or observed dealer hedge.',
        'ΔDEX values retain the provider’s native units; they are changes in classified transaction delta, not dollars spent buying shares.',
        'Evidence describes agreement across windows and flow consistency. It is not a statistically calibrated confidence or chance of success.',
        scope==='gex_full'?'Flow covers the nearest expiry; the level profile covers expirations within 90 days.':'Flow and levels use the selected nearest/next expiry scope.',
        'Purple dotted = nearest expiry; blue dashed = next expiry. Diamonds rank strength within each expiry. Question marks identify potential reaction/attraction areas.',
        reply.recording==='failed'?'RECORDING FAILED · this view may be missing from replay.':'Selected charts record while visible.'].concat(levels.map(l=>l.description))};
  }
  class Controller {
    constructor(url,changed=()=>{},fetcher=(...a)=>fetch(...a)){Object.assign(this,{url,changed,fetcher});this.epoch=0;this.key='';this.reply=null;this.controller=null;this.next=0;this.lastAt=0;this.lastRequest=0;}
    reset(){this.epoch++;this.controller?.abort();this.controller=null;this.key='';this.reply=null;this.lastRequest=0;this.lastAt=0;this.next=0;}
    async fetchAt(c){this.reset();this.key=JSON.stringify([c.symbol,c.mode,c.identity]);this.context=c;this.lastAt=c.at;this.lastRequest=c.at;this.next=Date.now()+2000;await this.load(c);}
    sync(c){
      if(!c.enabled){if(this.key)this.reset();return;}
      const key=JSON.stringify([c.symbol,c.mode,c.identity]);
      if(key!==this.key||(c.replay&&c.at<this.lastAt)){this.reset();this.key=key;}
      this.context=c;this.lastAt=c.at;
      if(this.controller||Date.now()<this.next||(c.replay&&this.lastRequest===c.at))return;
      this.lastRequest=c.at;this.next=Date.now()+(c.replay?200:2000);void this.load(c);
    }
    async load(c){
      const epoch=this.epoch,control=new AbortController();this.controller=control;
      const timer=setTimeout(()=>control.abort(),18000);
      try{
        const q=new URLSearchParams({symbol:c.symbol});if(c.replay)q.set('at',String(Math.floor(c.at)));
        const r=await this.fetcher(this.url+'?'+q,{signal:control.signal,cache:'no-store'});if(!r.ok)throw Error('unavailable');
        const reply=await r.json();if(epoch!==this.epoch)return;
        this.reply=reply.symbol===c.symbol?reply:{status:'unavailable'};
        if(reply.status==='preparing-history'||reply.historyStatus==='preparing-history'){this.lastRequest=0;this.next=Date.now()+2000;}
        if(['off','access-denied','market-closed'].includes(reply.status))this.next=Date.now()+30000;
      }catch{if(epoch===this.epoch){this.reply={status:'unavailable'};this.lastRequest=0;this.next=Date.now()+5000;}}
      finally{clearTimeout(timer);if(epoch===this.epoch){this.controller=null;this.changed();}}
    }
    view(at,spot,scope){const v=model(this.reply,at,spot,scope);return !v.usable&&this.controller?empty('loading'):v;}
  }
  function paintStrip(el,v){
    el.className='gexbot-strip '+v.tone;
    const text=v.usable?`${v.headline} · ${v.evidence} · ΔDEX ${v.windows.map(w=>`${w.seconds===300?'5m':w.seconds+'s'} ${money(w.delta)}`).join('  ')} · ${v.source}${v.age?' '+v.age+'s':''}`:v.headline;
    if(el.textContent!==text)el.textContent=text;el.title=[text,...v.details].join('\n');
  }
  function draw(ctx,v,{left,right,top,bottom,priceY}){
    if(!v.usable)return[];const geometry=[];let previous=-Infinity;
    ctx.save();ctx.font='10px -apple-system, sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';
    const rows=v.levels.map(l=>({...l,y:priceY(l.price)})).filter(l=>finite(l.y)&&l.y>=top+12&&l.y<=bottom-8).sort((a,b)=>a.y-b.y);
    for(const l of rows){
      ctx.strokeStyle=l.color;ctx.globalAlpha=.35+.3*l.strength;ctx.lineWidth=1;ctx.setLineDash(l.dash?[5,4]:[2,3]);ctx.beginPath();ctx.moveTo(left,l.y);ctx.lineTo(right,l.y);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
      if(l.y-previous>=15){const width=Math.min(right-left,ctx.measureText(l.text).width+12);ctx.fillStyle='#10151de8';ctx.fillRect(left,l.y-12,width,15);ctx.fillStyle=l.color;ctx.fillText(l.text,left+4,l.y-1,Math.max(1,width-8));previous=l.y;geometry.push({...l,x:left,width});}
    }ctx.restore();return geometry;
  }
  root.GexbotContext={model,Controller,paintStrip,draw,scopes,expiryLabel,money};
  if(typeof module!=='undefined')module.exports=root.GexbotContext;
})(typeof window!=='undefined'?window:globalThis);
