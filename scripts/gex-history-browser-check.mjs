// Isolated dashboard verification. Synthetic by default; optional GEX archive
// supplies real foreground history while the surrounding tape stays synthetic.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
import {gexFixture,negativeGEX,GEX_TIME} from './gex-check.mjs';

const root=resolve('internal/server/web'),out=process.env.GEX_SCREENSHOT_DIR||'/tmp/gex-history-ui';
await mkdir(out,{recursive:true});
let mode='replay',symbol='AAPL',generation=1,scenario='positive',polls=0,hold=false,clock=GEX_TIME,clockAt=Date.now(),stockPrice=100;
let historyPolls=0,controlWrites=0;
const realPath=process.env.GEX_REAL_ARCHIVE;
const realRecords=realPath?(await readFile(realPath,'utf8')).trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.status==='ready'):null;
if(realRecords?.length){symbol=realRecords.at(-1).symbol;clock=realRecords.at(-1).asOfMS;stockPrice=realRecords.at(-1).spot;}
function records(dte){
 if(realRecords)return realRecords.filter(r=>r.maxDTE===dte).map(r=>({...r,generation,replay:true}));
 return Array.from({length:31},(_,i)=>{
  const r=gexFixture(symbol,generation,GEX_TIME-(30-i)*60000,dte);r.replay=true;
  r.call=40000-i*500;r.put=-2500-i*70;r.net=r.call+r.put;r.gross=r.call-r.put;
  r.strikes=[{strike:95,call:0,put:r.put,net:r.put},{strike:100,call:r.call,put:0,net:r.call}];
  r.expiries=[{expiry:'2026-07-31',call:r.call,put:r.put,net:r.net}];return r;
 });
}
function historical(q){
 const dte=Number(q.get('dte')||120),all=records(dte).filter(r=>r.asOfMS<=now()).sort((a,b)=>a.asOfMS-b.asOfMS);
 const at=q.has('at')?Number(q.get('at')):now(),selected=all.filter(r=>r.asOfMS<=at).at(-1);
 if(!selected||scenario==='unavailable')return {symbol,generation,maxDTE:dte,replay:true,status:'replay-unavailable',history:{session:'2026-07-24',timeline:[],comparisons:[]}};
 const r=structuredClone(selected);delete r.history;
 r.history={status:'ready',anchorMS:r.asOfMS,throughMS:now(),session:new Date(r.asOfMS).toLocaleDateString('en-CA',{timeZone:'America/New_York'}),
  timeline:all.map(p=>({asOfMS:p.asOfMS,spot:p.spot,net:p.net,status:'ready'})),comparisons:[]};
 for(const minutes of [1,5,15,30]){
  const targetMS=r.asOfMS-minutes*60000,prior=all.filter(p=>p.asOfMS<=targetMS).at(-1);
  const ready=prior&&targetMS-prior.asOfMS<=90000;
  r.history.comparisons.push({minutes,targetMS,status:ready?'ready':prior?'gap':'no-recording',...(ready?{snapshot:prior}:{})});
 }
 return r;
}
const peers=new Set(),held=[];
const now=()=>mode==='replay'?clock:clock+Date.now()-clockAt;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function frame(value){const data=Buffer.from(JSON.stringify(value));const h=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);return Buffer.concat([h,data]);}
function snapshot(){const at=now();return {type:'snapshot',symbol,server_time_ms:at,market_chart:true,xtra:true,
  snapshot:{symbol,generation,quote:{bid:stockPrice-.01,ask:stockPrice,bid_size:100,ask_size:100,previous_close:99,last_price:stockPrice,last_time_ms:at},
    trades:Array.from({length:301},(_,i)=>({s:i+1,t:at-30000+i*100,r:(at-30000+i*100)*1000,p:stockPrice,z:100,c:'at_ask',d:1,b:stockPrice-.01,a:stockPrice})),history:[symbol],status:{mode,state:mode==='replay'?'paused':'live',connected:true}},
  display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};}
