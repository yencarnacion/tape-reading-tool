import assert from 'node:assert/strict';
import { createOptionsView } from '../internal/server/web/options-volatility-panel.js';
function node() {
 const children=new Map();return {textContent:'',title:'',dataset:{},hidden:false,children:[],
 querySelector(key){if(!children.has(key))children.set(key,node());return children.get(key);},
 replaceChildren(){this.children=[];},append(...nodes){this.children.push(...nodes);}};
}
globalThis.document={createElement:()=>node()};
let mono=1000;Object.defineProperty(performance,'now',{value:()=>mono});
const clock=Date.parse('2026-07-24T14:00:00Z')*1000;
let snapshot={symbol:'AAPL',generation:1,mode:'demo',clockUS:clock,status:{connected:true},trades:[]};
const pending=[],controller=new AbortController(),root=node();let current=true;
const host={signal:controller.signal,isCurrent:()=>current,getOptionsSnapshot:({symbol,signal})=>new Promise(resolve=>pending.push({symbol,signal,resolve}))};
const view=createOptionsView({root,host,getSnapshot:()=>snapshot,getADRExtension:()=>1.1});
const render=()=>{mono+=1000;view.render(snapshot.clockUS);};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
view.event({type:'snapshot'});render();
assert.equal(pending.length,0,'demo must never query live options');
assert.equal(root.querySelector('.vol-state').textContent,'OPTIONS LIVE ONLY');
snapshot={...snapshot,mode:'live'};view.event({type:'snapshot'});render();
assert.equal(pending.length,1);
snapshot={...snapshot,symbol:'NVDA',generation:2};view.event({type:'snapshot'});render();
assert.equal(pending[0].signal.aborted,true,'symbol change cancels the old request');
assert.equal(pending.length,2);assert.equal(pending[1].symbol,'NVDA');
pending[0].resolve({schemaVersion:1,symbol:'AAPL',generation:1,status:'gateway-offline'});await settle();render();
assert.notEqual(root.querySelector('.vol-state').textContent,'OPTIONS OFFLINE','old response cannot overwrite the new ticker');
pending[1].resolve({schemaVersion:1,symbol:'NVDA',generation:2,status:'no-options'});await settle();render();
assert.equal(root.querySelector('.vol-state').textContent,'NO USABLE OPTIONS');
assert.equal(root.querySelector('.vol-iv').textContent,'--');
snapshot={...snapshot,status:{connected:false}};view.event({type:'modeChanged'});render();
assert.equal(root.querySelector('.vol-state').textContent,'WAITING FOR TAPE');assert.equal(pending.length,2);
snapshot={...snapshot,status:{connected:true}};view.event({type:'modeChanged'});render();assert.equal(pending.length,3);
view.unmount();assert.equal(pending[2].signal.aborted,true,'unmount cancels the current request');
const before=root.querySelector('.vol-state').textContent;
pending[2].resolve({schemaVersion:1,symbol:'NVDA',generation:2,status:'no-options'});await settle();render();
assert.equal(root.querySelector('.vol-state').textContent,before,'unmounted responses cannot repaint');
current=false;

// Exercise side and pace independently using real classified prints. Options
// may be unavailable while valid stock flow remains useful.
const flowRoot=node(),flowStart=clock/1000;
const flowView=createOptionsView({root:flowRoot,host:{signal:new AbortController().signal,isCurrent:()=>true,
 getOptionsSnapshot:async()=>({schemaVersion:1,symbol:'TEST',generation:1,status:'no-options'})},
 getSnapshot:()=>snapshot,getADRExtension:()=>null});
function flowScenario(side,pace) {
 snapshot={symbol:'TEST',generation:1,mode:'live',status:{connected:true},clockUS:(flowStart+90000)*1000,
  trades:Array.from({length:91},(_,i)=>({s:i+1,t:flowStart+i*1000,p:100,z:i<60?100:pace,d:side}))};
 flowView.event({type:'snapshot'});mono+=1000;flowView.render(snapshot.clockUS);
}
for(const [side,label] of [[1,'BUY'],[-1,'SELL']]) for(const [size,pace] of [[200,'FASTER'],[30,'SLOWER'],[100,'STEADY']]) {
 flowScenario(side,size);
 assert.equal(flowRoot.querySelector('.vol-flow-row').dataset.side,side===1?'buy':'sell');
 assert.equal(flowRoot.querySelector('.vol-flow-side').textContent,label+' FLOW');
 assert.equal(flowRoot.querySelector('.vol-flow').textContent,pace);
 assert.match(flowRoot.querySelector('.vol-flow-change').textContent,/^[+−-].*% · 30s$/);
}
snapshot={...snapshot,clockUS:snapshot.clockUS+21000000};mono+=1000;flowView.render(snapshot.clockUS);
assert.equal(flowRoot.querySelector('.vol-flow').textContent,'STALE');
assert.equal(flowRoot.querySelector('.vol-flow-row').dataset.side,'neutral','stale prints clear the directional color');
flowScenario(-1,30);
snapshot={...snapshot,trades:snapshot.trades.map((t,i)=>({...t,d:i%2?1:-1}))};
flowView.event({type:'snapshot'});mono+=1000;flowView.render(snapshot.clockUS);
assert.equal(flowRoot.querySelector('.vol-flow').textContent,'MIXED');
assert.equal(flowRoot.querySelector('.vol-flow-row').dataset.side,'neutral');
flowScenario(1,200);
snapshot={...snapshot,status:{connected:false}};flowView.event({type:'modeChanged'});mono+=1000;flowView.render(snapshot.clockUS);
assert.equal(flowRoot.querySelector('.vol-flow-row').dataset.side,'neutral','disconnect clears buy/sell cues');
flowScenario(-1,30);
snapshot={...snapshot,symbol:'NEXT',generation:2,trades:[]};flowView.event({type:'snapshot'});mono+=1000;flowView.render(snapshot.clockUS);
assert.equal(flowRoot.querySelector('.vol-flow-row').dataset.side,'neutral','new ticker cannot inherit the old side');
assert.equal(flowRoot.querySelector('.vol-flow-side').textContent,'TAPE FLOW');
flowView.unmount();
console.log('Options lifecycle: symbol races, reconnect, placeholder clearing, unmount, buy/sell pace, and neutral quality gates passed');
