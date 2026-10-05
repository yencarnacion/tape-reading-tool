// Full dashboard test with synthetic options flow. No provider requests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
import {flowFixture} from './options-flow-check.mjs';
const root=resolve('internal/server/web'),out=process.env.FLOW_SCREENSHOT_DIR||'/tmp/options-flow-ui';
await mkdir(out,{recursive:true});
const start=Date.parse('2026-10-05T14:17:02Z'),began=Date.now();
let mode='live',symbol='QQQ',generation=1,responseState='ready',pollCount=0,hold=false,scenario='bull',tapeSide=-1;
const peers=new Set(),held=[];
const now=()=>start+Date.now()-began;
function frame(value){const data=Buffer.from(JSON.stringify(value));const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);return Buffer.concat([header,data]);}
function snapshot(){const at=now();return {type:'snapshot',symbol,server_time_ms:at,market_chart:true,xtra:true,
 snapshot:{symbol,generation,quote:{bid:599.99,ask:600,bid_size:100,ask_size:100,previous_close:598},trades:Array.from({length:301},(_,i)=>({s:i+1,t:at-30000+i*100,r:(at-30000+i*100)*1000,p:600-i*.001,z:100,c:'at_bid',d:tapeSide,b:599.99,a:600})),history:[symbol],status:{mode,state:mode==='live'?'live':'paused',connected:true}},
 display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};}
function sendSnapshot(){for(const p of peers)p.write(frame(snapshot()));}
function json(w,data,status=200){w.writeHead(status,{'Content-Type':'application/json'});w.end(JSON.stringify(data));}
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/panel-data/options-flow')){pollCount++;assert.equal(req.headers.authorization,undefined);assert.equal(new URL(req.url,'http://localhost').searchParams.get('symbol'),symbol);
  const stamp=now(),body={...flowFixture(symbol,generation),status:responseState,asOfMS:stamp,startedMS:stamp-400000,lastTradeMS:stamp-1000,lastQuoteMS:stamp-500};
  const flip=w=>({...w,callAsk:w.callBid,callBid:w.callAsk,putAsk:w.putBid,putBid:w.putAsk,bull:w.bear,bear:w.bull,net:-w.net});
  if(scenario==='bear'){body.windows=body.windows.map(flip);body.previous15=flip(body.previous15);}
  if(scenario==='mixed'){body.windows=body.windows.map(w=>({...w,callAsk:50000,callBid:40000,putAsk:10000,putBid:0,bull:50000,bear:50000,net:0}));}
  if(scenario==='thin'){body.windows=body.windows.map(w=>({...w,ready:false}));body.status='collecting';}
  if(hold){held.push(()=>json(res,body));return;}json(res,body);return;}
 if(req.url.startsWith('/api/rvol-history')){json(res,{symbol,through_us:now()*1000,bars:[]});return;}
 if(req.url.startsWith('/api/panel-data/')){json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol});return;}
 if(req.url==='/api/forecast'){json(res,{state:'offline',symbol,generation});return;}
 if(req.url.startsWith('/api/')){json(res,{});return;}
 const path=resolve(root,req.url==='/'?'index.html':'.'+new URL(req.url,'http://localhost').pathname);
 if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
 res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self'; worker-src 'self' blob:"});res.end(await readFile(path));
 }catch(e){res.writeHead(500);res.end(String(e));}});