function send(){for(const peer of peers)peer.write(frame(snapshot()));}
function json(res,body){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
const endpointErrors=[];
const server=createServer(async(req,res)=>{try{
  if(req.url.startsWith('/api/panel-data/gex')){
    const q=new URL(req.url,'http://localhost').searchParams;
    const isHistory=req.url.startsWith('/api/panel-data/gex/history');
    if(isHistory)historyPolls++;else polls++;
    const body=historical(q);if(!isHistory)body.replay=mode==='replay';
    if(hold&&isHistory){held.push(()=>json(res,body));return;}
    json(res,body);return;
  }
  if(req.method==='POST'&&req.url.startsWith('/api/'))controlWrites++;
  if(req.url.startsWith('/api/rvol-history')){json(res,{symbol,through_us:now()*1000,bars:[]});return;}
  if(req.url.startsWith('/api/panel-data/')){json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol});return;}
  if(req.url==='/api/forecast'){json(res,{state:'offline',symbol,generation});return;}
  if(req.url.startsWith('/api/')){json(res,{});return;}
  const path=resolve(root,req.url==='/'?'index.html':'.'+new URL(req.url,'http://localhost').pathname);
  if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return;}
  res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)]||'application/octet-stream',
    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self'; worker-src 'self' blob:"});
  res.end(await readFile(path));
}catch(e){endpointErrors.push(String(e));res.writeHead(500);res.end(String(e));}});
server.on('upgrade',(req,socket)=>{
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>peers.delete(socket));socket.write(frame(snapshot()));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const target=`http://127.0.0.1:${server.address().port}`,profile=`/tmp/gex-chrome-${process.pid}`;
const browser=spawn(process.env.CHROME||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--remote-allow-origins=*','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let browserLog='',browserError=null,debugPort=null;
browser.stderr.on('data',chunk=>{browserLog=(browserLog+chunk).slice(-8000);const match=browserLog.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);if(match)debugPort=Number(match[1]);});
browser.on('error',error=>{browserError=error;});
let ws,next=1;const pending=new Map(),errors=[];
function command(method,params={}){return new Promise((resolve,reject)=>{
  const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},10000);
  pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject});ws.send(JSON.stringify({id,method,params}));
});}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function waitFor(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('condition timeout: '+expression+' '+await evaluate('document.body.innerText'));}
const select=id=>evaluate(`(()=>{const p=document.querySelector('#lowerPanelPicker');p.value=${JSON.stringify(id)};p.dispatchEvent(new Event('change'));})()`);
async function capture(name,selector=null){
  const params={format:'png'};
  if(selector){const r=await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);params.clip={x:r.x,y:r.y,width:r.width,height:r.height,scale:1};}
  const shot=await command('Page.captureScreenshot',params);await writeFile(`${out}/${name}.png`,Buffer.from(shot.data,'base64'));
}
async function change(name){scenario=name;generation++;send();}
try{
  let port;for(let i=0;i<100;i++){if(debugPort){port=debugPort;break;}if(browserError||browser.exitCode!==null)break;try{port=Number((await readFile(`${profile}/DevToolsActivePort`,'utf8')).split('\n')[0]);break;}catch{await sleep(100);}}
  if(!port)throw new Error('Chrome did not start: '+(browserError||browserLog));
  const page=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`,{method:'PUT'})).json();
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&pending.has(m.id)){pending.get(m.id).resolve(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  await command('Runtime.enable');await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await command('Page.navigate',{url:target});await waitFor(`document.querySelector('#lowerPanelPicker option[value="estimated-gex"]')`);
  await select('estimated-gex');await waitFor(`document.querySelector('.gex-panel')?.dataset.tone!=='neutral'`);
  await evaluate(`document.querySelector('.gex-history-launch').click()`);
  await waitFor(`document.querySelectorAll('.gh-dot').length>0`);
  if(realRecords){
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1200,deviceScaleFactor:1,mobile:false});
    // Preview the strikes near snapshot spot, including concentrations below it.
    await evaluate(`(()=>{const profile=document.querySelector('.gh-profile'),rows=[...profile.children],spot=${stockPrice};const near=rows.reduce((best,row)=>Math.abs(Number(row.dataset.strike)-spot)<Math.abs(Number(best.dataset.strike)-spot)?row:best);profile.scrollTop=near.getBoundingClientRect().top-profile.getBoundingClientRect().top+profile.scrollTop-profile.clientHeight/2;})()`);
    await capture('gex-history-real-'+symbol,'.gex-history-dialog');
    assert.ok((await evaluate(`document.querySelector('.gh-time-range').textContent`)).includes(new Date(clock).toLocaleDateString('en-CA',{timeZone:'America/New_York'})));
    console.log('Real recorded GEX preview:',symbol,realRecords.length,'snapshots',out);
  }else{
    assert.equal(await evaluate(`document.querySelectorAll('.gh-profile-row').length`),2);
    assert.equal(await evaluate(`document.querySelectorAll('.gh-dot').length`),8);
    assert.match(await evaluate(`document.querySelector('.gh-reading').textContent`),/−\$2.9K/);
    const paused=historyPolls;await sleep(1250);assert.equal(historyPolls,paused,'paused history repeatedly polled');
    for(const [width,height] of [[1440,900],[1280,720],[1000,700],[640,720],[390,700]]){
      await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const layout=await evaluate(`(()=>{const d=document.querySelector('.gex-history-dialog'),r=d.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,overflow:document.documentElement.scrollWidth-innerWidth,inside:d.scrollWidth<=d.clientWidth+1};})()`);
      assert.ok(layout.top>=0&&layout.bottom<=height+1&&layout.right<=width+1&&layout.overflow<=1&&layout.inside,JSON.stringify({width,height,layout}));
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await capture('gex-history-synthetic');
    const beforeWrites=controlWrites;
    await evaluate(`(()=>{const e=document.querySelector('.gh-slider');e.value=2;e.dispatchEvent(new Event('input'));})()`);
    await waitFor(`document.querySelector('.gh-status').textContent==='REVIEW · 09:32:00 ET'`);
    assert.equal(await evaluate(`document.querySelectorAll('.gh-dot').length`),2,'early review borrowed future lookbacks');
    assert.equal(controlWrites,beforeWrites,'history slider sought or controlled the tape');
    await evaluate(`document.querySelector('.gh-next').click()`);await waitFor(`document.querySelector('.gh-status').textContent==='REVIEW · 09:33:00 ET'`);
    await evaluate(`document.querySelector('.gh-prev').click()`);await waitFor(`document.querySelector('.gh-status').textContent==='REVIEW · 09:32:00 ET'`);
    await evaluate(`document.querySelector('.gh-latest').click()`);await waitFor(`document.querySelectorAll('.gh-dot').length===8`);
    await evaluate(`document.querySelector('.gh-close').click()`);const closed=historyPolls;await sleep(1200);assert.equal(historyPolls,closed,'closed history kept polling');
    await evaluate(`document.querySelector('#gexOverlayButton').click()`);
    await waitFor(`window.__tapeReadingGEXOverlay().geometry?.rows.some(r=>r.history.length===4)`);
    await evaluate(`document.querySelector('#gexOverlayHistory').click()`);await waitFor(`document.querySelector('.gex-history-dialog').open&&document.querySelectorAll('.gh-dot').length===8`);
    await evaluate(`document.querySelector('.gh-close').click()`);
    hold=true;await evaluate(`document.querySelector('#gexOverlayHistory').click()`);
    for(let i=0;i<100&&!held.length;i++)await sleep(20);assert.ok(held.length);
    symbol='MSFT';generation++;hold=false;send();await waitFor(`document.querySelector('.gh-reading').textContent.includes('MSFT')`);
    for(const finish of held.splice(0))finish();await sleep(100);assert.match(await evaluate(`document.querySelector('.gh-reading').textContent`),/MSFT/);
    clock=GEX_TIME-10*60000;generation++;send();await waitFor(`document.querySelector('.gh-status').textContent==='LATEST SAVED · 09:50:00 ET'`);
    assert.match(await evaluate(`document.querySelector('.gh-time-range').textContent`),/21 saved snapshots/);
    assert.equal(await evaluate(`document.querySelectorAll('.gh-dot[data-minutes="30"]').length`),0,'rewind borrowed later observations');
    scenario='unavailable';await evaluate(`(()=>{const e=document.querySelector('.gh-scope');e.value='30';e.dispatchEvent(new Event('change'));})()`);
    await waitFor(`document.querySelector('.gh-status').textContent==='NO RECORDED GEX'`);
    assert.equal(await evaluate(`document.querySelectorAll('.gh-profile-row').length`),0,'missing scope retained old bars');
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await evaluate(`document.querySelector('.gex-history-dialog').open`),false);
    // Local tape rewind disables history while its context is changing. Loaded
    // timeline points must clear with the profile, then resume even when paused.
    scenario='ready';
    await evaluate(`(async()=>{const {GEXHistoryDialog}=await import('/gex-history.js');window.__historyContext={symbol:'MSFT',generation:${generation},mode:'replay',status:{state:'paused'},clockUS:${clock*1000},enabled:true};window.__historyProbe=new GEXHistoryDialog({context:()=>window.__historyContext});window.__historyProbe.open(120);})()`);
    await waitFor(`window.__historyProbe.points.length===21`);
    await evaluate(`window.__historyContext.enabled=false;window.__historyProbe.tick()`);
    assert.equal(await evaluate(`window.__historyProbe.points.length`),0,'disabled timeline retained saved points');
    assert.equal(await evaluate(`window.__historyProbe.get('profile').children.length`),0);
    await evaluate(`window.__historyContext.enabled=true;window.__historyProbe.tick()`);
    await waitFor(`window.__historyProbe.points.length===21`);
    await evaluate(`window.__historyContext.mode='idle';window.__historyProbe.tick()`);
    assert.equal(await evaluate(`window.__historyProbe.points.length`),0);
    await evaluate(`window.__historyProbe.stop();window.__historyProbe.dialog.close();window.__historyProbe.dialog.remove()`);
    console.log('GEX history browser checks passed: comparison dots, actual deltas, scrub controls, layouts, overlay integration, closed/paused polling, races and rewind boundaries.');
  }
  assert.deepEqual(endpointErrors,[]);assert.deepEqual(errors,[]);
}finally{
  try{ws?.close();}catch{}browser.kill();for(const peer of peers)peer.destroy();server.closeAllConnections();server.close();
  await sleep(150);await rm(profile,{recursive:true,force:true});
}
