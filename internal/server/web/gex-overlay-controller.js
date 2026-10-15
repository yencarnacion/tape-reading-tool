import { gexView } from './gex-model.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const replayMode = mode => mode === 'replay' || mode === 'render';
const viewFields = ['status', 'usable', 'tone', 'label', 'reason', 'age', 'spot', 'nearTermGrossFraction'];
const sameView = (a, b) => a === b || (!!a && !!b && viewFields.every(key => a[key] === b[key]));

// Owns only the optional chart study. It does not depend on the lower GEX panel
// being mounted, and the server coalesces equal chain requests from both views.
export class GEXOverlayController {
  constructor({ changed = () => {}, fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
    Object.assign(this, { changed, fetcher, now });
    this.active = false; this.result = null; this.view = null;
    this.epoch = 0; this.key = ''; this.controller = null; this.context = null;
    this.reply = null; this.lastClock = null; this.lastRequestClock = null;
    this.nextPoll = 0; this.evaluatedAt = ''; this.requests = 0;
  }

  reset() {
    const visible = this.active || this.view !== null || this.result !== null;
    this.epoch++; this.controller?.abort(); this.controller = null;
    this.active = false; this.key = ''; this.context = null; this.reply = null;
    this.result = null; this.view = null; this.lastClock = null;
    this.lastRequestClock = null; this.nextPoll = 0; this.evaluatedAt = '';
    if (visible) this.changed();
  }

  sync({ enabled, symbol, generation, mode, status, clockUS, spot, maxDTE = 120, identity = '' }) {
    if (!enabled || !symbol || !finite(clockUS) || clockUS <= 0 || clockUS / 1000 > 8.64e15) {
      if (this.active || this.controller) this.reset();
      return;
    }
    const nowMS = clockUS / 1000;
    maxDTE = [30, 60, 120].includes(maxDTE) ? maxDTE : 120;
    const key = JSON.stringify([symbol, generation, mode, !!status?.connected, maxDTE, identity]);
    // Live message timestamps re-anchor a locally extrapolated clock, so small
    // latency corrections are not timeline changes. Replay must still discard
    // an earlier lookup on any backwards movement, independently of its epoch.
    const rollbackTolerance = replayMode(mode) ? 0 : 50;
    if (key !== this.key || (this.lastClock !== null && nowMS < this.lastClock - rollbackTolerance)) {
      this.reset(); this.key = key;
    }
    this.active = true; this.lastClock = nowMS;
    this.context = { symbol, generation, mode, status, clockUS, spot, maxDTE };
    this.evaluate();

    const replay = replayMode(mode);
    const allowed = replay || (['live', 'massive'].includes(mode) && status?.connected && this.view?.status !== 'market-closed');
    const paused = replay && status?.state === 'paused';
    if (!allowed || this.controller || this.now() < this.nextPoll || (paused && this.lastRequestClock === nowMS)) return;
    this.lastRequestClock = nowMS;
    this.nextPoll = this.now() + (replay ? 500 : 15000);
    void this.load();
  }

  evaluate(force = false) {
    if (!this.active || !this.context) return;
    const context = this.context, nowMS = context.clockUS / 1000, reply = this.reply;
    const replay = replayMode(context.mode), tolerance = replay ? 0 : 2000;
    const moved = finite(context.spot) && context.spot > 0 && reply?.spot > 0 && Math.abs(context.spot / reply.spot - 1) >= .01;
    // The expensive payload reconciliation and strike sorting run at most once
    // per second while unchanged. Exact safety-boundary crossings still clear
    // immediately, including a 90,001ms age during an otherwise idle frame.
    const stamp = [Math.floor(nowMS / 1000), moved,
      nowMS - reply?.asOfMS > 90000, reply?.asOfMS > nowMS + tolerance,
      nowMS - reply?.underlyingMS > 90000, reply?.underlyingMS > nowMS + tolerance].join('/');
    let view = this.view;
    if (force || stamp !== this.evaluatedAt || !view) {
      this.evaluatedAt = stamp;
      try { view = gexView(reply, nowMS, context); }
      catch (_) { view = gexView(this.failure('invalid-data'), nowMS, context); }
    } else if (view.usable) {
      const latest = finite(context.spot) && context.spot > 0 ? context.spot : reply.spot;
      if (latest !== view.spot) view = { ...view, spot: latest };
    }
    // Consumers can never accidentally draw a stale/partial/future raw chain.
    // Keep the original internally so changing price/clock can re-evaluate it.
    const result = view.usable ? reply : null;
    if (result !== this.result || !sameView(view, this.view)) {
      this.result = result; this.view = view; this.changed();
    }
  }

  failure(status) {
    const { symbol, generation, maxDTE, mode } = this.context;
    return { symbol, generation, maxDTE, replay: replayMode(mode), status };
  }

  async load() {
    const token = this.epoch, controller = new AbortController(), requested = { ...this.context };
    this.controller = controller; this.requests++;
    let timeout;
    try {
      const query = new URLSearchParams({ symbol: requested.symbol, dte: String(requested.maxDTE) });
      const request = (async () => {
        const response = await this.fetcher(`/api/panel-data/gex?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error('GEX snapshot unavailable');
        return response.json();
      })();
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('GEX snapshot timed out')); }, 25000);
        timeout?.unref?.();
      });
      const reply = await Promise.race([request, deadline]);
      if (!this.active || token !== this.epoch || controller.signal.aborted) return;
      this.reply = reply?.symbol === requested.symbol && reply?.generation === requested.generation && reply?.maxDTE === requested.maxDTE
        ? reply : this.failure('context-changed');
      this.evaluate(true);
    } catch (_) {
      if (this.active && token === this.epoch) {
        // A failed transport did not answer the paused-clock lookup. Permit a
        // bounded retry while successful or authoritative replies remain once
        // per clock, even when playback stays paused indefinitely.
        this.lastRequestClock = null; this.nextPoll = this.now() + 15000;
        this.reply = this.failure('gateway-offline'); this.evaluate(true);
      }
    } finally {
      clearTimeout(timeout);
      if (token === this.epoch) this.controller = null;
    }
  }

  debug() {
    return { active: this.active, pending: !!this.controller, key: this.key,
      status: this.view?.status || 'off', usable: !!this.view?.usable,
      asOfMS: this.result?.asOfMS ?? null, maxDTE: this.context?.maxDTE ?? null, requests: this.requests };
  }
}
