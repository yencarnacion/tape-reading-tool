// The experiment owns its requests and result. It never hydrates/replaces the
// price chart or reuses the unrelated recent-candle RVOL PACE calculation.
export class CumulativeRVOL {
  constructor({ changed, fetcher = (...args) => fetch(...args), now = () => Date.now() }) {
    Object.assign(this, { changed, fetcher, now });
    this.token = 0; this.key = ''; this.controller = null;
    this.minute = -1; this.retryAt = 0; this.result = null;
    this.points = new Map();
  }
  reset() {
    this.token++; this.controller?.abort(); this.controller = null;
    this.key = ''; this.minute = -1; this.retryAt = 0;
    this.setResult(null);
  }
  setResult(result) {
    this.result = result;
    this.points = new Map((result?.points || []).map(point => [point.time_us, point]));
    this.changed();
  }
  sync({ enabled, symbol, identity, clockUS }) {
    if (!enabled || !(clockUS > 0)) {
      if (this.key) this.reset();
      return;
    }
    const key = `${symbol}|${identity}|${dateFormat.format(new Date(clockUS / 1000))}`;
    if (key !== this.key) {
      this.reset(); this.key = key;
      this.setResult({ status: 'loading', message: 'Loading 5 prior sessions…', points: [] });
    }
    // Give providers five seconds to finalize the last one-minute aggregate.
    const minute = Math.floor(clockUS / 60e6);
    if (this.minute >= 0 && minute > this.minute && clockUS % 60e6 < 5e6) return;
    if (this.controller || minute === this.minute || this.now() < this.retryAt) return;
    void this.load(symbol, minute);
  }
  async load(symbol, minute) {
    const token = this.token, controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 95000);
    try {
      const response = await this.fetcher(`/api/cumulative-rvol?symbol=${encodeURIComponent(symbol)}`, {
        method: 'POST', signal: controller.signal, priority: 'low'
      });
      if (!response.ok) throw new Error('History unavailable');
      const result = await response.json();
      if (token !== this.token) return;
      if (result.symbol !== symbol || !Array.isArray(result.points) || !result.status) throw new Error('Invalid history');
      this.minute = minute;
      this.retryAt = this.now() + (['ready', 'before-open', 'waiting'].includes(result.status) ? 0 : 30000);
      this.setResult(result);
    } catch (_) {
      if (token !== this.token) return;
      this.retryAt = this.now() + 15000;
      this.setResult({ status: 'unavailable', message: 'History unavailable · retrying', points: [] });
    } finally {
      clearTimeout(timeout);
      if (token === this.token) this.controller = null;
    }
  }
}

export function minutePaneLayout(height, showVolume, showRVOL) {
  const top = 25, axisBottom = 20, gap = 8;
  // Compact independent panes. Default-off geometry is identical to the
  // original chart, including its volume height.
  const volumeHeight = showVolume ? Math.max(45, Math.min(92, (height - top - axisBottom) * .22)) : 0;
  const rvolHeight = showRVOL ? Math.max(48, Math.min(88, (height - top - axisBottom) * .18)) : 0;
  const rvolBottom = height - axisBottom;
  const rvolTop = rvolBottom - rvolHeight;
  const volumeBottom = showRVOL ? rvolTop - gap : rvolBottom;
  const volumeTop = volumeBottom - volumeHeight;
  const priceBottom = (showVolume ? volumeTop - gap : showRVOL ? rvolTop - gap : rvolBottom);
  return { top, volumeHeight, volumeBottom, volumeTop, priceBottom, rvolTop, rvolBottom };
}

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function drawCumulativeRVOL(ctx, study, { visible, xAt, bodyWidth, left, right, width, top, bottom }) {
  const result = study.result;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, top, width, bottom - top); ctx.clip();
  ctx.fillStyle = '#0c0f13'; ctx.fillRect(0, top, width, bottom - top);
  ctx.strokeStyle = '#3a424c'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, top); ctx.lineTo(width, top); ctx.stroke();
  ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#b98be6'; ctx.fillText('5D CUM RVOL', left + 2, top + 10);
  const points = visible.map(bar => study.points.get(bar.timeUS));
  const ratios = points.map(point => point?.ratio).filter(Number.isFinite);
  const maximum = Math.max(1.25, ...ratios) * 1.08;
  const plotTop = top + 24, plotBottom = bottom - 2;
  const yAt = value => plotBottom - value / maximum * (plotBottom - plotTop);
  if (result?.status === 'ready') {
    points.forEach((point, index) => {
      if (!Number.isFinite(point?.ratio)) return;
      ctx.fillStyle = point.up ? 'rgba(52,199,217,.65)' : 'rgba(255,77,94,.65)';
      const y = yAt(point.ratio);
      ctx.fillRect(xAt(index) - bodyWidth / 2, y, bodyWidth, Math.max(0, plotBottom - y));
    });
    const latest = result.points.at(-1)?.ratio;
    const label = Number.isFinite(latest) ? `${latest >= 1 ? '↑' : '↓'}${latest.toFixed(2)}×` : '--';
    ctx.fillStyle = '#272033'; ctx.fillRect(right + 1, top + 1, width - right - 2, 22);
    ctx.fillStyle = latest >= 2 ? '#df9cff' : latest < .75 ? '#74717f' : '#b98be6';
    ctx.font = '800 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(label, right + 4, top + 12, width - right - 8);
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = '#8d96a2';
    const asOf = `RTH · AS OF ${clockFormat.format(new Date(result.through_us / 1000))} ET`;
    if (right - left > 300) ctx.fillText(asOf, left + 108, top + 10);
  } else {
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = '#8d96a2';
    ctx.fillText('--', right + 5, top + 10);
  }
  // Always include the normal-volume reference, even below 1x or while loading.
  const normalY = yAt(1);
  ctx.strokeStyle = '#ffd447'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(left, normalY); ctx.lineTo(right, normalY); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle = '#ffd447';
  ctx.font = '700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.fillText('1×', right + 5, Math.max(plotTop + 6, Math.min(bottom - 7, normalY)));
  if (result?.status !== 'ready') {
    ctx.fillStyle = '#0c0f13'; ctx.fillRect(left, plotTop, right - left, 15);
    ctx.fillStyle = '#8d96a2'; ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(result?.message || 'Loading history…', left + 2, plotTop + 7, Math.max(40, right - left - 8));
  }
  ctx.restore();
}
