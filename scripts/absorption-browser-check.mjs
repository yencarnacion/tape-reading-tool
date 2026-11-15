// Drives the actual chart against a replay server and an isolated Friday DB.
// TAPE_ABSORPTION_URL=http://127.0.0.1:8099 TAPE_ABSORPTION_REPORT=/tmp/report.json
// CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/absorption-browser-check.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const url=process.env.TAPE_ABSORPTION_URL||'http://127.0.0.1:8099';
const report=JSON.parse(readFileSync(process.env.TAPE_ABSORPTION_REPORT,'utf8'));
const out=process.env.TAPE_ABSORPTION_SCREENSHOTS||'/private/tmp/tape-absorption-screenshots';mkdirSync(out,{recursive:true});
const zone=report.zones.find(z=>z.detected_us>=Number(process.env.TAPE_ABSORPTION_AFTER_US||0)&&z.side==='buy'&&z.held_us>0&&z.broken_us>z.held_us+2e6);
assert.ok(zone,'need a real zone observed testing, held, then broken');
const profile=mkdtempSync(join(tmpdir(),'absorption-chrome-')), port=19449;
const chrome=spawn(process.env.CHROME||'google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--mute-audio','--hide-scrollbars',`--remote-debugging-port=${port}`,'--remote-allow-origins=*',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let ws;let id=0;const pending=new Map(),errors=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn)=>{for(let i=0;i<200;i++){try{const v=await fn();if(v)return v;}catch{}await sleep(50);}throw Error('timeout');};
const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
const post=async(body)=>{const r=await fetch(url+'/api/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json();};
const prepare=at=>post({action:'prepare',symbol:'SNDK',source:'live',provider:'massive',start_us:at,end_us:zone.broken_us+65e6,warmup_us:at-20*60e6,speed:1});
const read=()=>evaluate('window.__tapeReadingAbsorption()');
const frame=at=>evaluate(`window.__tapeReadingRender.frame(${at})`);
const shot=async(name)=>{const r=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});writeFileSync(join(out,name+'.png'),Buffer.from(r.data,'base64'));};
try {
 const pages=await wait(async()=>{const r=await fetch(`http://127.0.0.1:${port}/json/list`);return r.json();});
 ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 ws.onmessage=async event=>{const m=JSON.parse(typeof event.data==='string'?event.data:await event.data.text());if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}};
 await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await prepare(zone.detected_us-1e6);await call('Page.navigate',{url:url+'/?render=1'});await wait(()=>evaluate('window.__tapeReadingRender?.ready()'));
 await frame(zone.detected_us-1e6);assert.ok(!(await read()).zones.some(z=>z.id===zone.id),'no future detection');
 await frame(zone.detected_us+100000);assert.equal((await read()).zones.find(z=>z.id===zone.id)?.state,'TESTING');await shot('sndk-testing');
 await frame(zone.held_us+100000);assert.equal((await read()).zones.find(z=>z.id===zone.id)?.state,'HELD');
 assert.ok((await read()).geometry.length,'zones painted on actual chart');await shot('sndk-held');
 await sleep(1200);assert.equal((await read()).zones.find(z=>z.id===zone.id)?.state,'HELD','paused frame must remain held');
 await call('Emulation.setDeviceMetricsOverride',{width:900,height:850,deviceScaleFactor:1,mobile:false});await sleep(100);await frame(zone.held_us+100000);await shot('sndk-narrow');
 await evaluate("document.getElementById('absorptionButton').click()");await frame(zone.held_us+100000);assert.equal((await read()).enabled,false);assert.equal((await read()).geometry.length,0);
 await call('Page.reload');await wait(()=>evaluate('window.__tapeReadingRender?.ready()'));assert.equal((await read()).enabled,false,'setting persists reload');
 await evaluate("document.getElementById('absorptionButton').click()");await frame(zone.broken_us+100000);assert.equal((await read()).zones.find(z=>z.id===zone.id)?.state,'BROKEN');await shot('sndk-broken');
 await prepare(zone.detected_us-1e6);await frame(zone.detected_us-1e6);assert.ok(!(await read()).zones.some(z=>z.id===zone.id),'backward seek clears future zone');
 await frame(zone.detected_us+100000);assert.equal((await read()).zones.find(z=>z.id===zone.id)?.state,'TESTING','backward rebuild cannot retain later held/broken state');
 // Exercise the normal WebSocket transport too, without render-frame injection.
 await call('Page.navigate',{url});await wait(()=>evaluate('window.__tapeReadingRender?.ready()'));
 const transport=async body=>{const r=await fetch(url+'/api/replay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());return r.json();};
 await transport({action:'start',symbol:'SNDK',source:'live',provider:'massive',start_us:zone.detected_us-2e6,end_us:zone.broken_us+30e6,speed:20});
 await wait(async()=> (await read()).zones.some(z=>z.id===zone.id));
 await transport({action:'pause'});await sleep(1100);
 const frozen=JSON.stringify((await read()).zones);await sleep(1100);assert.equal(JSON.stringify((await read()).zones),frozen,'interactive pause is stable');
 await transport({action:'cue',symbol:'SNDK',source:'live',provider:'massive',start_us:zone.detected_us-60e6,target_us:zone.detected_us-1e6,end_us:zone.broken_us+30e6,speed:1});
 await wait(async()=>{const v=await read();return v.snapshot?.as_of_us<zone.detected_us&&!v.zones.some(z=>z.id===zone.id);});
 assert.deepEqual(errors,[],'browser runtime errors');
 writeFileSync(join(out,'browser-validation.json'),JSON.stringify({passed:true,zone,checks:['before detection','testing','held','paused','narrow viewport','toggle','reload persistence','broken','backward seek','normal WebSocket playback','interactive pause','paused backward cue','no runtime errors']},null,2));
 console.log('Friday SNDK browser checks passed; screenshots: '+out);
} finally {ws?.close();chrome.kill('SIGTERM');await sleep(300);rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
