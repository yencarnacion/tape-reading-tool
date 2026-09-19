// Background hydration is deliberately independent of first paint, RVOL,
// forecast requests, and WebSocket delivery. One delayed request per identity.
export class ChartHistoryLoader {
  constructor({ apply, fetcher = (...args) => fetch(...args),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
    Object.assign(this, { apply, fetcher, setTimer, clearTimer });
    this.key = ''; this.token = 0; this.timer = null; this.controller = null;
    this.done = false; this.attempts = 0;
  }
  reset() {
    this.token++;
    this.clearTimer(this.timer); this.timer = null;
    this.controller?.abort(); this.controller = null;
    this.key = ''; this.done = false; this.attempts = 0;
  }
  ensure(key, symbol) {
    if (this.key !== key) { this.reset(); this.key = key; }
    if (this.done || this.timer !== null || this.controller) return;
    const token = this.token;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.load(token, symbol);
    }, this.attempts ? 15000 : 2500);
  }
  async load(token, symbol) {
    if (token !== this.token) return;
    const controller = new AbortController();
    this.controller = controller;
    this.attempts++;
    try {
      const response = await this.fetcher(`/api/chart-history?symbol=${encodeURIComponent(symbol)}`, {
        method: 'POST', signal: controller.signal, priority: 'low'
      });
      if (token !== this.token) return;
      if (response.status === 422) { this.done = true; return; }
      if (!response.ok) throw new Error('Background history unavailable');
      const payload = await response.json();
      if (token !== this.token || payload.symbol !== symbol) return;
      this.apply(payload);
      this.done = true;
    } catch (error) {
      if (token !== this.token || error.name === 'AbortError') return;
      // Quiet bounded retries; failure never blocks the chart or tape.
      if (this.attempts >= 3) this.done = true;
    } finally {
      if (token === this.token) {
        this.controller = null;
        if (!this.done) this.ensure(this.key, symbol);
      }
    }
  }
}

export function mergeChartHistory(current, rawBars, throughUS) {
  const boundary = Number(throughUS);
  if (!(boundary > 0)) return current;
  const merged = new Map();
  for (const raw of Array.isArray(rawBars) ? rawBars : []) {
    const bar = { timeUS: Number(raw.time_us), open: Number(raw.open), high: Number(raw.high),
      low: Number(raw.low), close: Number(raw.close), volume: Number(raw.volume) || 0,
      dollarVolume: Number(raw.dollar_volume) || 0 };
    if (bar.timeUS > 0 && bar.timeUS < boundary && bar.close > 0 &&
        [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) merged.set(bar.timeUS, bar);
  }
  // The current chart wins overlaps, including prints that arrived in flight.
  for (const bar of current) merged.set(bar.timeUS, bar);
  return [...merged.values()].sort((a, b) => a.timeUS - b.timeUS).slice(-5001);
}
