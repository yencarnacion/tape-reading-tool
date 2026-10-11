// Real full-page Chromium, fabricated market data only. No provider credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, extname } from 'node:path';
const root = resolve('internal/server/web');
const out = process.env.RVOL_SCREENSHOT_DIR || '/tmp/cumulative-rvol-ui';
await mkdir(out,{recursive:true});
const open = Date.parse('2026-10-09T09:30:00-04:00');
const clock = open + 45*60000 + 10000;
let dailyReady = true;
let mode = 'live', symbol = 'AAPL', generation = 1, status = 'ready', requests = 0, hold = false;
const peers = new Set(), held = [];
const bars = Array.from({length:45}, (_,i) => ({time_us:(open+i*60000)*1000,
  open:100+i*.025+Math.sin(i/5)*.35, high:100.2+i*.025+Math.sin(i/5)*.35,
  low:99.85+i*.025+Math.sin(i/5)*.35, close:100.07+i*.025+Math.sin(i/5)*.35,
  volume:1000+i*100, dollar_volume:(100.07+i*.025)*(1000+i*100)}));
function frame(value) {
  const data=Buffer.from(JSON.stringify(value));
  const header=data.length<126?Buffer.from([0x81,data.length]):Buffer.from([0x81,126,data.length>>8,data.length&255]);
  return Buffer.concat([header,data]);
}
function snapshot() {
  const trades = bars.map((b,i)=>({s:i+1,t:b.time_us/1000,r:b.time_us,p:b.close,z:b.volume,c:'at_ask',d:1}));
  trades.push({s:46,t:clock,r:clock*1000,p:101.3,z:230,c:'at_ask',d:1});
  return {type:'snapshot',symbol,server_time_ms:clock,market_chart:true,xtra:true,
    snapshot:{symbol,generation,quote:{bid:101.29,ask:101.31,bid_size:500,ask_size:900,previous_close:100},trades,history:[symbol],status:{mode,state:'live',connected:true}},
    display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};
}
function sendSnapshot() { for (const peer of peers) peer.write(frame(snapshot())); }
function json(res,body) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(body)); }
const server=createServer(async(req,res)=>{
  try {
    if(req.url.startsWith('/api/cumulative-rvol')) {
      assert.equal(req.method,'POST'); requests++;
      const body={symbol,provider:mode==='massive'?'massive':'ibkr',status,session_date:'2026-10-09',through_us:(clock-10000)*1000,
        message:status==='ready'?'Completed minutes':'Need 5 prior sessions (3 available)',
        baseline_sessions:['2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08'],
        points:status==='ready'?bars.map((b,i)=>({time_us:b.time_us,ratio:1+i/44*3.35,up:i%3!==0})):[]};
      if(hold) { held.push(()=>json(res,body)); return; }
      json(res,body); return;
    }
    if(req.url.startsWith('/api/rvol-history')) { json(res,{symbol,through_us:(clock-10000)*1000,bars}); return; }
    if(req.url.startsWith('/api/chart-history')) { json(res,{symbol,through_us:(clock-10000)*1000,bars}); return; }
    if(req.url.startsWith('/api/panel-data/daily-bars')) {
      const dates=[]; let date=new Date('2026-10-08T13:30:00Z');
      while(dates.length<19) { if(date.getUTCDay()!==0 && date.getUTCDay()!==6) dates.unshift(date.toISOString().slice(0,10)); date.setUTCDate(date.getUTCDate()-1); }
      json(res,{schemaVersion:1,status:dailyReady?'ready':'unavailable',symbol,beforeSessionDateET:'2026-10-09',bars:dailyReady?dates.map((day,i)=>({sessionDateET:day,startUS:Date.parse(day+'T13:30:00Z')*1000,complete:true,open:i===18?100:i===17?99:98,high:102,low:97,close:i===18?100:i===17?99:98})):[]}); return;
    }
    if(req.url.startsWith('/api/panel-data/')) { json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol}); return; }
    if(req.url.startsWith('/api/')) { json(res,{}); return; }
    const path=resolve(root,req.url==='/'?'index.html':'.'+new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(root+'/')) { res.writeHead(403); res.end(); return; }
    const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime}); res.end(await readFile(path));
  } catch(error) { res.writeHead(500); res.end(String(error)); }
});
server.on('upgrade',(req,socket)=>{
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  peers.add(socket); socket.on('close',()=>peers.delete(socket)); socket.on('error',()=>peers.delete(socket)); socket.write(frame(snapshot()));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const target=`http://127.0.0.1:${server.address().port}`;
const profile=`/tmp/rvol-chrome-${process.pid}`;
const browser=spawn(process.env.CHROME||'google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-allow-origins=*','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let launchOutput='', launchError;
browser.stderr.on('data', data=>{launchOutput=(launchOutput+data).slice(-2000);});
browser.on('error', error=>{launchError=error;});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let socket,next=1; const pending=new Map(), errors=[];
function command(method,params={}) {
  return new Promise((resolve,reject)=>{
    const id=next++, timer=setTimeout(()=>{pending.delete(id); reject(new Error(`CDP timeout: ${method}`));},10000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});
    socket.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression) {
  for(let i=0;i<100;i++) { if(await evaluate(expression)) return; await sleep(50); }
  throw new Error('condition timeout: '+expression+' '+await evaluate('document.body.innerText'));
}
const labels = text => `window.__rvolLabels?.some(label=>label.text===${JSON.stringify(text)})`;
try {
  let page;
  // Cold GitHub runners may need more than eight seconds to start Chrome.
  // Wait for its actual port rather than assuming a fixed port is available.
  const launchDeadline=Date.now()+30000;
  while(Date.now()<launchDeadline) {
    if(launchError) throw launchError;
    if(browser.exitCode!==null) throw new Error(`Chrome exited ${browser.exitCode}: ${launchOutput}`);
    try {
      const debug=(await readFile(`${profile}/DevToolsActivePort`,'utf8')).split('\n')[0];
      page=await(await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`,{method:'PUT',signal:AbortSignal.timeout(2000)})).json();
      if(page.webSocketDebuggerUrl) break;
      page=null;
    }
    catch { await sleep(100); }
  }
  assert.ok(page,'Chromium failed to start: '+launchOutput);
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  socket.addEventListener('message',({data})=>{
    const message=JSON.parse(data);
    if(message.id && pending.has(message.id)) { pending.get(message.id).resolve(message.result); pending.delete(message.id); }
    if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__rvolLabels=[];
    const fillText=CanvasRenderingContext2D.prototype.fillText, fillRect=CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillText=function(...args) {
      if(this.canvas.id==='replayChartCanvas') window.__rvolLabels.push({text:String(args[0]),x:args[1],y:args[2]});
      return fillText.apply(this,args);
    };
    CanvasRenderingContext2D.prototype.fillRect=function(...args) {
      if(this.canvas.id==='replayChartCanvas' && args[0]===0 && args[1]===0) window.__rvolLabels=[];
      return fillRect.apply(this,args);
    };
  `});
  for(const [width,height] of [[1280,800],[1440,900],[902,720],[800,800]]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:target});
    await waitFor(`window.__tapeReadingPanels?.symbol()==='AAPL'`);
    await evaluate(`localStorage.removeItem('tape-reading-tool.settings.v1')`);
    await command('Page.reload');
    await waitFor(labels('VOLUME'));
    await waitFor(`document.querySelector('#dailyRunValue').textContent==='↑3D*'`);
    assert.ok((await evaluate(`document.querySelector('#dailyBBValue').textContent`)).startsWith('↑'));
    const dailyBox=await evaluate(`(()=>{
      const readout=document.querySelector('#dailyExtensionReadout'), cell=readout.closest('.metric');
      return {bottom:readout.getBoundingClientRect().bottom,cellBottom:cell.getBoundingClientRect().bottom,
        right:Math.max(...[...readout.children].map(x=>x.getBoundingClientRect().right)),cellRight:cell.getBoundingClientRect().right};
    })()`);
    assert.ok(dailyBox.bottom<=dailyBox.cellBottom && dailyBox.right<=dailyBox.cellRight, 'Daily readout overflow '+JSON.stringify(dailyBox));
    const before=requests;
    await sleep(300);
    assert.equal(requests,before,'RVOL off must not fetch');
    assert.equal(await evaluate(`document.querySelector('#cumulativeRVOLButton').getAttribute('aria-pressed')`),'false');
    assert.equal(await evaluate(labels('5D CUM RVOL')),false);
    const original=await evaluate(`window.__rvolLabels.find(label=>label.text==='VOLUME').y`);
    const chartBefore=await evaluate(`window.__tapeReadingChart.state().bars`);
    await evaluate(`document.querySelector('#cumulativeRVOLButton').click()`);
    await waitFor(labels('4.35×'));
    assert.ok(await evaluate(labels('1×')));
    assert.ok(await evaluate(labels('VOLUME')));
    const layout=await evaluate(`(async()=>{
      const {minutePaneLayout}=await import('/cumulative-rvol.js');
      const canvas=document.querySelector('#replayChartCanvas').getBoundingClientRect();
      const pane=minutePaneLayout(canvas.height,true,true);
      const nav=document.querySelector('.market-chart-tabs').getBoundingClientRect();
      const map=document.querySelector('#dayContext');
      return {pane,canvas:canvas.toJSON(),nav:nav.toJSON(),mapVisible:getComputedStyle(map).display!=='none',
        mapBottom:map.getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth-innerWidth};
    })()`);
    assert.ok(layout.pane.priceBottom>layout.pane.top+100,JSON.stringify(layout));
    assert.ok(layout.nav.right<=layout.canvas.right,`toolbar overflow at ${width}`);
    assert.ok(layout.overflow<=1);
    assert.ok(!layout.mapVisible || layout.mapBottom<=layout.canvas.top+layout.pane.priceBottom,'day map cannot overlap volume or RVOL');
    assert.deepEqual(await evaluate(`window.__tapeReadingChart.state().bars`),chartBefore,'RVOL does not modify price/volume bars');
    const screenshot=await command('Page.captureScreenshot',{format:'png'});
    await writeFile(`${out}/rvol-${width}x${height}.png`,Buffer.from(screenshot.data,'base64'));
    await evaluate(`document.querySelector('#volumeButton').click()`);
    await waitFor(`!${labels('VOLUME')} && ${labels('4.35×')}`);
    await command('Page.reload');
    await waitFor(labels('4.35×'));
    assert.equal(await evaluate(`document.querySelector('#volumeButton').getAttribute('aria-pressed')`),'false','volume choice persists');
    await evaluate(`document.querySelector('#cumulativeRVOLButton').click(); document.querySelector('#volumeButton').click()`);
    await waitFor(labels('VOLUME'));
    assert.equal(await evaluate(`window.__rvolLabels.find(label=>label.text==='VOLUME').y`),original,'off restores the original chart geometry');
    await evaluate(`(()=>{const box=document.querySelector('#showDailyExtension');box.checked=false;box.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(`document.querySelector('#dailyExtensionReadout').hidden`);
    await command('Page.reload');
    await waitFor(labels('VOLUME'));
    assert.equal(await evaluate(`document.querySelector('#dailyExtensionReadout').hidden`),true,'daily context toggle persists');
    console.log(`RVOL layout ${width}x${height}: price ${Math.round(layout.pane.priceBottom-layout.pane.top)}px, independent volume/RVOL, no overflow`);
  }
  mode='massive'; generation++; sendSnapshot();
  await evaluate(`document.querySelector('#cumulativeRVOLButton').click()`);
  await waitFor(labels('4.35×'));
  assert.equal(await evaluate(`document.querySelector('#relativeVolume').hidden`),false,'existing RVOL PACE remains');
  status='insufficient'; generation++; sendSnapshot();
  await waitFor(`document.querySelector('#cumulativeRVOLStatus').textContent.includes('3 available')`);
  await waitFor(`!${labels('4.35×')}`);
  assert.ok(await evaluate(labels('VOLUME')),'missing RVOL history leaves volume visible');
  status='ready'; hold=true; generation++; sendSnapshot();
  for(let i=0;i<50 && !held.length;i++) await sleep(50);
  assert.ok(held.length);
  dailyReady=false; symbol='MSFT'; generation++; hold=false; sendSnapshot();
  for(const release of held.splice(0)) release();
  await waitFor(`window.__tapeReadingPanels.symbol()==='MSFT' && ${labels('4.35×')}`);
  await evaluate(`(()=>{const box=document.querySelector('#showDailyExtension');box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor(`document.querySelector('#dailyRunValue').textContent==='—' && document.querySelector('#dailyBBValue').textContent==='—'`);
  await evaluate(`document.querySelector('#dailyChartTab').click()`);
  await sleep(250);
  const dailyRequests=requests;
  assert.equal(await evaluate(`document.querySelector('#cumulativeRVOLButton').hidden`),true);
  await sleep(250); assert.equal(requests,dailyRequests,'hidden study stops fetching');
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('RVOL browser checks passed: default-off, persistence, independent toggles, both feed modes, unavailable history, symbol race, daily view, unchanged candle data.');
} finally {
  try { socket?.close(); } catch {}
  browser.kill(); for(const peer of peers) peer.destroy(); server.closeAllConnections(); server.close();
  await sleep(100); await rm(profile,{recursive:true,force:true});
}
