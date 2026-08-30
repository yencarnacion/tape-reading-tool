import {
  calculateDailyPivots, dailyPivotLevels, drawDailyPivotLabels, drawDailyPivotLines
} from './daily-pivots.js';

(() => {
  'use strict';

  // The chart renderer is intentionally left untouched. This module listens at
  // the Canvas 2D boundary, where the renderer has already established the exact
  // visible price scale. Pivot lines therefore cannot change chart scaling or
  // consume horizontal bar space, and the same overlay works for live, replay,
  // deterministic render, and Live Rewind canvases.
  const TARGETS = new Map([
    ['chartCanvas', { left: 6, priceElement: 'lastPrice', background: '#0c0f13' }],
    ['replayChartCanvas', { left: 7, priceElement: 'lastPrice', background: '#0c0f13' }],
    ['rewindCanvas', { left: 6, priceElement: 'rewindLast', background: '#080a0d' }]
  ]);
  const ET_DATE = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const RETRY_MS = 30000;
  const originalFetch = window.fetch.bind(window);
  const originalFillText = CanvasRenderingContext2D.prototype.fillText;
  const captures = new WeakMap();
  const mappings = new Map();
  let observedSessionDateET = '';
  let pollTimer = 0;

  const pivotState = {
    symbol: '', requestedSessionDateET: '', sessionDateET: '', sourceSessionDateET: '',
    levels: [], priorRange: 0, dataKey: '', status: 'idle', message: '', pending: false,
    token: 0, controller: null, retryAt: 0
  };

  function easternDateFromUS(timeUS) {
    const milliseconds = Number(timeUS) / 1000;
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
    const parts = Object.fromEntries(ET_DATE.formatToParts(new Date(milliseconds))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : '';
  }

  function todayET() {
    const parts = Object.fromEntries(ET_DATE.formatToParts(new Date())
      .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function activeSymbol() {
    const value = String(document.getElementById('tickerInput')?.value || '').trim().toUpperCase();
    return /^[A-Z0-9.-]{1,16}$/.test(value) ? value : '';
  }

  function numericText(elementID) {
    const value = String(document.getElementById(elementID)?.textContent || '').replace('−', '-').trim();
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : NaN;
  }

  function setObservedClockUS(timeUS) {
    const day = easternDateFromUS(timeUS);
    if (!day || day === observedSessionDateET) return;
    observedSessionDateET = day;
    ensurePivots(true);
  }

  function requestSessionDateET() {
    return observedSessionDateET || todayET();
  }

  function clearPivots(symbol, requestedSessionDateET) {
    pivotState.controller?.abort();
    pivotState.symbol = symbol;
    pivotState.requestedSessionDateET = requestedSessionDateET;
    pivotState.sessionDateET = '';
    pivotState.sourceSessionDateET = '';
    pivotState.levels = [];
    pivotState.priorRange = 0;
    pivotState.dataKey = '';
    pivotState.status = 'loading';
    pivotState.message = '';
    pivotState.pending = false;
    pivotState.retryAt = 0;
    pivotState.token++;
  }

  function ensurePivots(force = false) {
    const symbol = activeSymbol();
    const requestedSessionDateET = requestSessionDateET();
    if (!symbol || !requestedSessionDateET) return;
    const contextChanged = symbol !== pivotState.symbol || requestedSessionDateET !== pivotState.requestedSessionDateET;
    if (contextChanged) clearPivots(symbol, requestedSessionDateET);
    if (pivotState.pending) return;
    if (!force && pivotState.status === 'ready' && !contextChanged) return;
    if (!force && performance.now() < pivotState.retryAt) return;
    void loadPivots(symbol, requestedSessionDateET, ++pivotState.token);
  }

  async function loadPivots(symbol, requestedSessionDateET, token) {
    pivotState.pending = true;
    pivotState.status = 'loading';
    const controller = new AbortController();
    pivotState.controller = controller;
    try {
      const query = new URLSearchParams({ symbol, before: requestedSessionDateET, limit: '1' });
      const response = await originalFetch(`/api/panel-data/daily-bars?${query}`, {
        cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error((await response.text()).trim() || 'completed RTH history unavailable');
      const payload = await response.json();
      if (token !== pivotState.token || symbol !== activeSymbol()) return;
      const bar = Array.isArray(payload.bars) ? payload.bars.at(-1) : null;
      const pivots = calculateDailyPivots(bar);
      if (payload.status !== 'ready' || !bar?.complete || !pivots) {
        throw new Error(payload.message || 'one complete prior RTH session is required');
      }
      pivotState.symbol = symbol;
      pivotState.requestedSessionDateET = String(payload.beforeSessionDateET || requestedSessionDateET);
      pivotState.sessionDateET = String(payload.beforeSessionDateET || requestedSessionDateET);
      pivotState.sourceSessionDateET = String(bar.sessionDateET || '');
      pivotState.levels = dailyPivotLevels(pivots);
      pivotState.priorRange = pivots.priorRange;
      pivotState.dataKey = `${symbol}|${payload.beforeSessionDateET || requestedSessionDateET}|${bar.sessionDateET || ''}|${pivotState.levels.map((level) => `${level.key}:${level.price}`).join(',')}`;
      pivotState.status = 'ready';
      pivotState.message = '';
      pivotState.retryAt = 0;
      const authoritativeDay = String(payload.beforeSessionDateET || '');
      if (authoritativeDay) observedSessionDateET = authoritativeDay;
      repaintKnownMappings();
    } catch (error) {
      if (error?.name === 'AbortError' || token !== pivotState.token) return;
      pivotState.levels = [];
      pivotState.priorRange = 0;
      pivotState.dataKey = '';
      pivotState.status = 'unavailable';
      pivotState.message = String(error?.message || error);
      pivotState.retryAt = performance.now() + RETRY_MS;
    } finally {
      if (token === pivotState.token) {
        pivotState.pending = false;
        pivotState.controller = null;
      }
    }
  }

  function parseRequestBody(init) {
    try {
      if (typeof init?.body !== 'string') return null;
      return JSON.parse(init.body);
    } catch (_) {
      return null;
    }
  }

  function requestPath(input) {
    try {
      const raw = typeof input === 'string' ? input : input?.url;
      return raw ? new URL(raw, location.href).pathname : '';
    } catch (_) {
      return '';
    }
  }

  async function observeFetchResponse(path, response, requestBody) {
    if (!response.ok) return;
    try {
      if (path === '/api/replay') {
        const payload = await response.json();
        setObservedClockUS(payload.chart_end_us || payload.replay?.position_us);
        return;
      }
      if (path === '/api/render') {
        const payload = await response.json();
        setObservedClockUS(requestBody?.target_us || payload.replay?.position_us);
        return;
      }
      if (path === '/api/ticker') {
        await response.json();
        queueMicrotask(() => ensurePivots(true));
      }
    } catch (_) {}
  }

  // Observe only the application requests that establish an authoritative replay
  // date. The response returned to app.js is untouched; parsing happens on a clone.
  window.fetch = async function pivotAwareFetch(input, init) {
    const path = requestPath(input);
    const requestBody = parseRequestBody(init);
    const response = await originalFetch(input, init);
    if (path === '/api/replay' || path === '/api/render' || path === '/api/ticker') {
      void observeFetchResponse(path, response.clone(), requestBody);
    }
    return response;
  };

  function isAxisLabel(chartContext, canvas, text, x) {
    if (!TARGETS.has(canvas.id)) return false;
    const style = String(chartContext.fillStyle || '').replaceAll(' ', '').toLowerCase();
    if (style !== '#8d96a2' && style !== 'rgb(141,150,162)') return false;
    if (!/^-?\d+\.\d{2,3}$/.test(String(text))) return false;
    const width = canvas.getBoundingClientRect().width;
    return Number(x) > width * 0.52;
  }

  function captureBlockedLabel(canvas, text, y) {
    const value = String(text || '');
    if (!/^\s*(AVG|STOP)\b/.test(value)) return;
    const capture = captures.get(canvas);
    if (capture && Number.isFinite(Number(y))) capture.blockedY.push(Number(y));
  }

  function beginOrContinueCapture(canvas, chartContext, text, x, y) {
    const price = Number(text);
    const now = performance.now();
    let capture = captures.get(canvas);
    if (!capture || capture.complete || now - capture.at > 30 || Number(y) <= capture.lastY) {
      capture = { values: [], x: Number(x), lastY: -Infinity, at: now, complete: false, blockedY: [] };
      captures.set(canvas, capture);
    }
    capture.at = now;
    capture.lastY = Number(y);
    capture.values.push({ price, y: Number(y) });
    if (capture.values.length !== 5) return;
    capture.complete = true;
    const values = capture.values.slice().sort((left, right) => left.y - right.y);
    const topValue = values[0];
    const bottomValue = values.at(-1);
    const target = TARGETS.get(canvas.id);
    const mapping = {
      canvas, chartContext, left: target.left, right: Number(capture.x) - 5,
      top: topValue.y, bottom: bottomValue.y,
      maximum: topValue.price, minimum: bottomValue.price,
      blockedY: capture.blockedY, target
    };
    mappings.set(canvas.id, mapping);
    // Grid labels are the final operation before price bars begin. Draw guides
    // now so the renderer paints candles and indicators over them.
    drawLines(mapping);
    queueMicrotask(() => drawLabels(mapping));
  }

  CanvasRenderingContext2D.prototype.fillText = function pivotAwareFillText(text, x, y, maxWidth) {
    const result = arguments.length >= 4
      ? originalFillText.call(this, text, x, y, maxWidth)
      : originalFillText.call(this, text, x, y);
    try {
      const canvas = this.canvas;
      if (!canvas || !TARGETS.has(canvas.id)) return result;
      captureBlockedLabel(canvas, text, y);
      if (isAxisLabel(this, canvas, text, x)) beginOrContinueCapture(canvas, this, text, x, y);
    } catch (_) {}
    return result;
  };

  function mappingPriceY(mapping, price) {
    const span = mapping.maximum - mapping.minimum;
    if (!Number.isFinite(span) || span <= 0) return NaN;
    return mapping.bottom - (Number(price) - mapping.minimum) / span * (mapping.bottom - mapping.top);
  }

  function overlayOptions(mapping) {
    const currentPrice = numericText(mapping.target.priceElement);
    return {
      levels: pivotState.levels,
      priceY: (price) => mappingPriceY(mapping, price),
      minimum: mapping.minimum,
      maximum: mapping.maximum,
      left: mapping.left,
      right: mapping.right,
      top: mapping.top,
      bottom: mapping.bottom,
      currentPrice,
      priorRange: pivotState.priorRange,
      background: mapping.target.background,
      formatPrice: (value) => Number(value) < 1 ? Number(value).toFixed(4) : Number(value).toFixed(2),
      blockedY: mapping.blockedY
    };
  }

  function prepareContext(mapping) {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    mapping.chartContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function drawLines(mapping) {
    if (pivotState.status !== 'ready' || !pivotState.levels.length || mapping.lineDataKey === pivotState.dataKey) return;
    prepareContext(mapping);
    drawDailyPivotLines(mapping.chartContext, overlayOptions(mapping));
    mapping.lineDataKey = pivotState.dataKey;
  }

  function drawLabels(mapping) {
    if (pivotState.status !== 'ready' || !pivotState.levels.length || mapping.labelDataKey === pivotState.dataKey) return;
    prepareContext(mapping);
    drawDailyPivotLabels(mapping.chartContext, overlayOptions(mapping));
    mapping.labelDataKey = pivotState.dataKey;
  }

  function repaintKnownMappings() {
    for (const mapping of mappings.values()) {
      drawLines(mapping);
      drawLabels(mapping);
    }
  }

  function pollContext() {
    const symbol = activeSymbol();
    if (symbol && symbol !== pivotState.symbol) clearPivots(symbol, requestSessionDateET());
    ensurePivots(false);
  }

  window.__tapeReadingDailyPivots = {
    calculate: calculateDailyPivots,
    refresh: () => ensurePivots(true),
    state: () => ({
      symbol: pivotState.symbol,
      sessionDateET: pivotState.sessionDateET,
      sourceSessionDateET: pivotState.sourceSessionDateET,
      status: pivotState.status,
      message: pivotState.message,
      priorRange: pivotState.priorRange,
      levels: pivotState.levels.map(({ key, price }) => ({ key, price }))
    })
  };

  pollTimer = window.setInterval(pollContext, 500);
  window.addEventListener('pagehide', () => {
    clearInterval(pollTimer);
    pivotState.controller?.abort();
  }, { once: true });
  queueMicrotask(pollContext);
})();
