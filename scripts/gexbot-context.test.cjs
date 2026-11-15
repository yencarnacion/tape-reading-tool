const {test}=require('node:test');
const assert=require('node:assert/strict');
const {model,Controller}=require('../internal/server/web/gexbot-context.js');
const at=1794582900000;
function fixture(){return {version:1,symbol:'SNDK',replay:true,status:'ready',profiles:['gex_zero','gex_one'].map((kind,i)=>({kind,status:'ready',timeMS:at,spot:860,expiry:i?'2026-11-20':'2026-11-13',dte:i?7:0,origin:'provider-history',strikes:[[855,-3],[860,1],[865,6]]})),flows:['gex_zero','gex_one'].map(kind=>({kind,status:'ready',timeMS:at,windows:[15,60,300].map(seconds=>({seconds,status:'ready',delta:seconds,agreement:.8,prior:seconds/2}))}))};}
test('actual expiries, direction, strength and stale/future rejection',()=>{
  const r=fixture(),v=model(r,at,860);
  assert.equal(v.evidence,'Strong agreement');assert.equal(v.tone,'up');assert.equal(v.windows[1].delta,120);
  assert.equal(v.source,'HISTORICAL MODEL');assert(v.levels.some(l=>l.label==='NEXT 11-20'));
  assert(v.details.some(s=>s.includes('not a statistically calibrated confidence')));
  assert.equal(model(r,at-1,860).usable,false);assert.equal(model(r,at+16000,860).usable,false);
  assert.equal(model(r,at,900).usable,false);
  r.flows.forEach(f=>f.windows[0].delta=-2);assert.equal(model(r,at,860).tone,'neutral');
  r.flows[0].windows[1].delta=null;assert.equal(model(r,at,860).windows[1].delta,null);
});
test('opposing expiries reduce agreement; missing next does not silently claim combined flow',()=>{
  const r=fixture();r.flows[1].windows.forEach(w=>w.delta=-.9*w.delta);
  assert.notEqual(model(r,at,860).evidence,'Strong agreement');
  r.flows.pop();assert.equal(model(r,at,860).windows[0].delta,null);
  assert.equal(model(r,at,860,'gex_zero').windows[0].delta,15);
});
test('seek aborts old fetch and ignores late responses, paused frame does not poll',async()=>{
  const calls=[];const c=new Controller('/api',()=>{},(url,opts)=>new Promise(resolve=>calls.push({url,opts,resolve})));
  const context={symbol:'SNDK',mode:'replay',identity:1,replay:true,enabled:true,at};
  c.sync(context);assert.equal(calls.length,1);
  c.sync({...context,at:at-60000});assert.equal(calls.length,2);assert(calls[0].opts.signal.aborted);
  calls[1].resolve({ok:true,json:async()=>({...fixture(),clockMS:at-60000})});await new Promise(setImmediate);
  calls[0].resolve({ok:true,json:async()=>fixture()});await new Promise(setImmediate);
  assert.equal(c.reply.clockMS,at-60000);c.next=0;c.sync({...context,at:at-60000});assert.equal(calls.length,2);
  c.sync({...context,enabled:false});assert.equal(c.reply,null);
});
test('provider history for Friday SNDK and QQQ, when validation output is available',t=>{
  const file=process.env.GEXBOT_VALIDATION_OUTPUT;if(!file)return t.skip('optional licensed fixture');
  const data=JSON.parse(require('node:fs').readFileSync(file));
  for(const [symbol,r] of Object.entries(data)){
    const v=model(r,at,r.profiles[0].spot);assert(v.usable,symbol);assert(v.levels.length>0,symbol);
    console.log(symbol,JSON.stringify({headline:v.headline,evidence:v.evidence,flow:v.windows,levels:v.levels.map(l=>l.text)}));
  }
});
