// Keep three months legible in the small preview. Extra completed sessions
// warm the moving average before the first visible candle.
export const DAILY_MAP_SESSIONS = 60;
const HISTORY_SESSIONS = 90;

export class DailyMapHistory {
  constructor({ apply, fetcher = (...args) => fetch(...args), now = () => performance.now() }) {
    Object.assign(this, { apply, fetcher, now });
    this.key = ''; this.token = 0; this.controller = null; this.retryAt = 0; this.done = false;
  }

  reset() {
    this.token++;
    this.controller?.abort(); this.controller = null;
    this.key = ''; this.retryAt = 0; this.done = false;
  }

  ensure(key, symbol, sessionDateET) {
    if (key !== this.key) {
      this.reset(); this.key = key;
      this.apply({ status: 'loading', bars: [], message: '' });
    }
    if (this.done || this.controller || this.now() < this.retryAt) return;
    void this.load(this.token, symbol, sessionDateET);
  }

  async load(token, symbol, sessionDateET) {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const query = new URLSearchParams({ symbol, before: sessionDateET, limit: String(HISTORY_SESSIONS) });
      const response = await this.fetcher(`/api/panel-data/daily-bars?${query}`, { signal: controller.signal });
      if (!response.ok) throw new Error((await response.text()).trim() || 'Daily history unavailable');
      const payload = await response.json();
      if (token !== this.token) return;
      if (payload.symbol !== symbol) throw new Error('Daily history symbol mismatch');
      const before = String(payload.beforeSessionDateET || sessionDateET);
      const bars = (Array.isArray(payload.bars) ? payload.bars : []).filter((bar) =>
        bar.complete && bar.sessionDateET < before && bar.sessionDateET < sessionDateET
      ).map((bar) => ({
        sessionDateET: bar.sessionDateET, timeUS: Number(bar.startUS),
        open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close)
      })).filter((bar) => bar.timeUS > 0 &&
        [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0) &&
        bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close)
      ).sort((a, b) => a.timeUS - b.timeUS).slice(-HISTORY_SESSIONS);
      this.done = payload.status === 'ready';
      this.retryAt = this.now() + 30000;
      this.apply({ status: bars.length ? 'ready' : payload.status === 'unavailable' ? 'unavailable' : 'empty',
        bars, message: payload.message || '' });
    } catch (error) {
      if (token !== this.token || error.name === 'AbortError') return;
      this.retryAt = this.now() + 30000;
      this.apply({ status: 'unavailable', bars: [], message: String(error.message || error) });
    } finally {
      // An old request must never release the new ticker's request slot.
      if (token === this.token) this.controller = null;
    }
  }
}

export function dailyMapModel(history, currentPrice) {
  let sum = 0;
  const enriched = history.map((bar, index) => {
    sum += bar.close;
    if (index >= 20) sum -= history[index - 20].close;
    return { ...bar, sma20: index >= 19 ? sum / 20 : null };
  });
  const bars = enriched.slice(-DAILY_MAP_SESSIONS);
  if (!bars.length) return null;
  const last = bars.at(-1);
  const live = Number.isFinite(currentPrice) && currentPrice > 0;
  const price = live ? currentPrice : last.close;
  const high = Math.max(price, ...bars.map((bar) => bar.high));
  const low = Math.min(price, ...bars.map((bar) => bar.low));
  const change = (price / bars[0].close - 1) * 100;
  return { bars, price, live, high, low, change, sma20: last.sma20,
    direction: Number.isFinite(last.sma20) ? (price > last.sma20 ? 'above' : price < last.sma20 ? 'below' : 'neutral') : 'neutral' };
}
