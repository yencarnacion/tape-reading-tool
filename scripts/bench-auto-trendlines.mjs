import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { computeAutoTrendlines, packClosedBars } from '../internal/server/web/auto-trendlines.js';

function fixture(count) {
  return Array.from({ length: count + 1 }, (_, i) => {
    const p = 100 + i * 0.003 + 2 * Math.sin(i * Math.PI / 10) + 5 * Math.sin(i * Math.PI / 150);
    return { timeUS: 1_700_000_000_000_000 + i * 60e6, high: p + 0.2, low: p - 0.2, close: p };
  });
}
const results = [];
for (const count of [500, 2000, 5000]) {
  const data = packClosedBars(fixture(count));
  for (let i = 0; i < 20; i++) computeAutoTrendlines(data);
  global.gc?.();
  const before = process.memoryUsage();
  const samples = [];
  let result;
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    result = computeAutoTrendlines(data);
    samples.push(performance.now() - start);
  }
  global.gc?.();
  const after = process.memoryUsage();
  samples.sort((a, b) => a - b);
  results.push({ bars: count, runs: samples.length,
    medianMS: +samples[100].toFixed(3), p95MS: +samples[190].toFixed(3), maxMS: +samples.at(-1).toFixed(3),
    payloadBytes: data.byteLength, candidateCount: result.stats.candidates, displayedLines: result.lines.length,
    retainedHeapDeltaBytes: after.heapUsed - before.heapUsed,
    retainedArrayBufferDeltaBytes: after.arrayBuffers - before.arrayBuffers });
}
console.log(JSON.stringify({ node: process.version, cpu: os.cpus()[0]?.model,
  note: 'Synthetic Node benchmark, not a MacBook/browser timing or total worker-memory measurement. Heap deltas are post-GC retained changes, not peak allocation.', results }, null, 2));
