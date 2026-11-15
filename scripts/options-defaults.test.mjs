import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyOptionsDefaults} from '../internal/server/web/options-defaults.js';
const settings=id=>({showGEXOverlay:true,showGexbotContext:true,showAbsorption:true,panels:{slots:{primaryAnalytics:{activePanelId:'adr-rth-extension'},lowerAnalytics:{activePanelId:id}},settings:{'adr-rth-extension':{lookbackSessions:20,directionMode:'low',showOptionsContext:true}}}});
test('unsubscribed startup clears saved paid-options panels but preserves Gexbot and stock analytics',()=>{
  for(const id of ['options-flow','estimated-gex']){
    const s=applyOptionsDefaults(settings(id),false);
    assert.equal(s.showGEXOverlay,false);assert.equal(s.showGexbotContext,true);assert.equal(s.showAbsorption,true);
    assert.equal(s.panels.slots.lowerAnalytics.activePanelId,'tick-chart');
    assert.equal(s.panels.slots.primaryAnalytics.activePanelId,'adr-rth-extension');
    assert.deepEqual(s.panels.settings['adr-rth-extension'],{lookbackSessions:20,directionMode:'low',showOptionsContext:false});
  }
});
test('stock-only selections survive, subscribed preferences remain explicit opt-ins',()=>{
  for(const id of ['blank','tick-chart','kronos-forecast'])assert.equal(applyOptionsDefaults(settings(id),false).panels.slots.lowerAnalytics.activePanelId,id);
  const s=settings('options-flow'),before=structuredClone(s);applyOptionsDefaults(s,true);assert.deepEqual(s,before);
});
