import assert from 'node:assert/strict';
import { adrRTHManifest } from '../internal/server/web/adr-rth-extension-panel.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function node() {
 const children = new Map();
 return { textContent:'', hidden:false, value:'', className:'', dataset:{}, style:{setProperty(){}}, classList:{toggle(){},remove(){}}, addEventListener(){}, replaceChildren(){}, querySelector(key){if(!children.has(key))children.set(key,node());return children.get(key);} };
}
for (const [symbol, sessionDateET] of [['LQDA','2026-10-01'],['STX','2026-10-02']]) {
 const root=node(); let calls=0;
 let snapshot={symbol,mode:'live',clockUS:Date.parse(`${sessionDateET}T13:29:59Z`)*1000};
 const host={signal:new AbortController().signal,isCurrent:()=>true,currentSnapshot:()=>snapshot,savePanelSettings(){},
  getCompletedDailyBars:async()=>({bars:Array.from({length:20},(_,i)=>({sessionDateET:`2026-09-${String(i+1).padStart(2,'0')}`,open:100,high:105,low:100,close:101,complete:true}))}),
  getRTHSessionContext:async()=>{calls++;return {schemaVersion:1,symbol,sessionDateET,status:calls===1?'before-open':'building',completeFromRTHOpen:calls!==1};}
 };
 const panel=adrRTHManifest.factory({root,host,settings:{}});
 panel.onEvent({type:'snapshot',snapshot}); await settle();
 assert.equal(root.querySelector('.adr-state').querySelector('strong').textContent,'WAITING FOR RTH OPEN');
 snapshot={...snapshot,clockUS:Date.parse(`${sessionDateET}T13:30:01Z`)*1000};
 panel.render(snapshot.clockUS);await settle();
 assert.equal(calls,2,'crossing the open must reload the premarket seed');
 panel.onEvent({type:'tradeBatch',symbol,clockUS:snapshot.clockUS,trades:[{p:840,t:snapshot.clockUS/1000}]});
 assert.equal(root.querySelector('.adr-ready').hidden,false,'first RTH trade must recover the panel');
 assert.equal(root.querySelector('.adr-value').textContent,'0.00 ADR');
 panel.unmount();
}
console.log('ADR panel lifecycle: LQDA/STX premarket → RTH reload → first-trade ready passed');
