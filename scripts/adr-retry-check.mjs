import assert from 'node:assert/strict';
import {adrRTHManifest} from '../internal/server/web/adr-rth-extension-panel.js';
const settle=()=>new Promise(r=>setImmediate(r));
function node(){const children=new Map();return{textContent:'',hidden:false,value:'',className:'',dataset:{},style:{setProperty(){}},classList:{toggle(){},remove(){}},addEventListener(){},replaceChildren(){},querySelector(k){if(!children.has(k))children.set(k,node());return children.get(k)}};}
const bars=Array.from({length:20},(_,i)=>({sessionDateET:`2026-09-${String(i+1).padStart(2,'0')}`,open:40,high:42,low:39,close:41,complete:true}));
for(const firstStatus of ['insufficient','unavailable']){
 const root=node();let historyCalls=0,seedCalls=0;
 let snapshot={symbol:'U',mode:'live',generation:1,status:{connected:true,epoch:1},clockUS:Date.parse('2026-10-05T14:00:00Z')*1000};
 const seed=()=>({schemaVersion:1,symbol:snapshot.symbol,sessionDateET:'2026-10-05',completeFromRTHOpen:true,status:'ready',open:44,high:46,low:43,last:45});
 const host={signal:new AbortController().signal,isCurrent:()=>true,currentSnapshot:()=>snapshot,savePanelSettings(){},getCompletedDailyBars:async()=>{historyCalls++;return{status:historyCalls===1?firstStatus:'ready',bars:historyCalls===1?bars.slice(0,2):bars}},getRTHSessionContext:async()=>{seedCalls++;if(seedCalls===2)throw Error('temporary seed failure');return seed()}};
 const panel=adrRTHManifest.factory({root,host,settings:{}});panel.onEvent({type:'snapshot',snapshot});await settle();
 snapshot.clockUS+=6e6;panel.render(snapshot.clockUS);await settle();
 assert.equal(historyCalls,2,'failed/short baseline automatically retries');
 assert.notEqual(root.querySelector('.adr-state-baseline output').textContent,'--','valid ADR must remain visible while session context fails');
 snapshot.clockUS+=6e6;panel.render(snapshot.clockUS);await settle();
 assert.equal(historyCalls,2,'good baseline is reused when retrying only RTH context');assert.equal(root.querySelector('.adr-ready').hidden,false,'panel recovers without ticker change');
 snapshot={...snapshot,status:{connected:true,epoch:2}};panel.onEvent({type:'modeChanged',mode:'live',status:snapshot.status,clockUS:snapshot.clockUS});await settle();
 assert.equal(seedCalls,4,'brief reconnect must reseed missed RTH extremes');
 panel.unmount();
}
console.log('ADR recovery passed: U short/unavailable history, independent baseline, seed retry, and brief reconnect');
