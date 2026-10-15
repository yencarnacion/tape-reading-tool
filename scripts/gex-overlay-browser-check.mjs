// Full-dashboard Chromium regression checks. Prices, options and archives are synthetic.
// Run with CHROME=/path/to/chrome node scripts/gex-overlay-browser-check.mjs.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve, extname} from 'node:path';
import {gexFixture} from './gex-check.mjs';

const root = resolve('internal/server/web');
const out = process.env.GEX_OVERLAY_SCREENSHOT_DIR || '/tmp/gex-overlay-ui';
await mkdir(out, {recursive:true});
const sessionOpen = Date.parse('2026-07-24T13:30:00Z');
let clock = sessionOpen + 45*60000 + 10000, clockAt = Date.now();
let mode = 'live', symbol = 'AAPL', generation = 1, scenario = 'ready', hold = false;
const peers = new Set(), held = [], requests = [], endpointErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => mode === 'replay' ? clock : clock + Date.now() - clockAt;
const history = () => Array.from({length:45}, (_,i) => ({
  time_us:(sessionOpen+i*60000)*1000, open:99.8+Math.sin(i/4)*.4,
  high:101.1, low:98.9, close:100+Math.sin(i/4)*.4, volume:1000+i*20,
  dollar_volume:(100+Math.sin(i/4)*.4)*(1000+i*20)
})).filter(bar => bar.time_us < Math.floor(now()/60000)*60e6);
function fixture(stock, version, stamp, dte) {
  const reply = gexFixture(stock, version, stamp, dte), shift = stock === 'MSFT' ? .1 : 0;
  reply.strikes = [
    {strike:99.5+shift, call:0, put:-10000, net:-10000},
    {strike:100+shift, call:20000, put:0, net:20000},
    {strike:100.25+shift, call:0, put:0, net:0},
    {strike:100.5+shift, call:0, put:-40000, net:-40000},
    // Distant exposure must neither expand the price axis nor shrink visible bars.
    {strike:110+shift, call:500000, put:0, net:500000}
  ];
  reply.call = 520000; reply.put = -50000; reply.net = 470000; reply.gross = 570000;
  reply.coverage = {...reply.coverage, seen:5, included:5};
  reply.expiries = [{expiry:'2026-07-31', call:reply.call, put:reply.put, net:reply.net}];
  if (mode === 'replay') reply.replay = true;
  if (scenario === 'stale') reply.asOfMS = reply.underlyingMS = stamp-90001;
  if (scenario === 'future-snapshot') reply.asOfMS = stamp+1;
  if (scenario === 'future-underlying') reply.underlyingMS = stamp+1;
  if (scenario === 'partial') reply.status = 'poor-coverage';
  if (scenario === 'invalid') reply.net++;
  if (scenario === 'unavailable') { reply.status = 'replay-unavailable'; reply.complete = false; }
  return reply;
}
function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = data.length < 126 ? Buffer.from([0x81,data.length]) : Buffer.from([0x81,126,data.length>>8,data.length&255]);
  return Buffer.concat([header,data]);
}
function snapshot() {
  const at = now(), trades = [];
  for (const bar of history()) {
    for (const [offset,price] of [[0,bar.open],[10000,bar.high],[20000,bar.low],[50000,bar.close]]) {
      trades.push({s:trades.length+1,t:bar.time_us/1000+offset,r:bar.time_us+offset*1000,p:price,z:250,c:'at_ask',d:1});
    }
  }
  trades.push({s:trades.length+1,t:at,r:at*1000,p:100,z:100,c:'at_ask',d:1});
  return {type:'snapshot', symbol, server_time_ms:at, market_chart:true, xtra:true,
    rewind:{enabled:true,buffer_seconds:180,max_prints_per_second:2000,auto_return_seconds:60},
    snapshot:{symbol,generation,trades,history:[symbol],quote:{bid:99.99,ask:100,bid_size:100,ask_size:100,last_price:100,last_time_ms:at,previous_close:99.7},
      status:{mode,state:mode==='replay'?'paused':'live',connected:true}},
    display:{tick_size:1,visible_bars:360,show_chart:true,show_tape:true,tape_rows:90},audio:{enabled:false}};
}
function send() { for (const peer of peers) peer.write(frame(snapshot())); }
function json(res, body) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); }
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/api/panel-data/gex') {
      assert.equal(req.headers.authorization, undefined, 'browser must not receive provider credentials');
      const requestedSymbol = url.searchParams.get('symbol'), dte = Number(url.searchParams.get('dte'));
      assert.ok([30,60,120].includes(dte));
      const stamp = now(), body = fixture(requestedSymbol,generation,stamp,dte);
      requests.push({symbol:requestedSymbol,generation,dte,mode,clock:stamp,scenario});
      if (hold) { held.push(() => json(res,body)); return; }
      json(res,body); return;
    }
    if (['/api/rvol-history','/api/chart-history'].includes(url.pathname)) {
      json(res,{symbol,through_us:Math.floor(now()/60000)*60e6,bars:history()}); return;
    }
    if (url.pathname === '/api/cumulative-rvol') {
      json(res,{symbol,status:'ready',through_us:Math.floor(now()/60000)*60e6,baseline_sessions:['2026-07-17','2026-07-20','2026-07-21','2026-07-22','2026-07-23'],
        points:history().map((bar,i)=>({time_us:bar.time_us,ratio:1+i/50,up:i%2===0}))}); return;
    }
    if (url.pathname === '/api/replay') {
      json(res,{symbol,chart_bars:history(),chart_end_us:now()*1000,replay:{generation,state:'paused'}}); return;
    }
    if (url.pathname === '/api/daily-history') { json(res,{symbol,bars:[]}); return; }
    if (url.pathname.startsWith('/api/panel-data/')) { json(res,{schemaVersion:1,status:'unavailable',bars:[],symbol}); return; }
    if (url.pathname.startsWith('/api/')) { json(res,{}); return; }
    const path = resolve(root,url.pathname === '/' ? 'index.html' : '.'+url.pathname);
    if (!path.startsWith(root+'/')) { res.writeHead(403); res.end(); return; }
    const mime = {'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png'}[extname(path)] || 'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:*; img-src 'self'; worker-src 'self' blob:"});
    res.end(await readFile(path));
  } catch (error) { endpointErrors.push(String(error)); res.writeHead(500); res.end(String(error)); }
});
server.on('upgrade',(req,socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  peers.add(socket); socket.on('close',()=>peers.delete(socket)); socket.on('error',()=>peers.delete(socket)); socket.write(frame(snapshot()));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const target = `http://127.0.0.1:${server.address().port}`, profile = `/tmp/gex-overlay-chrome-${process.pid}`;
const browser = spawn(process.env.CHROME || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'google-chrome'),
  ['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-allow-origins=*','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],
  {stdio:['ignore','ignore','pipe']});
let launchOutput = '', launchError, ws, next = 1;
const pending = new Map(), errors = [];
browser.stderr.on('data',chunk=>{launchOutput=(launchOutput+chunk).slice(-4000);});
browser.on('error',error=>{launchError=error;});
function command(method,params={}) {
  return new Promise((resolve,reject)=>{
    const id=next++, timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},10000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject}); ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const reply=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails)); return reply.result.value;
}
async function waitFor(expression) {
  for(let i=0;i<120;i++) { if(await evaluate(expression)) return; await sleep(75); }
  throw new Error('Condition timeout: '+expression+' '+await evaluate('document.body.innerText'));
}
const debug = `window.__tapeReadingGEXOverlay?.()`;
const ready = `${debug}?.geometry?.rows?.length === 4`;
const empty = `!${debug}?.geometry?.rows?.length`;
const click = id=>evaluate(`document.querySelector(${JSON.stringify('#'+id)}).click()`);
async function change(value) { scenario=value; generation++; send(); }
async function capture(name) {
  const shot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(`${out}/${name}.png`,Buffer.from(shot.data,'base64'));
}
async function layout() {
  return evaluate(`(()=>{
    const chart=window.__tapeReadingChart.state();
    if(chart.scale)delete chart.scale.lastMS;
    return {bars:chart.bars,scale:chart.scale,canvas:document.querySelector('#replayChartCanvas').getBoundingClientRect().toJSON(),
      lower:document.querySelector('#lowerPanelSlot').getBoundingClientRect().toJSON(),
      candles:window.__gexDraw.rects.filter(r=>['#34c7d9','#ff4d5e'].includes(r.color)),
      studies:window.__gexDraw.text.filter(r=>['VOLUME','5D CUM RVOL'].includes(r.text)),
      lowerPanel:document.querySelector('#lowerPanelPicker').value,primary:window.__tapePanelDebug.activePanelId};
  })()`);
}
async function checkGeometry() {
  const data=await evaluate(`(()=>{
    const overlay=window.__tapeReadingGEXOverlay(),canvas=document.querySelector('#replayChartCanvas'),nav=document.querySelector('.market-chart-tabs');
    return {overlay,scale:window.__tapeReadingChart.state().scale,rects:window.__gexDraw.rects.filter(r=>['#59d4c8','#efb06a'].includes(r.color)),
      canvas:canvas.getBoundingClientRect().toJSON(),nav:nav.getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth-innerWidth,
      dayMap:{visible:!document.querySelector('#dayContext').hidden&&getComputedStyle(document.querySelector('#dayContext')).display!=='none',
        rect:document.querySelector('#dayContext').getBoundingClientRect().toJSON()},primary:window.__tapePanelDebug.activePanelId};
  })()`);
  const g=data.overlay.geometry;
  assert.equal(g.rows.length,4,'all visible strikes, including zero net, are represented');
  assert.equal(g.scaleMax,40000,'normalization uses visible strikes, not distant large exposure');
  assert.equal(data.rects.filter(r=>r.width>0).length,3,'nonzero bars were actually painted');
  assert.ok(data.overflow<=1,'dashboard horizontal overflow');
  assert.ok(data.nav.right<=data.canvas.right+1,'chart controls overflow');
  assert.equal(data.primary,'adr-rth-extension','GEX displaced the ADR panel');
  assert.ok(!data.dayMap.visible||data.dayMap.rect.bottom<=data.canvas.top+g.bottom+1,'day map spills into volume/RVOL pane');
  const rates=[];
  for(const row of g.rows) {
    const expected=g.bottom-(row.strike-data.scale.minimum)/(data.scale.maximum-data.scale.minimum)*(g.bottom-g.top);
    assert.ok(Math.abs(row.y-expected)<.01,`strike ${row.strike} does not share the candle price scale`);
    assert.ok(row.y-row.height/2>=g.top-.01&&row.y+row.height/2<=g.bottom+.01,'bar escapes price pane');
    assert.ok(row.x>=g.left-.01&&row.x+row.width<=g.right+.01,'bar escapes horizontal plot area');
    assert.ok(Math.abs((row.net<0?row.x+row.width:row.x)-row.baseline)<.01,'signed bars do not share zero baseline');
    if(!row.net) { assert.equal(row.width,0); continue; }
    const painted=data.rects.find(r=>Math.abs(r.x-row.x)<.01&&Math.abs(r.y-(row.y-row.height/2))<.01&&Math.abs(r.width-row.width)<.01&&Math.abs(r.height-row.height)<.01);
    assert.ok(painted,`debug geometry for ${row.strike} was not painted`);
    assert.equal(painted.color,row.net>0?'#59d4c8':'#efb06a');
    assert.ok(painted.alpha>0&&painted.alpha<1,'bar should leave candles readable');
    rates.push(row.width/Math.abs(row.net));
  }
  assert.ok(rates.every(value=>Math.abs(value-rates[0])<1e-7),'bar widths are not proportional to signed exposure magnitude');
  return data;
}
try {
  let page;
  const deadline=Date.now()+30000;
  while(Date.now()<deadline) {
    if(launchError) throw launchError;
    if(browser.exitCode!==null) throw new Error('Chrome exited: '+launchOutput);
    try {
      const port=(await readFile(`${profile}/DevToolsActivePort`,'utf8')).split('\n')[0];
      page=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT',signal:AbortSignal.timeout(2000)})).json();
      if(page.webSocketDebuggerUrl) break;
    } catch { await sleep(100); }
  }
  assert.ok(page?.webSocketDebuggerUrl,'Chrome failed to start: '+launchOutput);
  ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&pending.has(m.id)){pending.get(m.id).resolve(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__gexDraw={rects:[],text:[]};
    const fillRect=CanvasRenderingContext2D.prototype.fillRect, fillText=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillRect=function(x,y,width,height){
      if(this.canvas.id==='replayChartCanvas') {
        if(x===0&&y===0&&width>100&&height>100) window.__gexDraw={rects:[],text:[]};
        window.__gexDraw.rects.push({x,y,width,height,color:this.fillStyle,alpha:this.globalAlpha});
      }
      return fillRect.apply(this,arguments);
    };
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y){
      if(this.canvas.id==='replayChartCanvas')window.__gexDraw.text.push({text:String(text),x,y});
      return fillText.apply(this,arguments);
    };
  `});
  for(const [width,height] of [[1440,900],[1280,650],[902,720],[800,800]]) {
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:target}); await waitFor(`document.querySelector('#gexOverlayButton')&&window.__tapeReadingPanels?.symbol()==='AAPL'`);
    await evaluate(`localStorage.removeItem('tape-reading-tool.settings.v1')`); await command('Page.reload');
    await waitFor(`window.__tapeReadingChart?.state().bars.length>40&&window.__gexDraw?.text.some(r=>r.text==='VOLUME')`);
    assert.equal(await evaluate(`document.querySelector('#gexOverlayButton').getAttribute('aria-pressed')`),'false');
    const off=requests.length; generation++;send(); await sleep(200); assert.equal(requests.length,off,'default-off overlay fetched');
    const before=await layout();
    await click('gexOverlayButton');await waitFor(ready);await checkGeometry();
    const after=await layout();
    assert.deepEqual(after,before,'overlay changed chart data, price scale, candle positions, pane geometry or panel selection');
    assert.equal(after.lowerPanel,'options-flow');assert.equal(after.primary,'adr-rth-extension');
    assert.equal(await evaluate(`document.querySelector('#gexOverlayScope').value`),'120');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('tape-reading-tool.settings.v1')).showGEXOverlay`),true);
    await capture(`gex-overlay-${width}x${height}`);
    const hover=await evaluate(`(()=>{const r=window.__tapeReadingGEXOverlay().geometry.rows.find(r=>r.net===-40000),c=document.querySelector('#replayChartCanvas').getBoundingClientRect();return {x:c.left+r.x+r.width/2,y:c.top+r.y};})()`);
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...hover});
    await waitFor(`document.querySelector('#replayChartCanvas').title.includes('strike $100.50')`);
    const title=await evaluate(`document.querySelector('#replayChartCanvas').title`);
    assert.match(title,/net −\$40K/);assert.match(title,/per 1% stock move/);assert.match(title,/Calls\+\/puts− assumed/);
    await click('gexOverlayButton');await waitFor(empty);
    assert.deepEqual(await layout(),before,'disabling overlay changed original chart');
    const stopped=requests.length; generation++;send();await sleep(200);assert.equal(requests.length,stopped,'disabled overlay fetched on snapshot');
    await command('Page.reload');await waitFor(`window.__tapeReadingChart?.state().bars.length>40`);
    assert.equal(await evaluate(`document.querySelector('#gexOverlayButton').getAttribute('aria-pressed')`),'false','off choice did not persist');
    console.log(`GEX overlay ${width}x${height}: price alignment, signed proportional bars, zero and distant strikes, unchanged chart and panel layout`);
  }
  await click('gexOverlayButton');await waitFor(ready);
  await evaluate(`(()=>{const s=document.querySelector('#gexOverlayScope');s.value='30';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(`${ready}&&${debug}?.result?.maxDTE===30`);
  await command('Page.reload');await waitFor(ready);
  assert.equal(await evaluate(`document.querySelector('#gexOverlayButton').getAttribute('aria-pressed')`),'true','on choice did not persist');
  assert.equal(await evaluate(`document.querySelector('#gexOverlayScope').value`),'30','scope did not persist');
  assert.equal(requests.at(-1).dte,30);
  // Keep the pointer still while scope changes; the tooltip must follow the data.
  const scopeHover=await evaluate(`(()=>{const r=window.__tapeReadingGEXOverlay().geometry.rows.find(r=>r.net===-40000),c=document.querySelector('#replayChartCanvas').getBoundingClientRect();return {x:c.left+r.x+r.width/2,y:c.top+r.y};})()`);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...scopeHover});
  await waitFor(`document.querySelector('#replayChartCanvas').title.includes('0–30 days')`);
  // A slow request for the previous expiry scope cannot replace the selected scope.
  hold=true;generation++;send();for(let i=0;i<100&&!held.length;i++)await sleep(50);assert.ok(held.length);
  hold=false;
  await evaluate(`(()=>{const s=document.querySelector('#gexOverlayScope');s.value='60';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(`${ready}&&${debug}?.result?.maxDTE===60`);
  for(const release of held.splice(0))release();await sleep(150);
  assert.equal(await evaluate(`${debug}.result.maxDTE`),60,'old scope response replaced current exposure');
  await waitFor(`document.querySelector('#replayChartCanvas').title.includes('0–60 days')`);
  // Enter the existing local rewind through its public UI shortcut; it owns the chart slot.
  await evaluate(`document.activeElement?.blur()`);
  assert.equal(await evaluate(`window.__tapeReadingRewind.state().available`),true);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await waitFor(`window.__tapeReadingRewind.state().active&&${empty}`);
  await click('rewindPlay');
  const rewindPolls=requests.length;await sleep(650);assert.equal(requests.length,rewindPolls,'local rewind fetched current GEX');
  assert.equal(await evaluate(`document.querySelector('#gexOverlayControls').hidden`),true);
  assert.equal(await evaluate(`window.__tapePanelDebug.activePanelId`),'adr-rth-extension');
  await click('rewindExit');await waitFor(ready);
  // A genuinely backgrounded page suspends work and clears current overlay state.
  const background=await command('Target.createTarget',{url:'about:blank',background:false});
  await waitFor(`document.hidden&&${empty}`);
  const hiddenPolls=requests.length;generation++;send();await sleep(650);
  assert.equal(requests.length,hiddenPolls,'background page fetched GEX');
  await command('Page.bringToFront');await waitFor(`!document.hidden&&${ready}`);
  await command('Target.closeTarget',{targetId:background.targetId});
  // Additional volume studies must keep their own geometry and not consume GEX space.
  await click('cumulativeRVOLButton');await waitFor(`window.__gexDraw.text.some(r=>r.text==='5D CUM RVOL')`);await waitFor(ready);await checkGeometry();
  const studies=await layout();await click('gexOverlayButton');await waitFor(empty);assert.deepEqual(await layout(),studies);
  await click('gexOverlayButton');await waitFor(ready);await click('volumeButton');await waitFor(`!window.__gexDraw.text.some(r=>r.text==='VOLUME')`);await checkGeometry();
  await capture('gex-overlay-with-rvol');
  await click('volumeButton');await click('cumulativeRVOLButton');await waitFor(ready);
  await click('dailyChartTab');await waitFor(empty);assert.equal(await evaluate(`document.querySelector('#gexOverlayButton').hidden`),true);
  let stopped=requests.length;generation++;send();await sleep(250);assert.equal(requests.length,stopped,'daily view fetched overlay');
  await click('minuteChartTab');await waitFor(ready);
  // Turning the whole chart off cancels and suspends the overlay.
  await evaluate(`(()=>{const s=document.querySelector('#showChart');s.checked=false;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(empty);stopped=requests.length;generation++;send();await sleep(250);assert.equal(requests.length,stopped,'hidden chart fetched overlay');
  await evaluate(`(()=>{const s=document.querySelector('#showChart');s.checked=true;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await waitFor(ready);
  for(const value of ['partial','invalid','stale']) {
    await change(value);await waitFor(`${debug}?.status&&${debug}.status!=='loading'&&${empty}`);
    assert.equal(await evaluate(`window.__gexDraw.rects.filter(r=>['#59d4c8','#efb06a'].includes(r.color)&&r.width>0).length`),0,'unusable chain left current bars');
    assert.ok((await evaluate(`document.querySelector('#gexOverlayStatus').textContent`)).trim(),'unusable data needs visible status');
  }
  scenario='ready';hold=true;generation++;send();
  for(let i=0;i<100&&!held.length;i++)await sleep(50);assert.ok(held.length,'missing held symbol request');
  symbol='MSFT';generation++;hold=false;send();for(const release of held.splice(0))release();
  await waitFor(`${ready}&&${debug}?.result?.symbol==='MSFT'`);
  assert.deepEqual(await evaluate(`${debug}.geometry.rows.map(r=>r.strike).sort((a,b)=>a-b)`),[99.6,100.1,100.35,100.6],'old symbol response replaced current strikes');
  await checkGeometry();
  hold=true;generation++;send();for(let i=0;i<100&&!held.length;i++)await sleep(50);assert.ok(held.length);
  await click('gexOverlayButton');hold=false;for(const release of held.splice(0))release();await sleep(200);assert.equal(await evaluate(empty),true,'late disabled response painted bars');
  stopped=requests.length;await sleep(600);assert.equal(requests.length,stopped,'disabled overlay resumed polling');
  // Server lookup is bounded by its replay clock; browser must reject a future archive record.
  mode='replay';clock=sessionOpen+44*60000+10000;generation++;send();await click('gexOverlayButton');await waitFor(ready);
  assert.equal(await evaluate(`${debug}.result.replay`),true);
  const paused=requests.length;await sleep(1300);assert.equal(requests.length,paused,'paused replay kept polling');
  for(const [value,status] of [['future-snapshot','invalid-data'],['future-underlying','stale'],['stale','replay-gap'],['unavailable','replay-unavailable']]) {
    await change(value);await waitFor(`${debug}?.status===${JSON.stringify(status)}&&${empty}`);
  }
  scenario='ready';clock-=60000;generation++;send();await waitFor(ready);
  assert.equal(await evaluate(`${debug}.result.asOfMS`),clock,'seek retained the later replay record');
  assert.equal(requests.at(-1).clock,clock);
  await capture('gex-overlay-replay');
  const replayPolls=requests.length;await sleep(1100);assert.equal(requests.length,replayPolls);
  assert.deepEqual(endpointErrors,[]);assert.deepEqual(errors,[]);
  console.log('GEX overlay browser checks passed: canvas geometry, proportional signed strikes, persistence, pane independence, DayMap bounds, live tooltips, stale/invalid data, scope/symbol/off races, local rewind, tab visibility, paused replay and cutoff safety');
} finally {
  try{ws?.close();}catch{}browser.kill();for(const peer of peers)peer.destroy();server.closeAllConnections();server.close();
  await sleep(150);await rm(profile,{recursive:true,force:true});
}
