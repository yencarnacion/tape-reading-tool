import assert from 'node:assert/strict';

globalThis.sampleRate = 48000;
globalThis.currentFrame = 0;

let TapeMixerProcessor;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null };
  }
};
globalThis.registerProcessor = (name, processor) => {
  if (name === 'tape-mixer') TapeMixerProcessor = processor;
};

await import('../internal/server/web/audio-worklet.js');
assert.ok(TapeMixerProcessor, 'tape-mixer processor should register');

const mapping = new TapeMixerProcessor();
const expected = [
  [30, 126, 3.8],
  [123, 179, 6.6],
  [300, 263, 9.6],
  [500, 360, 12]
];
for (const [rate, pitch, pulse] of expected) {
  mapping.tapeRateTarget = rate;
  mapping.tapeRateSmoothed = rate;
  mapping.tapeParameterCountdown = 0;
  mapping.renderTapeRateSample(0);
  assert.ok(Math.abs(mapping.tapePitch - pitch) < 1, `${rate}/s pitch = ${mapping.tapePitch}`);
  assert.ok(Math.abs(mapping.tapePulseRate - pulse) < 0.1, `${rate}/s pulse = ${mapping.tapePulseRate}`);
}

const cuesOnly = new TapeMixerProcessor();
cuesOnly.onMessage({ type: 'ticks', events: [{ side: 1, size: 100, delayMS: 0 }] });
const cueOutputs = outputBuffers();
cuesOnly.process([], cueOutputs);
assert.ok(energy(cueOutputs[0][0]) > 0, 'existing print cue should remain on output 0');
assert.equal(energy(cueOutputs[1][0]), 0, 'inactive tape-rate bed should be silent');

const bedOnly = new TapeMixerProcessor();
bedOnly.onMessage({ type: 'tape-rate', rate: 300 });
let bedEnergy = 0;
let printEnergy = 0;
for (let block = 0; block < 300; block++) {
  const outputs = outputBuffers();
  bedOnly.process([], outputs);
  bedEnergy += energy(outputs[1][0]);
  printEnergy += energy(outputs[0][0]);
  globalThis.currentFrame += 128;
}
assert.ok(bedEnergy > 0, 'active tape-rate bed should play on output 1');
assert.equal(printEnergy, 0, 'tape-rate bed should not leak into the print-cue output');

console.log('audio worklet check: representative rates and independent outputs passed');

function outputBuffers() {
  return [
    [new Float32Array(128), new Float32Array(128)],
    [new Float32Array(128), new Float32Array(128)]
  ];
}

function energy(samples) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return sum;
}
