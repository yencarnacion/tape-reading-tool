import { drawAutoTrendlines, packClosedBars } from './auto-trendlines.js';

export const TRENDLINE_STORAGE_KEY = 'tape-reading-tool.auto-trendlines.v1';
const INTERVAL_MS = 1000; // Only relevant to very fast replay or history corrections.

// One worker, one in-flight job, and one coalesced latest request. No candle
// copies are kept on the UI thread and no timers run while disabled/hidden.
export class AutoTrendlinesController {
  constructor(options = {}) {
    this.button = options.button;
    this.redraw = options.redraw || (() => {});
    this.workerFactory = options.workerFactory || (() => new Worker(
      new URL('./auto-trendlines-worker.js', import.meta.url), { type: 'module', name: 'auto-trendlines' }));
    this.now = options.now || (() => performance.now());
    this.setTimer = options.setTimer || ((fn, delay) => setTimeout(fn, delay));
    this.clearTimer = options.clearTimer || ((id) => clearTimeout(id));
    this.doc = options.document === undefined ? globalThis.document : options.document;
    this.host = options.host === undefined ? globalThis : options.host;
    this.storage = null;
    try { this.storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch (_) {}
    this.enabled = true;
    try { this.enabled = this.storage?.getItem(TRENDLINE_STORAGE_KEY) !== 'off'; } catch (_) {}
    this.active = true;
    this.disposed = false;
    this.suspended = false;
    this.lines = [];
    this.stats = null;
    this.worker = null;
    this.job = null;
    this.latest = null;
    this.identity = null;
    this.resultKey = '';
    this.timer = null;
    this.sequence = 0;
    this.revision = 0;
    this.lastDispatch = -Infinity;
    this.failed = false;
    this.status = 'Waiting for confirmed swings';
    this.onClick = () => this.setEnabled(!this.enabled);
    this.onVisibility = () => { if (this.doc?.hidden) this.stop(); else this.redraw(); };
    this.onPageHide = () => { this.suspended = true; this.stop(); };
    this.onPageShow = () => { this.suspended = false; this.redraw(); };
    this.button?.addEventListener('click', this.onClick);
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.host?.addEventListener?.('pagehide', this.onPageHide);
    this.host?.addEventListener?.('pageshow', this.onPageShow);
    this.updateButton();
  }

  runnable() { return this.enabled && this.active && !this.disposed && !this.suspended && !this.doc?.hidden; }

  updateButton() {
    if (!this.button) return;
    this.button.textContent = this.enabled ? 'TRENDLINES ON' : 'TRENDLINES OFF';
    this.button.classList.toggle('active', this.enabled);
    this.button.setAttribute('aria-pressed', String(this.enabled));
    this.button.title = this.enabled
      ? `Auto trendlines: support green, resistance orange; large solid, small dashed; broken faded. ${this.status}. Latest candle held out until the next minute arrives.`
      : 'Show automatic support/resistance trendlines on the 1-minute chart';
  }

  setEnabled(enabled) {
    enabled = Boolean(enabled);
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    try { this.storage?.setItem(TRENDLINE_STORAGE_KEY, enabled ? 'on' : 'off'); } catch (_) {}
    this.stop();
    this.status = 'Waiting for confirmed swings';
    this.updateButton();
    this.redraw();
  }

  setActive(active) {
    active = Boolean(active);
    if (active === this.active || this.disposed) return;
    this.active = active;
    if (!active) this.stop();
    else this.redraw();
  }

  key(bars, symbol, context) {
    const count = Math.max(0, bars.length - 1), last = bars[count - 1];
    return `${symbol}|${context}|${this.revision}|${bars[0]?.timeUS || 0}|${count}|${last?.timeUS || 0}|${last?.high}|${last?.low}|${last?.close}`;
  }

  update(bars, symbol, context = 'live') {
    if (!this.runnable() || !Array.isArray(bars)) return;
    const end = bars[bars.length - 2]?.timeUS || 0;
    const first = bars[0]?.timeUS || 0;
    const identity = this.identity;
    if (identity && (identity.bars !== bars || identity.symbol !== symbol || identity.context !== context ||
        identity.first !== first || end < identity.end)) this.stop();
    this.identity = { bars, symbol, context, first, end };
    const key = this.key(bars, symbol, context);
    if (this.latest?.key === key) return; // Forming-candle ticks take this path.
    this.latest = { bars, symbol, context, key };
    if (bars.length - 1 < 24) {
      this.lines = [];
      this.status = 'Waiting for confirmed swings';
      this.updateButton();
      return;
    }
    this.schedule();
  }

  // Called for late prints that actually revise a closed minute. A full history
  // replacement, ticker change, seek, or mode switch is detected by update().
  invalidate() {
    if (this.disposed) return;
    this.revision++;
    const lastDispatch = this.lastDispatch;
    this.stop();
    this.lastDispatch = lastDispatch;
    this.redraw();
  }

  schedule() {
    if (!this.runnable() || this.failed || this.job || this.timer !== null || !this.latest || this.latest.key === this.resultKey) return;
    const delay = Math.max(0, INTERVAL_MS - (this.now() - this.lastDispatch));
    if (delay === 0) this.dispatch();
    else this.timer = this.setTimer(() => { this.timer = null; this.dispatch(); }, delay);
  }

  dispatch() {
    if (!this.runnable() || this.failed || this.job || !this.latest) return;
    const latest = this.latest;
    latest.key = this.key(latest.bars, latest.symbol, latest.context);
    if (latest.key === this.resultKey) return;
    const packed = packClosedBars(latest.bars);
    if (packed.length < 24 * 4) return;
    try {
      if (!this.worker) {
        const worker = this.workerFactory();
        this.worker = worker;
        worker.onmessage = (event) => this.receive(worker, event.data);
        worker.onerror = () => { if (worker === this.worker) this.fail('Worker unavailable; toggle to retry'); };
        worker.onmessageerror = worker.onerror;
      }
      const id = ++this.sequence;
      this.job = { id, key: latest.key, bytes: packed.byteLength };
      this.lastDispatch = this.now();
      this.status = 'Analyzing closed candles';
      this.updateButton();
      this.worker.postMessage({ id, packed }, [packed.buffer]);
    } catch (_) { this.fail('Worker unavailable; toggle to retry'); }
  }

  receive(worker, message) {
    if (worker !== this.worker || !this.job || message?.id !== this.job.id || !this.runnable()) return;
    const job = this.job;
    this.job = null;
    if (message.error || !Array.isArray(message.result?.lines)) {
      this.fail(message.error || 'Invalid worker result');
      return;
    }
    if (this.latest) this.latest.key = this.key(this.latest.bars, this.latest.symbol, this.latest.context);
    if (job.key === this.latest?.key) {
      this.lines = message.result.lines;
      this.stats = { ...message.result.stats, elapsedMS: message.elapsedMS, inputBytes: job.bytes };
      this.resultKey = job.key;
      this.status = this.lines.length ? `${this.lines.length} lines` : 'No qualifying confirmed trendlines';
      this.updateButton();
      this.redraw();
    }
    this.schedule();
  }

  fail(message) {
    this.stop();
    this.failed = true; // No retry loop; an explicit toggle/context change retries.
    this.status = String(message);
    this.updateButton();
    this.redraw();
  }

  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    this.job = null;
    this.latest = null;
    this.identity = null;
    this.resultKey = '';
    this.lines = [];
    this.stats = null;
    this.sequence++;
    this.failed = false;
    this.lastDispatch = -Infinity;
  }

  draw(ctx, geometry) { if (this.runnable()) drawAutoTrendlines(ctx, this.lines, geometry); }

  debug() {
    return { enabled: this.enabled, active: this.active, busy: Boolean(this.job),
      queued: this.timer !== null, status: this.status, lines: this.lines.length, stats: this.stats };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.button?.removeEventListener('click', this.onClick);
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.host?.removeEventListener?.('pagehide', this.onPageHide);
    this.host?.removeEventListener?.('pageshow', this.onPageShow);
  }
}
