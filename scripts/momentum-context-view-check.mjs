import assert from 'node:assert/strict';
import { momentumCues } from '../internal/server/web/momentum-context-view.js';

const reading = (side, state, flowSide = side, extra = {}) => ({
  momentum: { ready: true, side, ratio: side > 0 ? 1.04 : side < 0 ? .96 : 1 },
  flow: { state, direction: flowSide },
  tape: { ready: true, direction: side, exhaustion: 0, relativeVolumeReady: true, relativeVolume: 3, ...extra },
});
let cues = momentumCues(reading(1, 'PUSH'));
assert.match(cues.momentum.text, /↑ UP/);
assert.equal(cues.momentum.tone, 'up');
assert.equal(cues.flow.text, '↑ BUY PUSH');
assert.equal(cues.flow.tone, 'up');
assert.equal(cues.volume.tone, 'volume-high', 'high volume uses violet, never buying/selling color');
cues = momentumCues(reading(-1, 'PUSH'));
assert.match(cues.momentum.text, /↓ DN/);
assert.equal(cues.flow.text, '↓ SELL PUSH');
assert.equal(cues.flow.tone, 'down');
for (const side of [1, -1]) {
  cues = momentumCues(reading(side, 'EASE'));
  assert.equal(cues.flow.tone, 'caution', 'slower buys/sells are caution, not opposite flow');
  cues = momentumCues(reading(side, 'FLIP', -side));
  assert.equal(cues.flow.tone, side > 0 ? 'down' : 'up');
  assert.equal(cues.flow.caution, true);
  assert.equal(cues.setup.text, '○ NO CLIMAX', 'a flow flip must not fabricate a completed turn');
  cues = momentumCues(reading(side, 'PUSH', side, { exhaustion: 70 }));
  assert.equal(cues.setup.tone, 'caution');
  assert.match(cues.setup.text, /⚠ CLIMAX/);
  cues = momentumCues(reading(side, 'PUSH', side, { exhaustion: 70, turnDirection: -side }));
  assert.equal(cues.setup.text, side > 0 ? '↓ TURN' : '↑ TURN');
  assert.equal(cues.setup.tone, side > 0 ? 'down' : 'up');
}
cues = momentumCues(reading(0, 'MIXED', 0, { relativeVolume: .5 }));
assert.equal(cues.momentum.tone, 'neutral');
assert.equal(cues.flow.tone, 'neutral');
assert.equal(cues.volume.text, '3m VOL ↓0.5×');
cues = momentumCues({ momentum: { ready: false }, flow: { state: 'BUILD' }, tape: { ready: false } });
assert.deepEqual([cues.momentum.tone, cues.flow.tone, cues.setup.tone, cues.volume.tone], Array(4).fill('neutral'));
assert.equal(cues.setup.text, 'SETUP WAIT');
console.log('Momentum cues passed: directions, slowdown caution, volume magnitude, completed turns, and missing data.');
