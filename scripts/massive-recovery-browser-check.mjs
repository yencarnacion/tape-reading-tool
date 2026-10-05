// Verify fractional quantities in the actual Time & Sales UI. Local fixture only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
const root=resolve('internal/server/web'),out=process.env.TAPE_SIZE_SCREENSHOT_DIR||'/tmp/massive-recovery-ui';
await mkdir(out,{recursive:true});
const start=Date.parse('2026-10-05T14:17:02Z'),began=Date.now();
let mode='live',symbol='PCVX',generation=1;
const tapeSide=-1;
const peers=new Set();
const now=()=>start+Date.now()-began;
function frame(value){const data=Buffer.from(JSON.stringify(value));const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);return Buffer.concat([header,data]);}
function snapshot(){const at=now();return {type:'snapshot',symbol,server_time_ms:at,market_chart:true,xtra:true,
 snapshot:{symbol,generation,quote:{bid:75,ask:76,bid_size:100,ask_size:100,previous_close:56.48},trades:[[75,100,15],[1,1,12],[76,100,15],[900,200,12],[74,100,14],[999,1,8]].map(([p,z,f],i)=>({s:i+1,t:at-700+i*100,r:(at-700+i*100)*1000,p,z,f,c:'bid',d:tapeSide,b:75,a:76})),history:[symbol],status:{mode,state:mode==='live'?'live':'paused',connected:true}},
 display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};}
function sendSnapshot(){for(const p of peers)p.write(frame(snapshot()));}
function json(w,data,status=200){w.writeHead(status,{'Content-Type':'application/json'});w.end(JSON.stringify(data));}
let dailyCalls=0;
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/panel-data/options-flow')){json(res,{schemaVersion:1,status:'unavailable',symbol});return;}
 if(req.url.startsWith('/api/daily-history')){dailyCalls++; if(dailyCalls===1){json(res,{error:'temporary outage'},503);return;} json(res,{symbol,bars:Array.from({length:90},(_,i)=>({time_us:(start-86400000*(90-i))*1000,open:75,high:76,low:74,close:75,volume:1000}))});return;}
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
const target=`http://127.0.0.1:${server.address().port}`,debug=9478,profile=`/tmp/massive-chart-chrome-${process.pid}`;
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
 await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await command('Page.navigate',{url:target});
 await waitFor(`window.__tapeReadingChart?.state().bars.length===1`);
 await waitFor(`document.querySelector('#lastPrice').textContent==='76.00'`);
 const initial=await evaluate('window.__tapeReadingChart.state()');
 assert.deepEqual(['open','high','low','close','volume'].map(k=>initial.bars[0][k]),[75,76,74,76,501]);
 assert.ok(initial.scale.maximum<100 && initial.scale.minimum>60,'special prints distorted the price axis');
 const annotations=await evaluate(`[...document.querySelectorAll('#tapeRows .price-excluded')].map(n=>n.title)`);
 assert.equal(annotations.length,4);assert.ok(annotations.some(s=>s.includes('volume only')));
 const at=now();for(const p of peers)p.write(frame({type:'trades',symbol,trades:[{s:7,t:at,r:at*1000,p:80,z:100,f:15,c:'ask',d:1}]}));
 await waitFor(`window.__tapeReadingChart.state().last===80 && document.querySelector('#lastPrice').textContent==='80.00'`);
 const moved=await evaluate('window.__tapeReadingChart.state()');assert.equal(moved.bars[0].close,80,'real moves must not be smoothed away');
 const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(`${out}/massive-candles.png`,Buffer.from(shot.data,'base64'));
 await evaluate(`document.querySelector('#dailyChartTab').click()`);
 await waitFor(`document.querySelector('#dailyChartEmpty').textContent.includes('RETRYING')`);
 await waitFor(`window.__tapeReadingChart.state().daily===90`);
 assert.equal(dailyCalls,2,'daily history should recover automatically from a transient failure');
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('Browser passed: Massive candle OHLCV, stable axis despite extreme special reports, T&S annotations, immediate genuine move, and PCVX daily-history automatic recovery');
} finally {try{ws?.close();}catch{}browser.kill();for(const p of peers)p.destroy();server.closeAllConnections();server.close();await sleep(100);await rm(profile,{recursive:true,force:true});}
