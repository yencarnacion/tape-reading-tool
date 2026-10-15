// Isolated full-dashboard verification. All prices/options are synthetic fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,extname} from 'node:path';
import {gexFixture,negativeGEX,GEX_TIME} from './gex-check.mjs';

const root=resolve('internal/server/web'),out=process.env.GEX_SCREENSHOT_DIR||'/tmp/gex-ui';
await mkdir(out,{recursive:true});
let mode='live',symbol='AAPL',generation=1,scenario='positive',polls=0,hold=false,clock=GEX_TIME,clockAt=Date.now(),stockPrice=100;
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
    polls++;assert.equal(req.headers.authorization,undefined,'no browser credentials');
    const q=new URL(req.url,'http://localhost').searchParams;assert.equal(q.get('symbol'),symbol);
    const dte=Number(q.get('dte'));assert.ok([30,60,120].includes(dte));
    let body=gexFixture(symbol,generation,now(),dte);
    if(scenario==='negative')body=negativeGEX(body);
    if(scenario==='partial'){body.status='poor-coverage';body.coverage.missingGamma=1;}
    if(scenario==='stale')body.status='stale';
    if(scenario==='unavailable'){body.status='replay-unavailable';body.complete=false;body.net=body.gross=body.call=body.put=null;}
    if(mode==='replay')body.replay=true;
    if(hold){held.push(()=>json(res,body));return;}json(res,body);return;
  }
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
async function capture(name,panel=false){
  const params={format:'png'};
  if(panel){const r=await evaluate(`document.querySelector('#lowerPanelSlot').getBoundingClientRect().toJSON()`);params.clip={x:r.x,y:r.y,width:r.width,height:r.height,scale:2};}
  const shot=await command('Page.captureScreenshot',params);await writeFile(`${out}/${name}.png`,Buffer.from(shot.data,'base64'));
}
async function change(name){scenario=name;generation++;send();}
try{
  let port;for(let i=0;i<100;i++){if(debugPort){port=debugPort;break;}if(browserError||browser.exitCode!==null)break;try{port=Number((await readFile(`${profile}/DevToolsActivePort`,'utf8')).split('\n')[0]);break;}catch{await sleep(100);}}
  if(!port)throw new Error('Chrome did not start: '+(browserError||browserLog||`exit ${browser.exitCode}`));
  const page=await(await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`,{method:'PUT'})).json();
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id&&pending.has(m.id)){pending.get(m.id).resolve(m.result);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  await command('Runtime.enable');await command('Page.enable');
  let first=true;
  for(const [width,height] of [[1440,900],[1280,800],[1470,850],[1280,720],[1280,650]]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url:target});await waitFor(`document.querySelector('#lowerPanelPicker option[value="estimated-gex"]')`);
    if(first){assert.equal(await evaluate(`document.querySelector('#lowerPanelPicker').value`),'options-flow');first=false;}
    await select('options-flow');
    const before=await evaluate(`document.querySelector('#lowerPanelSlot').getBoundingClientRect().toJSON()`);
    await select('estimated-gex');await waitFor(`document.querySelector('.gex-panel')?.dataset.tone==='dampen'`);
    const layout=await evaluate(`(()=>{const p=document.querySelector('.gex-panel'),slot=document.querySelector('#lowerPanelSlot');return {
      slot:slot.getBoundingClientRect().toJSON(),primary:window.__tapePanelDebug.activePanelId,
      vertical:p.scrollHeight-p.clientHeight,horizontal:p.scrollWidth-p.clientWidth,body:document.documentElement.scrollWidth-innerWidth,
      overlap:document.querySelector('.gex-details').getBoundingClientRect().bottom-document.querySelector('.gex-bias').getBoundingClientRect().top,
      pickerOverlap:document.querySelector('.gex-details').getBoundingClientRect().right-document.querySelector('#lowerPanelPicker').getBoundingClientRect().left,
      text:p.innerText,headline:document.querySelector('.gex-bias').scrollWidth-document.querySelector('.gex-bias').clientWidth};})()`);
    assert.equal(layout.primary,'adr-rth-extension');assert.equal(layout.slot.height,before.height,'extra chart space taken');
    assert.ok(layout.slot.height<=129);assert.ok(layout.vertical<=1,'vertical clipping');assert.ok(layout.horizontal<=1,'horizontal clipping');
    assert.ok(layout.body<=1,'dashboard overflow');assert.ok(layout.overlap<=0,'Details overlaps headline');assert.ok(layout.pickerOverlap<=0,'Details overlaps picker');
    assert.ok(layout.headline<=1,'headline clipped');console.log(JSON.stringify({width,height,...layout}));
    await capture(`gex-synthetic-${width}x${height}`);
  }
  await capture('gex-synthetic-positive',true);
  assert.match(await evaluate(`document.querySelector('.gex-positive-distance').textContent`),/at last · \+\$20K/);
  assert.match(await evaluate(`document.querySelector('.gex-negative-distance').textContent`),/5\.0% below last · −\$5K/);
  assert.match(await evaluate(`document.querySelector('.gex-assumption').textContent`),/NO PRICE TARGET/);
  for(const [name,tone,label] of [['negative','amplify','⇅ EXPANSION BIAS'],['partial','neutral','PARTIAL • NO BIAS'],['stale','neutral','GEX STALE • NO BIAS']]){
    await change(name);await waitFor(`document.querySelector('.gex-bias')?.textContent===${JSON.stringify(label)}`);
    assert.equal(await evaluate(`document.querySelector('.gex-panel').dataset.tone`),tone);
    if(tone==='neutral')assert.equal(await evaluate(`document.querySelector('.gex-net').textContent`),'—');
    await capture('gex-synthetic-'+name,true);
    if(tone==='neutral'){
      await evaluate(`document.querySelector('.gex-details').click()`);
      assert.equal(await evaluate(`document.querySelectorAll('.gex-profile-row').length`),0,'unusable data displayed a current strike profile');
      assert.match(await evaluate(`document.querySelector('.gex-profile').textContent`),/No current strike profile/);
      await evaluate(`document.querySelector('.gex-close').click()`);
    }
  }
  await change('positive');await waitFor(`document.querySelector('.gex-panel')?.dataset.tone==='dampen'`);
  await evaluate(`document.querySelector('.gex-details').click()`);assert.equal(await evaluate(`document.querySelector('.gex-dialog').open`),true);
  const details=await evaluate(`(()=>{const d=document.querySelector('.gex-dialog');return {rect:d.getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth-innerWidth,text:d.innerText};})()`);
  assert.ok(details.rect.top>=0&&details.rect.bottom<=650);assert.ok(details.overflow<=1);assert.match(details.text,/Open interest cannot identify dealer inventory/);assert.match(details.text,/prior-trading-day/);
  assert.match(details.text,/No mean price or reversion target/);
  assert.match(details.text,/100% of gross exposure/);
  const profile=await evaluate(`Array.from(document.querySelectorAll('.gex-profile-row'),r=>({text:r.innerText,sign:r.dataset.sign,width:r.querySelector('.gex-profile-bar').getBoundingClientRect().width}))`);
  assert.equal(profile.length,2);assert.match(profile[0].text,/\$95\.00/);assert.match(profile[1].text,/\$100\.00/);
  assert.equal(profile[0].sign,'negative');assert.equal(profile[1].sign,'positive');assert.ok(profile.every(r=>r.width>0));
  await capture('gex-synthetic-details-1280x650');
  stockPrice=100.5;send();
  await waitFor(`document.querySelector('.gex-positive-distance')?.textContent.includes('0.5% below last')`);
  assert.match(await evaluate(`document.querySelector('.gex-profile figcaption').textContent`),/Last \$100\.50/);
  assert.match(await evaluate(`document.querySelector('.gex-profile figcaption').textContent`),/snapshot spot \$100\.00/);
  stockPrice=100;send();await waitFor(`document.querySelector('.gex-positive-distance')?.textContent.includes('at last')`);
  await evaluate(`(()=>{const s=document.querySelector('.gex-dte');s.value='30';s.dispatchEvent(new Event('change'));})()`);
  await waitFor(`document.querySelector('.gex-assumption')?.textContent.includes('0–30D')&&document.querySelector('.gex-panel').dataset.tone==='dampen'`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('tape-reading-tool.settings.v1')).panels.settings['estimated-gex'].maxDTE`),30);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await evaluate(`document.querySelector('.gex-dialog').open`),false);
  // A cancelled response for the old stock cannot overwrite the new stock.
  hold=true;generation++;send();
  for(let i=0;i<100&&!held.length;i++)await sleep(100);assert.ok(held.length,'no held GEX request');
  symbol='MSFT';generation++;hold=false;send();for(const finish of held.splice(0))finish();
  await waitFor(`document.querySelector('.gex-panel')?.dataset.tone==='dampen'&&window.__tapeReadingPanels.symbol()==='MSFT'`);
  await evaluate(`document.querySelector('.gex-details').click()`);assert.match(await evaluate(`document.querySelector('.gex-facts').innerText`),/MSFT · 0–30/);
  await evaluate(`document.querySelector('.gex-close').click()`);
  // Paused replay does a recorded-snapshot lookup once, with no repeated polling.
  mode='replay';clock=GEX_TIME;generation++;send();
  await waitFor(`document.querySelector('.gex-coverage')?.textContent.includes('REPLAY')`);const pausedPolls=polls;
  await sleep(1300);assert.equal(polls,pausedPolls,'paused replay kept polling');
  clock-=60000;generation++;scenario='unavailable';send();await waitFor(`document.querySelector('.gex-bias')?.textContent==='NO RECORDED GEX'`);
  assert.equal(await evaluate(`document.querySelector('.gex-panel').dataset.tone`),'neutral');await capture('gex-synthetic-no-recorded-replay',true);
  await select('tick-chart');await sleep(100);const off=polls;await sleep(1300);assert.equal(polls,off,'deselected GEX polled');
  assert.equal(await evaluate(`document.querySelectorAll('.gex-dialog').length`),0,'dialog leaked on unmount');
  await select('estimated-gex');await command('Page.navigate',{url:target});await waitFor(`window.__tapePanelSlotsDebug?.lowerAnalytics?.activePanelId==='estimated-gex'&&document.querySelector('.gex-assumption')?.textContent.includes('0–30D')`);
  assert.match(await evaluate(`document.querySelector('.gex-assumption').textContent`),/0–30D/);
  assert.deepEqual(endpointErrors,[]);assert.deepEqual(errors,[]);
  console.log('GEX browser checks passed: compact layouts, redundant colors/arrows, details, scope persistence, stock races, paused replay, seeks and cleanup');
}finally{
  try{ws?.close();}catch{}browser.kill();for(const peer of peers)peer.destroy();server.closeAllConnections();server.close();
  await sleep(150);await rm(profile,{recursive:true,force:true});
}