server.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>peers.delete(socket));socket.write(frame(snapshot()));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${server.address().port}`,debug=9475,profile=`/tmp/flow-chrome-${process.pid}`;
const browser=spawn(process.env.CHROME||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--remote-allow-origins=*',`--remote-debugging-port=${debug}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws, next=1;const pending=new Map(),errors=[];
function command(method,params={}){return new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function waitFor(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('condition timeout: '+expression+' '+await evaluate('document.body.innerText'));}
try{
 let page;for(let i=0;i<100;i++){try{page=await(await fetch(`http://127.0.0.1:${debug}/json/new?${encodeURIComponent(target)}`,{method:'PUT'})).json();break;}catch{await sleep(100);}}
 if(!page)throw new Error('Chromium failed to start');
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&pending.has(m.id)){pending.get(m.id).resolve(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
 await command('Runtime.enable');await command('Page.enable');
 const select=async(id)=>evaluate(`(()=>{const p=document.querySelector('#lowerPanelPicker');p.value=${JSON.stringify(id)};p.dispatchEvent(new Event('change'));})()`);
 for(const [width,height] of [[1440,900],[1280,800],[1470,956],[1280,720]]){
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:target});await waitFor(`document.querySelector('#lowerPanelPicker option[value="options-flow"]')`);assert.equal(await evaluate(`document.querySelector('#lowerPanelPicker').value`),'options-flow','Options Flow must mount by default');
  await waitFor(`document.querySelector('.of-verdict')?.textContent === '⇄ TAPE OPPOSES'`);
  const reading=await evaluate(`(()=>{const slot=document.querySelector('#lowerPanelSlot'),panel=document.querySelector('.of-panel');return {width:innerWidth,height:innerHeight,slot:slot.getBoundingClientRect().toJSON(),primary:window.__tapePanelDebug.activePanelId,overflow:panel.scrollHeight-panel.clientHeight,headerOverlap:document.querySelector('.of-toggle').getBoundingClientRect().bottom-document.querySelector('.of-head').getBoundingClientRect().top,bodyOverflow:document.documentElement.scrollWidth-innerWidth,cards:[...document.querySelectorAll('.of-window')].map(e=>({text:e.innerText,width:e.clientWidth,scroll:e.scrollWidth,font:getComputedStyle(e.querySelector('output')).fontSize})),text:panel.innerText};})()`);
  console.log(JSON.stringify(reading));assert.equal(reading.primary,'adr-rth-extension');assert.ok(reading.slot.height<=129);assert.ok(reading.overflow<=1,'panel vertically clipped');assert.ok(reading.headerOverlap<=0,'detail button overlaps headline');assert.ok(reading.bodyOverflow<=1);assert.equal(reading.cards.length,3);for(const c of reading.cards)assert.ok(c.scroll<=c.width+1,'horizon clipped');
  const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(`${out}/flow-synthetic-${width}x${height}.png`,Buffer.from(shot.data,'base64'));
 }
 const capturePanel=async(name)=>{
  const rect=await evaluate(`document.querySelector('#lowerPanelSlot').getBoundingClientRect().toJSON()`);
  const shot=await command('Page.captureScreenshot',{format:'png',clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:2}});
  await writeFile(`${out}/flow-colors-${name}.png`,Buffer.from(shot.data,'base64'));
 };
 await capturePanel('divergence');
 for(const [name,side,relation,expected] of [['bull',1,'aligned','▲ BULLISH FLOW'],['bear',-1,'aligned','▼ BEARISH FLOW'],['mixed',-1,'waiting','↔ MIXED FLOW'],['thin',-1,'waiting','… BUILDING FLOW']]){
  scenario=name;tapeSide=side;sendSnapshot();
  await waitFor(`document.querySelector('.of-direction')?.textContent===${JSON.stringify(expected)} && document.querySelector('.of-verdict')?.dataset.relation===${JSON.stringify(relation)}`);
  assert.equal(await evaluate(`document.querySelector('.of-verdict').dataset.relation`),relation);
  const colors=await evaluate(`[...document.querySelectorAll('.of-window')].map(e=>({side:e.dataset.side,background:getComputedStyle(e).backgroundColor,label:e.querySelector('.of-lean').textContent}))`);
  for(const c of colors)assert.equal(c.side,['mixed','thin'].includes(name)?'neutral':name);
  if(name==='bull'||name==='bear')assert.ok(colors.every(c=>c.background!=='rgb(20, 29, 38)'),'direction needs a colored surface');
  await capturePanel(name);
 }
 scenario='bull';responseState='stale';sendSnapshot();await waitFor(`document.querySelector('.of-direction')?.textContent==='FLOW STALE'`);
 assert.equal(await evaluate(`document.querySelector('.of-panel').dataset.side`),'neutral');assert.equal(await evaluate(`document.querySelector('.of-verdict').hidden`),true);await capturePanel('stale');
 responseState='ready';scenario='bull';tapeSide=-1;sendSnapshot();await waitFor(`document.querySelector('.of-verdict')?.textContent==='⇄ TAPE OPPOSES'`);
 await evaluate(`document.querySelector('.of-toggle').click()`);assert.equal(await evaluate(`document.querySelector('.of-detail').hidden`),false);assert.match(await evaluate(`document.querySelector('.of-breakdown').textContent`),/CALL ASK/);
 await evaluate(`document.querySelector('.of-toggle').click()`);
 await select('tick-chart');await sleep(200);const before=pollCount;await sleep(1500);assert.equal(pollCount,before,'inactive flow polled');assert.equal(await evaluate(`document.querySelector('#lowerPanelSlot').classList.contains('show-tick-chart')`),true);
 await select('kronos-forecast');assert.equal(await evaluate(`window.__tapePanelSlotsDebug.lowerAnalytics.activePanelId`),'kronos-forecast');
 await select('options-flow');responseState='not-entitled';sendSnapshot();await waitFor(`document.querySelector('.of-direction')?.textContent==='OPTIONS ACCESS'`);assert.equal(await evaluate(`document.querySelector('.of-values').hidden`),true);
 responseState='ready';hold=true;sendSnapshot();await sleep(1200);symbol='AAPL';generation=2;sendSnapshot();hold=false;for(const finish of held.splice(0))finish();
 await waitFor(`document.querySelector('.of-basis')?.textContent.startsWith('AAPL') && document.querySelector('.of-verdict')?.textContent==='⇄ TAPE OPPOSES'`);
 mode='replay';generation=3;sendSnapshot();await waitFor(`document.querySelector('.of-direction')?.textContent==='NO FLOW REPLAY'`);const replayPolls=pollCount;await sleep(1200);assert.equal(pollCount,replayPolls,'replay queried live flow');
 mode='demo';generation=4;sendSnapshot();await waitFor(`document.querySelector('.of-direction')?.textContent==='LIVE OPTIONS ONLY'`);
 // Reset returns to Options Flow; a later explicit Kronos choice still persists.
 await select('tick-chart');await evaluate(`document.querySelector('#resetControls').click()`);
 assert.equal(await evaluate(`document.querySelector('#lowerPanelPicker').value`),'options-flow');
 await select('kronos-forecast');await command('Page.navigate',{url:target});await waitFor(`window.__tapePanelSlotsDebug?.lowerAnalytics?.activePanelId==='kronos-forecast'`);
 // Old persisted Kronos defaults upgrade without resetting other settings.
 await evaluate(`(()=>{const key='tape-reading-tool.settings.v1',s=JSON.parse(localStorage.getItem(key));delete s.panels.lowerDefaultId;s.customTicks=73;localStorage.setItem(key,JSON.stringify(s));})()`);
 await command('Page.navigate',{url:target});await waitFor(`window.__tapePanelSlotsDebug?.lowerAnalytics?.activePanelId==='options-flow'`);
 assert.equal(errors.length,0,JSON.stringify(errors));console.log('Options flow browser: compact layouts, stock divergence, detail, slot swaps, entitlement, symbol races and replay isolation passed');
}finally{try{ws?.close();}catch{}browser.kill();for(const p of peers)p.destroy();server.closeAllConnections();server.close();await sleep(100);await rm(profile,{recursive:true,force:true});}
