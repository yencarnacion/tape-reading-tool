import { computeAutoTrendlines } from './auto-trendlines.js';

self.onmessage = ({ data }) => {
  const started = performance.now();
  try {
    const result = computeAutoTrendlines(data.packed);
    self.postMessage({ id: data.id, result, elapsedMS: performance.now() - started });
  } catch (error) {
    self.postMessage({ id: data?.id, error: String(error?.message || error) });
  }
};
