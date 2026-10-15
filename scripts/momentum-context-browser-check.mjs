// Full dashboard at laptop sizes, with exact completed-turn and alert snapshot fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
const root=resolve('internal/server/web'),out=process.env.MOMENTUM_SCREENSHOT_DIR||'/tmp/tape-momentum-ui';
await mkdir(out,{recursive:true});
const start=Date.parse('2026-10-09T14:16:30Z'),began=Date.now();
let mode='live',symbol='QQQ',generation=1;
const tapeSide=-1;
const peers=new Set();
const now=()=>start+Date.now()-began;
function frame(value){const data=Buffer.from(JSON.stringify(value));const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);return Buffer.concat([header,data]);}
const prices=[...Array(7).fill(100),100,100.1,100.2,100.3,100.7,101.5,102.5,101.6,100.4];
const minuteStart=Date.parse('2026-10-09T14:00:00Z')*1000;
let empty=false, carry=true;
function minuteBars(){return empty?[]:prices.map((close,i)=>{const open=i?prices[i-1]:close;return {time_us:minuteStart+i*6e7,open,high:Math.max(open,close)+.01,low:Math.min(open,close)-.01,close,volume:i>=11&&i<=13?400:100};});}
function priorMinutes(){return ['2026-10-08','2026-10-07','2026-10-06','2026-10-05','2026-10-02'].flatMap(date=>Array.from({length:20},(_,i)=>({time_us:Date.parse(date+'T14:00:00Z')*1000+i*6e7,open:100,high:100.01,low:99.99,close:100,volume:100})));}
function dailyBars(){return Array.from({length:90},(_,i)=>{const date=new Date(Date.parse('2026-10-08T00:00:00Z')-i*864e5).toISOString().slice(0,10);return {sessionDateET:date,startUS:Date.parse(date+'T13:30:00Z')*1000,open:100,high:101,low:99,close:100,complete:true};});}
function snapshot(){const at=now();return {type:'snapshot',symbol,server_time_ms:at,market_chart:true,xtra:true,
 alert_context:carry?{symbol,direction:1,as_of_us:minuteStart+15*6e7,clock:'10:15',continuation:22,reversion:77,reversion_direction:-1,industry:'Semiconductors',incomplete:true}:null,
 snapshot:{symbol,generation,quote:{bid:100.39,ask:100.41,bid_size:100,ask_size:100,previous_close:100},trades:empty?[]:Array.from({length:321},(_,i)=>({s:i+1,t:at-32000+i*100,r:(at-32000+i*100)*1000,p:100.4,z:100,c:'bid',d:-1,b:100.39,a:100.41})),history:[symbol],status:{mode,state:mode==='live'?'live':'paused',connected:true}},
 display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};}
function sendSnapshot(){for(const p of peers)p.write(frame(snapshot()));}
function json(w,data,status=200){w.writeHead(status,{'Content-Type':'application/json'});w.end(JSON.stringify(data));}
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/panel-data/options-flow')){json(res,{schemaVersion:1,status:'unavailable',symbol});return;}
 if(req.url.startsWith('/api/rvol-history')){json(res,{symbol,through_us:Math.floor(now()/60000)*6e7,bars:minuteBars()});return;}
 if(req.url.startsWith('/api/chart-history')){json(res,{symbol,through_us:Math.floor(now()/60000)*6e7,bars:[...priorMinutes(),...minuteBars()]});return;}
 if(req.url.startsWith('/api/panel-data/daily-bars')){json(res,{schemaVersion:1,status:'ready',bars:empty?[]:dailyBars(),symbol,beforeSessionDateET:'2026-10-09'});return;}
 if(req.url.startsWith('/api/replay')){json(res,{replay:{symbol,state:'paused',position_us:now()*1000},chart_bars:empty?[]:[...priorMinutes(),...minuteBars()],chart_end_us:now()*1000});return;}
 if(req.url.startsWith('/api/panel-data/')){json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol});return;}
 if(req.url==='/api/forecast'){json(res,{state:'offline',symbol,generation});return;}
 if(req.url.startsWith('/api/')){json(res,{});return;}
 const path=resolve(root,req.url==='/'?'index.html':'.'+new URL(req.url,'http://localhost').pathname);
 if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
 res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self'; worker-src 'self' blob:"});res.end(await readFile(path));
 }catch(e){res.writeHead(500);res.end(String(e));}});
