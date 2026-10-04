// Local-only deterministic preview using the real panel, styles, and host.
// Run: node scripts/options-ui-preview.mjs, then open http://127.0.0.1:18098.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const web=path.resolve('internal/server/web');
const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/options-volatility.css"><style>
body{overflow:auto;padding:24px;color:#dce4ed;font-family:system-ui}h1{font-size:20px}p{color:#aebac8}.preview{container-type:size;position:relative;width:420px;height:360px;max-width:100%;border:1px solid #485568;margin:18px 0;background:#0c0f13}#width{width:80px}nav{display:flex;gap:8px;flex-wrap:wrap}button,select{padding:6px}#result{white-space:pre-wrap;font:12px monospace}.analytics-slot-chrome{z-index:4}
</style></head><body><h1>ADR + Options Vol — synthetic layout preview</h1><p>Production panel and calculations. Fixture data only; no market-data connections.</p><nav><button id="expanding">Expanding</button><button id="divergence">Divergence</button><button id="thin">Thin options</button><button id="offline">options gateway offline</button><button id="replay">Replay</button><label>Panel width <input id="width" type="number" value="420" min="320" max="1100"></label><label>Height <select id="height"><option value="360">360</option><option value="300">300</option><option value="440">440</option></select></label></nav><div class="preview"><div class="analytics-slot-chrome"><label>PANEL</label><select id="picker" aria-label="Analytics panel"></select></div><div id="root" class="analytics-panel-root"></div></div><output id="result"></output><script type="module" src="/fixture.js"></script></body></html>`;
const fixture=`import { PanelHost } from '/panel-host.js'; import { adrRTHManifest } from '/adr-rth-extension-panel.js';
const start=Date.parse('2026-07-24T13:30:00Z');let now=start,mono=1000,scenario='divergence',iv=.6,skew=.1,seq=0;Object.defineProperty(performance,'now',{value:()=>mono});
let snapshot; let host; const root=document.querySelector('#root');
function contracts(){return [99,100,101].flatMap(strike=>['call','put'].map(kind=>({ticker:'O:TEST-'+strike+'-'+kind,expiry:'2026-07-31',kind,strike,iv,delta:kind==='call'?.5:-.5,bid:2,ask:2.1,quoteMS:now,timeframe:'REAL-TIME',volume:100,openInterest:500}))).concat([{ticker:'O:PUT25',kind:'put',delta:-.25,strike:95,iv:iv+skew},{ticker:'O:CALL25',kind:'call',delta:.25,strike:105,iv}].map(c=>({...c,expiry:'2026-07-31',bid:2,ask:2.1,quoteMS:now,timeframe:'REAL-TIME',volume:100,openInterest:500})));}
const settle=()=>new Promise(r=>setTimeout(r,0));
async function run(next){scenario=next;now=start;mono=1000;seq=0;iv=.6;skew=.1;
 snapshot={symbol:'TEST',generation:1,mode:next==='replay'?'replay':'live',status:{connected:true,state:next==='replay'?'paused':'stream'},clockUS:now*1000,trades:[]};
 host?.active?.instance?.unmount();
 const capabilities={currentSnapshot:()=>snapshot,savePanelSettings(){},
 getCompletedDailyBars:async()=>({bars:Array.from({length:20},(_,i)=>({sessionDateET:'2026-06-'+String(i+1).padStart(2,'0'),open:100,high:100.5,low:100,close:100.2,complete:true}))}),
 getRTHSessionContext:async()=>({schemaVersion:1,symbol:'TEST',sessionDateET:'2026-07-24',open:100,low:100,high:100,last:100,status:'ready',completeFromRTHOpen:true}),
 getOptionsSnapshot:async()=>({schemaVersion:1,symbol:'TEST',generation:1,status:scenario==='offline'?'gateway-offline':'ready',asOfMS:now,spot:snapshot.trades.at(-1)?.p || 100,contracts:scenario==='thin'?contracts().map(c=>({...c,bid:0})):contracts()})};
 host=new PanelHost({root,picker:document.querySelector('#picker'),registry:[adrRTHManifest],capabilities,settings:{slots:{},settings:{'adr-rth-extension':{directionMode:'high',lookbackSessions:20}}},saveSettings(){}});host.swap('adr-rth-extension',false);await settle();
 for(let i=0;i<=310;i++) {now=start+i*1000;mono+=1000;iv=next==='expanding'?.6+i*.0006:i<180?.6+i*.001:.78-(i-180)*.001;skew=i<180?.10:.10-(i-180)*.0003;
  const trade={s:++seq,t:now,p:100-i*.002,z:i<280?100:30,d:-1};snapshot={...snapshot,clockUS:now*1000,trades:[trade]};host.event({type:'tradeBatch',symbol:'TEST',trades:[trade],clockUS:now*1000});host.render(now*1000);await settle(); }
 mono+=300;host.render(now*1000);document.querySelector('#result').textContent='Scenario: '+next+' · '+root.querySelector('.vol-state').textContent+' · ADR '+root.querySelector('.adr-value').textContent;
}
for(const id of ['expanding','divergence','thin','offline','replay'])document.querySelector('#'+id).addEventListener('click',()=>run(id));
document.querySelector('#width').addEventListener('change',e=>document.querySelector('.preview').style.width=Math.max(320,Number(e.target.value))+'px');
document.querySelector('#height').addEventListener('change',e=>document.querySelector('.preview').style.height=e.target.value+'px');
await run('divergence');`;
http.createServer(async(req,res)=>{try {const pathname=new URL(req.url,'http://localhost').pathname; if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return}if(pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(fixture);return}const file=path.resolve(web,'.'+pathname);if(!file.startsWith(web+path.sep)) {res.writeHead(403);res.end();return}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(file));}catch{res.writeHead(404);res.end();}}).listen(18098,'127.0.0.1',()=>console.log('Synthetic panel preview http://127.0.0.1:18098'));
