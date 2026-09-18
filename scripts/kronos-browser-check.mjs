// Full-page Chromium integration with a clearly fabricated local feed/service.
// No private network, market provider, GPU, or trading endpoint is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, extname } from 'node:path';
import { mockForecast } from './kronos-model-check.mjs';
const root = resolve('internal/server/web'), out = process.env.KRONOS_SCREENSHOT_DIR || '/tmp/kronos-ui';
await mkdir(out,{recursive:true});
const start = Date.parse('2026-09-18T14:17:02Z');
let mode = 'live', symbol = 'QQQ', generation = 1, responseState = 'forecast', pollCount = 0, hold = false;
const peers = new Set(), held = [];
function frame(value) {
  const data=Buffer.from(JSON.stringify(value));
  const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);
  return Buffer.concat([header,data]);
}
const trade = (seq=1) => ({s:seq,t:start+seq*50,r:(start+seq*50)*1000,p:600+(seq%5)*.01,z:100,c:'at_ask',d:'buy',b:599.99,a:600});
function snapshot() { return {type:'snapshot',symbol,server_time_ms:start,market_chart:true,xtra:true,
  snapshot:{symbol,generation,quote:{bid:599.99,ask:600,bid_size:100,ask_size:100,previous_close:598},trades:Array.from({length:100},(_,i)=>trade(i)),history:[symbol],status:{mode,state:mode==='live'?'live':'paused',connected:true}},
  display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}}; }
function sendSnapshot(){for(const peer of peers)peer.write(frame(snapshot()));}
function json(w,data,status=200){w.writeHead(status,{'Content-Type':'application/json'});w.end(JSON.stringify(data));}
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/api/forecast'){
      let text='';for await(const c of req)text+=c;
      assert.equal(req.headers['x-tape-forecast'],'1');assert.equal(req.headers.authorization,undefined);
      const sent=JSON.parse(text);assert.equal(sent.symbol,symbol);assert.deepEqual(Object.keys(sent),['symbol']);pollCount++;
      const body={state:responseState,message:responseState==='forecast'?'Fabricated UI test result':'Test service unavailable',symbol,generation,origin_us:(start-2000)*1000,clock_us:start*1000};
      if(responseState==='forecast')body.result=mockForecast(symbol,start-2000);
      if(hold){held.push(()=>json(res,body));return;}json(res,body);return;
    }
    if(req.url.startsWith('/api/rvol-history')){json(res,{symbol,through_us:(start-2000)*1000,bars:[]});return;}
    if(req.url.startsWith('/api/panel-data/')){json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol});return;}
    if(req.url.startsWith('/api/')){json(res,{});return;}
    const path=resolve(root,req.url==='/'?'index.html':'.'+new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
    const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self'; worker-src 'self' blob:"});res.end(await readFile(path));
  }catch(e){res.writeHead(500);res.end(String(e));}
});
server.on('upgrade',(req,socket)=>{
 const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
 peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>peers.delete(socket));socket.write(frame(snapshot()));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${server.address().port}`, debug=9473;
const profile=`/tmp/kronos-chrome-${process.pid}`;
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
 for(const [width,height] of [[1440,900],[1280,800],[1470,956],[1280,720]]){
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:target});
  await waitFor(`document.querySelector('.kronos-above')?.textContent === '63%'`);
  const reading=await evaluate(`(()=>{const slot=document.querySelector('#lowerPanelSlot'),panel=document.querySelector('.kronos-panel'),adr=document.querySelector('#rollingPanel'),clock=document.querySelector('#marketClock');return {width:innerWidth,height:innerHeight,slot:slot.getBoundingClientRect().toJSON(),adr:adr.getBoundingClientRect().toJSON(),clock:clock.getBoundingClientRect().toJSON(),font:parseFloat(getComputedStyle(document.querySelector('.kronos-above')).fontSize),overflow:panel.scrollHeight-panel.clientHeight,primary:window.__tapePanelDebug.activePanelId,bodyOverflow:document.documentElement.scrollWidth-innerWidth,shown:[...panel.querySelectorAll('div,output,span')].filter(e=>e.getClientRects().length&&getComputedStyle(e).display!=='none'&&e.textContent.trim()).map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON()}))};})()`);
  console.log(JSON.stringify(reading));
  assert.equal(reading.primary,'adr-rth-extension');assert.ok(reading.font>=38);assert.ok(reading.bodyOverflow<=1);
  assert.ok(reading.slot.top>=reading.adr.bottom-1,'lower slot overlaps ADR');assert.ok(reading.slot.bottom<=reading.clock.top+1,'lower slot overlaps clock');
  assert.ok(reading.overflow<=1,`forecast vertically clipped (${reading.overflow}px)`);
  const screenshot=await command('Page.captureScreenshot',{format:'png'});await writeFile(`${out}/kronos-mock-${width}x${height}.png`,Buffer.from(screenshot.data,'base64'));
 }
 await evaluate(`document.querySelectorAll('.kronos-controls button')[0].click()`);
 await waitFor(`document.querySelector('.kronos-question').textContent.includes('10:18')`);
 // Inactive plugins stop all polling and the original tick rendering is selectable.
 await evaluate(`(()=>{const p=document.querySelector('#lowerPanelPicker');p.value='tick-chart';p.dispatchEvent(new Event('change'));})()`);
 await sleep(200);const before=pollCount;await sleep(5500);assert.equal(pollCount,before);
 assert.equal(await evaluate(`document.querySelector('#lowerPanelSlot').classList.contains('show-tick-chart')`),true);
 assert.equal(await evaluate(`window.__tapePanelDebug.activePanelId`),'adr-rth-extension');
 await evaluate(`(()=>{const p=document.querySelector('#lowerPanelPicker');p.value='kronos-forecast';p.dispatchEvent(new Event('change'));})()`);
 await waitFor(`document.querySelector('.kronos-above')?.textContent === '63%'`);
 responseState='offline';sendSnapshot();await waitFor(`document.querySelector('.kronos-state strong')?.textContent === 'KRONOS OFFLINE'`);
 assert.equal(await evaluate(`document.querySelector('.kronos-values').hidden`),true);
 responseState='forecast';hold=true;sendSnapshot();await waitFor(`document.querySelector('.kronos-state') !== null`);await sleep(250);
 // Old response arriving after a symbol/generation boundary must never reappear.
 symbol='AAPL';generation=2;sendSnapshot();hold=false;for(const finish of held.splice(0))finish();
 await waitFor(`document.querySelector('.kronos-clock')?.textContent.startsWith('AAPL')`);
 await waitFor(`document.querySelector('.kronos-above')?.textContent === '63%'`);
 mode='replay';generation=3;sendSnapshot();await waitFor(`document.querySelector('.kronos-state strong')?.textContent === 'LIVE HISTORY ONLY'`);
 const paused=pollCount;await sleep(1500);assert.equal(pollCount,paused);
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('kronos browser check: laptop layouts, large type, independent slots, automatic polling, tick rollback, offline, symbol race, and replay isolation passed');
}finally{try{ws?.close();}catch{}browser.kill();for(const peer of peers)peer.destroy();server.closeAllConnections();server.close();await sleep(100);await rm(profile,{recursive:true,force:true});}