server.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>peers.delete(socket));socket.write(frame(snapshot()));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${server.address().port}`,debug=9487,profile=`/tmp/momentum-chrome-${process.pid}`;
const browser=spawn(process.env.CHROME||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--remote-allow-origins=*',`--remote-debugging-port=${debug}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws, next=1;const pending=new Map(),errors=[];
function command(method,params={}){return new Promise((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`));},10000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function waitFor(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('condition timeout: '+expression+' '+await evaluate('document.body.innerText'));}
try{
 let page;for(let i=0;i<100;i++){try{page=await(await fetch(`http://127.0.0.1:${debug}/json/new?${encodeURIComponent(target)}`,{method:'PUT'})).json();break;}catch{await sleep(100);}}
 if(!page)throw new Error('Chrome failed to start');
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
 await command('Runtime.enable');await command('Page.enable');
 for(const [width,height] of [[1440,800],[1280,720],[1280,650],[1024,640]]){
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:target});
  await waitFor(`document.querySelector('#momentumContext [data-setup]')?.textContent==='↓ TURN' && document.querySelector('#momentumContext [data-rvol]')?.textContent!=='3m VOL —'`);
  assert.equal(await evaluate(`document.querySelector('#momentumContext [data-setup]').dataset.tone`),'down','downward completed turn must use the down color');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#momentumContext [data-setup]')).color`),'rgb(255, 77, 94)');
  assert.match(await evaluate(`document.querySelector('#momentumContext [data-state]').textContent`),/↓ (SELL PUSH|FLOW FLIP|PULLBACK)/,'opposing flow must carry an explicit down arrow');
  const layout=await evaluate(`(()=>{const ctx=document.querySelector('#momentumContext'),rows=document.querySelector('#tapeRows'),rail=document.querySelector('#tapePanel'),chart=document.querySelector('#replayMarketPanel');return {width:innerWidth,height:innerHeight,context:ctx.getBoundingClientRect().toJSON(),tapeHeight:rows.clientHeight,chart:chart.getBoundingClientRect().toJSON(),text:ctx.innerText,overflow:document.documentElement.scrollWidth-innerWidth,readings:[...ctx.querySelectorAll('output,button')].map(e=>({text:e.textContent,width:e.clientWidth,scroll:e.scrollWidth}))};})()`);
  assert.ok(layout.overflow<=1);assert.ok(layout.context.height<=78);assert.ok(layout.tapeHeight>=330,`too few visible tape rows: ${JSON.stringify(layout)}`);
  for(const item of layout.readings)assert.ok(item.scroll<=item.width+1,`clipped context at ${width}: ${JSON.stringify(item)}`);
  assert.ok(layout.chart.width>=390 && layout.chart.height>=450,'market chart became too small');
  const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(`${out}/momentum-${width}x${height}.png`,Buffer.from(shot.data,'base64'));
  await evaluate(`document.querySelector('#momentumContext button').click()`);
  await waitFor(`document.querySelector('#momentumDialog').open`);
  const details=await evaluate(`(()=>{const d=document.querySelector('#momentumDialog');return {text:d.innerText,rect:d.getBoundingClientRect().toJSON(),width:d.clientWidth,scroll:d.scrollWidth};})()`);
  assert.match(details.text,/CONT 22.*MR 77↓/);assert.match(details.text,/alert timestamp/);assert.match(details.text,/Completed turn/);
  assert.ok(details.rect.x>=0 && details.rect.right<=width+1 && details.rect.y>=0 && details.rect.bottom<=height+1 && details.scroll<=details.width+1);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await waitFor(`!document.querySelector('#momentumDialog').open`);
  console.log(JSON.stringify({width,height,tapeRows:Math.floor(layout.tapeHeight/22),text:layout.text}));
 }
 // A symbol with missing history must clear the preceding symbol's turn.
 symbol='EMPTY';empty=true;carry=false;generation++;sendSnapshot();
 await waitFor(`document.querySelector('#tickerInput').value==='EMPTY' && document.querySelector('#momentumContext [data-momentum]').textContent==='—'`);
 assert.ok(!/TURN/.test(await evaluate(`document.querySelector('#momentumContext [data-setup]').textContent`)));
 assert.equal(await evaluate(`document.querySelector('#momentumContext [data-setup]').dataset.tone`),'neutral');
 await evaluate(`document.querySelector('#momentumContext button').click()`);
 assert.ok(!/DaiDai alert snapshot/.test(await evaluate(`document.querySelector('#momentumDialog').innerText`)));
 await evaluate(`document.querySelector('#momentumDialog').close()`);
 // Replay rebuild is frozen at the supplied clock, not the wall clock.
 symbol='QQQ';empty=false;carry=true;mode='replay';generation++;sendSnapshot();
 await waitFor(`document.querySelector('#momentumContext [data-setup]').textContent==='↓ TURN'`);
 assert.ok(errors.length===0,JSON.stringify(errors));
 console.log('Browser passed: laptop fit, readable tape, unchanged charts, exact turn, missing history, snapshot details, Escape and replay.');
}finally{try{ws?.close();}catch{}browser.kill();for(const p of peers)p.destroy();server.closeAllConnections();server.close();await sleep(100);await rm(profile,{recursive:true,force:true});}
