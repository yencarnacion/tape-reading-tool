// Verify fractional quantities in the actual Time & Sales UI. Local fixture only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
const root=resolve('internal/server/web'),out=process.env.TAPE_SIZE_SCREENSHOT_DIR||'/tmp/fractional-tape-ui';
await mkdir(out,{recursive:true});
const start=Date.parse('2026-10-05T14:17:02Z'),began=Date.now();
let mode='live',symbol='QQQ',generation=1;
const tapeSide=-1;
const peers=new Set();
const now=()=>start+Date.now()-began;
function frame(value){const data=Buffer.from(JSON.stringify(value));const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);return Buffer.concat([header,data]);}
function snapshot(){const at=now();return {type:'snapshot',symbol,server_time_ms:at,market_chart:true,xtra:true,
 snapshot:{symbol,generation,quote:{bid:747.69,ask:747.71,bid_size:100,ask_size:100,previous_close:749.58},trades:[mode==='live'?0.013374:0.25,0.000001,0.999999,1,1.25,25.5,250,0].map((z,i)=>({s:i+1,t:at-700+i*100,r:(at-700+i*100)*1000,p:747.7,z,c:'bid',d:tapeSide,b:747.7,a:747.71})),history:[symbol],status:{mode,state:mode==='live'?'live':'paused',connected:true}},
 display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};}
function sendSnapshot(){for(const p of peers)p.write(frame(snapshot()));}
function json(w,data,status=200){w.writeHead(status,{'Content-Type':'application/json'});w.end(JSON.stringify(data));}
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/api/panel-data/options-flow')){json(res,{schemaVersion:1,status:'unavailable',symbol});return;}
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
const target=`http://127.0.0.1:${server.address().port}`,debug=9476,profile=`/tmp/fractional-chrome-${process.pid}`;
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
 for (const [width, height] of [[1440,900],[1280,800],[1024,768],[800,700]]) {
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:target});
  await waitFor(`document.querySelectorAll('#tapeRows .tape-row:not([hidden])').length===8`);
  const rows = await evaluate(`[...document.querySelectorAll('#tapeRows .tape-row:not([hidden]) span:last-child')].map(e=>({text:e.textContent,title:e.title,label:e.getAttribute('aria-label'),width:e.clientWidth,scroll:e.scrollWidth}))`);
  assert.deepEqual(rows.map(r=>r.text),['—','250','25.5','1.25','1','<1','<1','<1']);
  assert.equal(rows[7].title,'0.013374 shares');
  assert.equal(rows[6].title,'0.000001 shares');
  assert.equal(rows[0].title,'Size unavailable in this record');
  for (const row of rows) {assert.equal(row.label,row.title);assert.ok(row.scroll<=row.width+1,`size clipped at ${width}: ${JSON.stringify(row)}`);}
  console.log(JSON.stringify({width,height,rows}));
 }
 mode='replay';generation++;sendSnapshot();
 await waitFor(`[...document.querySelectorAll('#tapeRows .tape-row:not([hidden]) span:last-child')].at(-1)?.title==='0.25 shares'`);
 assert.equal(await evaluate(`[...document.querySelectorAll('#tapeRows .tape-row:not([hidden]) span:last-child')].at(-1).title`),'0.25 shares');
 const rect=await evaluate(`document.querySelector('#tapePanel').getBoundingClientRect().toJSON()`);
 const shot=await command('Page.captureScreenshot',{format:'png',clip:{x:rect.x,y:rect.y,width:rect.width,height:230,scale:2}});await writeFile(`${out}/fractional-time-and-sales.png`,Buffer.from(shot.data,'base64'));
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('Browser passed: fractional and legacy sizes, accessible exact quantities, live/replay display, and narrow-column layouts');
} finally {try{ws?.close();}catch{}browser.kill();for(const p of peers)p.destroy();server.closeAllConnections();server.close();await sleep(100);await rm(profile,{recursive:true,force:true});}
