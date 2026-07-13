(() => {
  'use strict';

  const STORAGE_KEY = 'tape-reading-tool.settings.v1';
  const MAX_LOCAL_TRADES = 120000;
  const $ = (id) => document.getElementById(id);
  const elements = {
    app: $('app'), workspace: $('workspace'), chartPanel: $('chartPanel'), chart: $('chartCanvas'), chartEmpty: $('chartEmpty'),
    tapePanel: $('tapePanel'), tapeRows: $('tapeRows'), sizeHeading: $('sizeHeading'),
    tickerForm: $('tickerForm'), tickerInput: $('tickerInput'), historySelect: $('historySelect'),
    historyBack: $('historyBack'), historyForward: $('historyForward'), tickSelect: $('tickSelect'),
    soundButton: $('soundButton'), controlsButton: $('controlsButton'), connectionState: $('connectionState'),
    lastPrice: $('lastPrice'), priceChange: $('priceChange'), maxDelta: $('maxDelta'), minDelta: $('minDelta'), tapeRate: $('tapeRate'),
    quoteText: $('quoteText'), streamText: $('streamText'), clockText: $('clockText'),
    dialog: $('controlsDialog'), resetControls: $('resetControls'),
    customTicks: $('customTicks'), visibleBars: $('visibleBars'), tapeRowCount: $('tapeRowCount'),
    showChart: $('showChart'), showTape: $('showTape'), showSize: $('showSize'),
    masterVolume: $('masterVolume'), masterValue: $('masterValue'), minimumGain: $('minimumGain'), minimumGainValue: $('minimumGainValue'),
    buyPitch: $('buyPitch'), buyPitchValue: $('buyPitchValue'),
    sellPitch: $('sellPitch'), sellPitchValue: $('sellPitchValue'), soundDuration: $('soundDuration'), durationValue: $('durationValue'),
    largeSize: $('largeSize'), largeBoost: $('largeBoost'), largeBoostValue: $('largeBoostValue'), maxVoices: $('maxVoices')
  };

  const state = {
    symbol: 'AAPL', trades: [], bars: [], quote: {}, history: [], status: {},
    defaults: null, settings: null, ws: null, reconnectTimer: null, reconnectDelay: 500,
    tapePool: [], rateTimes: [], dropped: 0, dirtyChart: true, dirtyTape: true,
    navSymbols: [], navIndex: -1, lastMetricUpdate: 0
  };

  class TapeAudio {
    constructor() {
      this.context = null;
      this.node = null;
      this.gain = null;
      this.ready = false;
      this.enabled = true;
      this.starting = false;
    }

    async start() {
      if (this.ready || this.starting) return;
      this.starting = true;
      try {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        await this.context.audioWorklet.addModule('/audio-worklet.js');
        this.node = new AudioWorkletNode(this.context, 'tape-mixer', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
        this.gain = this.context.createGain();
        this.node.connect(this.gain).connect(this.context.destination);
        await this.context.resume();
        this.ready = true;
        this.sync();
      } catch (error) {
        console.error('audio mixer:', error);
        this.enabled = false;
      } finally {
        this.starting = false;
        updateSoundButton();
      }
    }

    setEnabled(value) {
      this.enabled = Boolean(value);
      if (state.settings) state.settings.audio.enabled = this.enabled;
      this.sync();
      saveSettings();
      updateSoundButton();
    }

    sync() {
      if (!state.settings || !this.ready) return;
      const config = state.settings.audio;
      this.node.port.postMessage({ type: 'config', config: {
        buyPitchHz: config.buyPitchHz,
        sellPitchHz: config.sellPitchHz,
        durationMS: config.durationMS,
        minimumGain: config.minimumGain,
        largeSize: config.largeSize,
        largeBoost: config.largeBoost,
        maxVoices: config.maxVoices
      }});
      const value = this.enabled ? config.masterVolume : 0;
      this.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.012);
    }

    push(trades) {
      if (!this.ready || !this.enabled || !trades.length) return;
      const base = trades[0].r || 0;
      const events = trades.map((trade) => ({
        side: trade.d,
        size: trade.z,
        delayMS: base ? Math.max(0, Math.min(80, (trade.r - base) / 1000)) : 0
      }));
      this.node.port.postMessage({ type: 'ticks', events });
    }
  }

  const audio = new TapeAudio();
  const context = elements.chart.getContext('2d', { alpha: false, desynchronized: true });

  function serverDefaults(display, audioConfig) {
    return {
      tickSize: Number(display.tick_size) || 1,
      customTicks: Number(display.tick_size) || 1,
      visibleBars: Number(display.visible_bars) || 360,
      tapeRows: Number(display.tape_rows) || 90,
      showSize: display.show_size !== false,
      showChart: display.show_chart !== false,
      showTape: display.show_tape !== false,
      audio: {
        enabled: audioConfig.enabled !== false,
        masterVolume: Number(audioConfig.master_volume) || 0.45,
        minimumGain: Number(audioConfig.minimum_gain) || 0.65,
        buyPitchHz: Number(audioConfig.buy_pitch_hz) || 920,
        sellPitchHz: Number(audioConfig.sell_pitch_hz) || 330,
        durationMS: Number(audioConfig.duration_ms) || 42,
        largeSize: Number(audioConfig.large_size) || 1000,
        largeBoost: Number(audioConfig.large_boost) || 1.8,
        maxVoices: Number(audioConfig.max_voices) || 192
      }
    };
  }

  function mergeSettings(defaults, saved) {
    if (!saved || typeof saved !== 'object') return structuredClone(defaults);
    const result = { ...defaults, ...saved, audio: { ...defaults.audio, ...(saved.audio || {}) } };
    result.tickSize = clampInt(result.tickSize, 1, 100000, defaults.tickSize);
    result.customTicks = clampInt(result.customTicks, 1, 100000, result.tickSize);
    result.visibleBars = clampInt(result.visibleBars, 20, 4000, defaults.visibleBars);
    result.tapeRows = clampInt(result.tapeRows, 10, 300, defaults.tapeRows);
    result.audio.masterVolume = clampNumber(result.audio.masterVolume, 0, 2, defaults.audio.masterVolume);
    result.audio.minimumGain = clampNumber(result.audio.minimumGain, 0.1, 1.5, defaults.audio.minimumGain);
    result.audio.buyPitchHz = clampNumber(result.audio.buyPitchHz, 300, 1800, defaults.audio.buyPitchHz);
    result.audio.sellPitchHz = clampNumber(result.audio.sellPitchHz, 100, 900, defaults.audio.sellPitchHz);
    result.audio.durationMS = clampNumber(result.audio.durationMS, 10, 140, defaults.audio.durationMS);
    result.audio.largeSize = clampNumber(result.audio.largeSize, 1, 100000, defaults.audio.largeSize);
    result.audio.largeBoost = clampNumber(result.audio.largeBoost, 1, 4, defaults.audio.largeBoost);
    result.audio.maxVoices = clampInt(result.audio.maxVoices, 8, 512, defaults.audio.maxVoices);
    return result;
  }

  function readSavedSettings() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (_) { return null; }
  }

  function saveSettings() {
    if (!state.settings) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  }

  function clampInt(value, minimum, maximum, fallback) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    state.ws = socket;
    setConnection({ state: 'connecting', connected: false });
    socket.onopen = () => {
      state.reconnectDelay = 500;
      setConnection({ state: 'stream', connected: true });
    };
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      handleMessage(message);
    };
    socket.onclose = () => {
      if (state.ws !== socket) return;
      setConnection({ state: 'reconnecting', connected: false });
      state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
      state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.7);
    };
    socket.onerror = () => socket.close();
  }

  function handleMessage(message) {
    if (message.type === 'snapshot' && message.snapshot) {
      if (!state.defaults) {
        state.defaults = serverDefaults(message.display || {}, message.audio || {});
        state.settings = mergeSettings(state.defaults, readSavedSettings());
        audio.enabled = state.settings.audio.enabled;
        syncControlValues();
        applyLayout();
      }
      const snapshot = message.snapshot;
      state.symbol = snapshot.symbol || message.symbol;
      state.trades = Array.isArray(snapshot.trades) ? snapshot.trades : [];
      state.quote = snapshot.quote || {};
      state.history = snapshot.history || [];
      state.status = snapshot.status || {};
      state.dropped = 0;
      elements.tickerInput.value = state.symbol;
      pushNavigation(state.symbol, state.navIndex < 0);
      updateHistory(state.history);
      rebuildBars();
      ensureTapePool();
      state.dirtyTape = true;
      setConnection(state.status);
      updateQuoteText();
      return;
    }
    if (message.type === 'trades' && message.symbol === state.symbol) {
      const trades = Array.isArray(message.trades) ? message.trades : [];
      if (message.quote) state.quote = message.quote;
      if (message.dropped) state.dropped += message.dropped;
      if (trades.length) ingestTrades(trades);
      updateQuoteText();
      return;
    }
    if (message.type === 'status') {
      if (message.status) {
        state.status = message.status;
        setConnection(message.status);
      }
      if (message.history) {
        state.history = message.history;
        updateHistory(message.history);
      }
    }
  }

  function ingestTrades(trades) {
    const now = performance.now();
    for (const trade of trades) {
      state.trades.push(trade);
      addTradeToBars(trade);
      state.rateTimes.push(now);
    }
    if (state.trades.length > MAX_LOCAL_TRADES) {
      state.trades.splice(0, state.trades.length - MAX_LOCAL_TRADES);
    }
    audio.push(trades);
    state.dirtyChart = true;
    state.dirtyTape = true;
  }

  function rebuildBars() {
    state.bars = [];
    if (!state.settings) return;
    for (const trade of state.trades) addTradeToBars(trade);
    state.dirtyChart = true;
    state.dirtyTape = true;
  }

  function addTradeToBars(trade) {
    const tickSize = state.settings ? state.settings.tickSize : 1;
    let bar = state.bars[state.bars.length - 1];
    if (!bar || bar.count >= tickSize) {
      bar = {
        count: 0, open: trade.p, high: trade.p, low: trade.p, close: trade.p,
        volume: 0, delta: 0, time: trade.t, received: trade.r, className: trade.c
      };
      state.bars.push(bar);
      const maxBars = Math.max(10000, (state.settings?.visibleBars || 360) * 3);
      if (state.bars.length > maxBars) state.bars.splice(0, state.bars.length - maxBars);
    }
    bar.count++;
    bar.high = Math.max(bar.high, trade.p);
    bar.low = Math.min(bar.low, trade.p);
    bar.close = trade.p;
    bar.volume += trade.z;
    bar.delta += trade.z * trade.d;
    bar.time = trade.t;
    bar.received = trade.r;
    bar.className = trade.c;
  }

  function ensureTapePool() {
    if (!state.settings) return;
    const count = state.settings.tapeRows;
    if (state.tapePool.length === count) return;
    elements.tapeRows.replaceChildren();
    state.tapePool = [];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'tape-row mid';
      const price = document.createElement('span');
      const size = document.createElement('span');
      row.append(price, size);
      row.hidden = true;
      state.tapePool.push({ row, price, size });
      fragment.append(row);
    }
    elements.tapeRows.append(fragment);
    state.dirtyTape = true;
  }

  function renderTape() {
    const newest = state.trades.length - 1;
    for (let i = 0; i < state.tapePool.length; i++) {
      const cell = state.tapePool[i];
      const trade = state.trades[newest - i];
      if (!trade) {
        cell.row.hidden = true;
        continue;
      }
      cell.row.hidden = false;
      cell.row.className = `tape-row ${trade.c || 'mid'}`;
      cell.price.textContent = formatPrice(trade.p);
      cell.size.textContent = formatSize(trade.z);
    }
    state.dirtyTape = false;
  }

  function resizeCanvas() {
    const rect = elements.chart.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (elements.chart.width !== width || elements.chart.height !== height) {
      elements.chart.width = width;
      elements.chart.height = height;
      state.dirtyChart = true;
    }
  }

  function drawChart() {
    resizeCanvas();
    const rect = elements.chart.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#0c0f13';
    context.fillRect(0, 0, width, height);
    if (width < 80 || height < 120 || !state.bars.length) {
      elements.chartEmpty.classList.toggle('hidden', state.bars.length > 0);
      state.dirtyChart = false;
      return;
    }
    elements.chartEmpty.classList.add('hidden');

    const rightAxis = width < 250 ? 46 : 52;
    const left = 6;
    const right = width - rightAxis;
    const top = 7;
    const bottom = 20;
    const usable = height - top - bottom;
    const priceBottom = top + usable * 0.57;
    const volumeTop = priceBottom + 8;
    const volumeBottom = volumeTop + usable * 0.19;
    const deltaTop = volumeBottom + 8;
    const deltaBottom = height - bottom;
    const visible = state.bars.slice(-state.settings.visibleBars);
    const step = (right - left) / visible.length;

    let minimum = Infinity;
    let maximum = -Infinity;
    let maxVolume = 0;
    let maxAbsDelta = 0;
    let maxDelta = 0;
    let minDelta = 0;
    for (const bar of visible) {
      minimum = Math.min(minimum, bar.low);
      maximum = Math.max(maximum, bar.high);
      maxVolume = Math.max(maxVolume, bar.volume);
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(bar.delta));
      maxDelta = Math.max(maxDelta, bar.delta);
      minDelta = Math.min(minDelta, bar.delta);
    }
    const pricePadding = Math.max((maximum - minimum) * 0.08, maximum * 0.00008, 0.005);
    minimum -= pricePadding;
    maximum += pricePadding;
    const priceY = (value) => priceBottom - (value - minimum) / (maximum - minimum) * (priceBottom - top);
    const xAt = (index) => left + (index + 0.5) * step;

    context.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.textBaseline = 'middle';
    context.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = top + (priceBottom - top) * i / 4;
      const price = maximum - (maximum - minimum) * i / 4;
      context.strokeStyle = '#252b33';
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
      context.fillStyle = '#8d96a2';
      context.textAlign = 'left';
      context.fillText(formatAxisPrice(price), right + 5, y);
    }

    context.strokeStyle = '#66717e';
    context.globalAlpha = 0.45;
    context.beginPath();
    visible.forEach((bar, index) => {
      const x = xAt(index);
      const y = priceY(bar.close);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
    context.globalAlpha = 1;

    const tickWidth = Math.max(0.6, Math.min(2.2, step * 0.3));
    visible.forEach((bar, index) => {
      const x = xAt(index);
      const up = bar.close >= bar.open;
      context.strokeStyle = up ? '#34c7d9' : '#ff4d5e';
      context.lineWidth = step < 1 ? 0.7 : 1;
      context.beginPath();
      context.moveTo(x, priceY(bar.high));
      context.lineTo(x, priceY(bar.low));
      context.moveTo(x - tickWidth, priceY(bar.open));
      context.lineTo(x, priceY(bar.open));
      context.moveTo(x, priceY(bar.close));
      context.lineTo(x + tickWidth, priceY(bar.close));
      context.stroke();
    });

    drawPaneBorder(volumeTop, volumeBottom, 'VOL', formatSize(maxVolume));
    const volumeHeight = volumeBottom - volumeTop - 14;
    visible.forEach((bar, index) => {
      const heightValue = maxVolume ? bar.volume / maxVolume * volumeHeight : 0;
      context.fillStyle = bar.delta >= 0 ? '#238f86' : '#a93b49';
      const barWidth = Math.max(0.7, Math.min(5, step * 0.72));
      context.fillRect(xAt(index) - barWidth / 2, volumeBottom - heightValue, barWidth, heightValue);
    });

    drawPaneBorder(deltaTop, deltaBottom, 'VOLUME DELTA', formatSigned(visible[visible.length - 1].delta));
    const zero = deltaTop + (deltaBottom - deltaTop) / 2;
    context.setLineDash([4, 4]);
    context.strokeStyle = '#68717c';
    context.beginPath(); context.moveTo(left, zero); context.lineTo(right, zero); context.stroke();
    context.setLineDash([]);
    const deltaHeight = (deltaBottom - deltaTop) / 2 - 13;
    visible.forEach((bar, index) => {
      const value = maxAbsDelta ? bar.delta / maxAbsDelta * deltaHeight : 0;
      context.fillStyle = value >= 0 ? '#22d49a' : '#ff4d5e';
      const barWidth = Math.max(0.7, Math.min(5, step * 0.72));
      context.fillRect(xAt(index) - barWidth / 2, value >= 0 ? zero - value : zero, barWidth, Math.abs(value));
    });
    context.fillStyle = '#8d96a2';
    context.textAlign = 'left';
    context.fillText('0', right + 5, zero);

    const labelIndexes = visible.length < 3 ? [0] : [0, Math.floor((visible.length - 1) / 2), visible.length - 1];
    context.fillStyle = '#78818c';
    context.textBaseline = 'bottom';
    labelIndexes.forEach((index, labelIndex) => {
      context.textAlign = labelIndex === 0 ? 'left' : labelIndex === labelIndexes.length - 1 ? 'right' : 'center';
      context.fillText(formatTime(visible[index].time), xAt(index), height - 2);
    });

    const last = visible[visible.length - 1];
    const currentY = priceY(last.close);
    context.setLineDash([2, 3]);
    context.strokeStyle = '#d4d9df';
    context.globalAlpha = 0.65;
    context.beginPath(); context.moveTo(left, currentY); context.lineTo(right, currentY); context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
    context.fillStyle = '#d8dde2';
    context.fillRect(right, currentY - 9, rightAxis, 18);
    context.fillStyle = '#090b0e';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.fillText(formatPrice(last.close), right + 4, currentY);

    updateDeltaMetrics(maxDelta, minDelta);
    state.dirtyChart = false;

    function drawPaneBorder(paneTop, paneBottom, label, value) {
      context.strokeStyle = '#2a3038';
      context.beginPath(); context.moveTo(left, paneTop); context.lineTo(width, paneTop); context.stroke();
      context.fillStyle = '#8d96a2';
      context.textAlign = 'left';
      context.textBaseline = 'top';
      context.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      context.fillText(label, left + 2, paneTop + 3);
      const labelWidth = context.measureText(label).width;
      context.fillStyle = label === 'VOLUME DELTA' ? (String(value).startsWith('-') ? '#ff4d5e' : '#22d49a') : '#34c7d9';
      context.fillText(value, left + labelWidth + 8, paneTop + 3);
      context.textBaseline = 'middle';
    }
  }

  function updateDeltaMetrics(maximum, minimum) {
    elements.maxDelta.textContent = formatSigned(maximum);
    elements.minDelta.textContent = formatSigned(minimum);
  }

  function setConnection(status) {
    const connected = Boolean(status && status.connected);
    const stateName = String(status?.state || 'waiting').toUpperCase();
    const className = connected ? 'connection-state live' : /ERROR|DEGRADED/.test(stateName) ? 'connection-state error' : 'connection-state';
    elements.connectionState.className = className;
    elements.connectionState.querySelector('span').textContent = stateName;
    elements.connectionState.title = status?.message || stateName;
  }

  function updateHistory(history) {
    const current = elements.historySelect.value;
    elements.historySelect.replaceChildren();
    for (const symbol of history) {
      const option = document.createElement('option');
      option.value = symbol;
      option.textContent = symbol;
      elements.historySelect.append(option);
    }
    elements.historySelect.value = history.includes(current) ? current : state.symbol;
  }

  async function switchSymbol(rawSymbol, record = true) {
    const symbol = String(rawSymbol || '').trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,16}$/.test(symbol)) {
      elements.tickerInput.focus();
      elements.tickerInput.select();
      return;
    }
    elements.tickerInput.value = symbol;
    if (record) pushNavigation(symbol, true);
    try {
      const response = await fetch('/api/ticker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
      if (!response.ok) throw new Error(await response.text());
    } catch (error) {
      setConnection({ state: 'error', connected: false, message: error.message });
    }
  }

  function pushNavigation(symbol, force) {
    if (!force && state.navIndex >= 0 && state.navSymbols[state.navIndex] === symbol) return;
    if (state.navIndex >= 0 && state.navSymbols[state.navIndex] === symbol) return;
    state.navSymbols = state.navSymbols.slice(0, state.navIndex + 1);
    state.navSymbols.push(symbol);
    if (state.navSymbols.length > 50) state.navSymbols.shift();
    state.navIndex = state.navSymbols.length - 1;
    updateNavButtons();
  }

  function updateNavButtons() {
    elements.historyBack.disabled = state.navIndex <= 0;
    elements.historyForward.disabled = state.navIndex < 0 || state.navIndex >= state.navSymbols.length - 1;
  }

  function applyLayout() {
    if (!state.settings) return;
    const { showChart, showTape, showSize } = state.settings;
    elements.workspace.className = 'workspace';
    if (!showChart && !showTape) elements.workspace.classList.add('both-hidden');
    else if (!showChart) elements.workspace.classList.add('chart-hidden');
    else if (!showTape) elements.workspace.classList.add('tape-hidden');
    elements.tapePanel.classList.toggle('hide-size', !showSize);
    ensureTapePool();
    state.dirtyChart = true;
    state.dirtyTape = true;
  }

  function syncControlValues() {
    const settings = state.settings;
    const preset = ['1', '10', '100', '1000'].includes(String(settings.tickSize)) ? String(settings.tickSize) : 'custom';
    elements.tickSelect.value = preset;
    elements.customTicks.value = settings.customTicks;
    elements.visibleBars.value = settings.visibleBars;
    elements.tapeRowCount.value = settings.tapeRows;
    elements.showChart.checked = settings.showChart;
    elements.showTape.checked = settings.showTape;
    elements.showSize.checked = settings.showSize;
    elements.masterVolume.value = settings.audio.masterVolume;
    elements.minimumGain.value = settings.audio.minimumGain;
    elements.buyPitch.value = settings.audio.buyPitchHz;
    elements.sellPitch.value = settings.audio.sellPitchHz;
    elements.soundDuration.value = settings.audio.durationMS;
    elements.largeSize.value = settings.audio.largeSize;
    elements.largeBoost.value = settings.audio.largeBoost;
    elements.maxVoices.value = settings.audio.maxVoices;
    updateControlOutputs();
    updateSoundButton();
  }

  function updateControlOutputs() {
    if (!state.settings) return;
    elements.masterValue.textContent = `${Math.round(state.settings.audio.masterVolume * 100)}%`;
    elements.minimumGainValue.textContent = `${Math.round(state.settings.audio.minimumGain * 100)}%`;
    elements.buyPitchValue.textContent = `${state.settings.audio.buyPitchHz} Hz`;
    elements.sellPitchValue.textContent = `${state.settings.audio.sellPitchHz} Hz`;
    elements.durationValue.textContent = `${state.settings.audio.durationMS} ms`;
    elements.largeBoostValue.textContent = `${Number(state.settings.audio.largeBoost).toFixed(1)}x`;
  }

  function updateSoundButton() {
    elements.soundButton.className = 'sound-button';
    if (!audio.ready) {
      elements.soundButton.textContent = audio.starting ? 'SOUND ...' : audio.enabled ? 'SOUND START' : 'SOUND OFF';
      if (!audio.enabled) elements.soundButton.classList.add('muted');
      return;
    }
    elements.soundButton.textContent = audio.enabled ? 'SOUND ON' : 'SOUND OFF';
    elements.soundButton.classList.add(audio.enabled ? 'active' : 'muted');
  }

  function commitSettings(rebuild = false) {
    saveSettings();
    applyLayout();
    audio.sync();
    updateControlOutputs();
    if (rebuild) rebuildBars();
  }

  function bindControls() {
    elements.tickerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      switchSymbol(elements.tickerInput.value, true);
      elements.tickerInput.select();
    });
    elements.tickerInput.addEventListener('focus', () => elements.tickerInput.select());
    elements.historySelect.addEventListener('change', () => switchSymbol(elements.historySelect.value, true));
    elements.historyBack.addEventListener('click', () => {
      if (state.navIndex <= 0) return;
      state.navIndex--;
      updateNavButtons();
      switchSymbol(state.navSymbols[state.navIndex], false);
    });
    elements.historyForward.addEventListener('click', () => {
      if (state.navIndex >= state.navSymbols.length - 1) return;
      state.navIndex++;
      updateNavButtons();
      switchSymbol(state.navSymbols[state.navIndex], false);
    });
    elements.tickSelect.addEventListener('change', () => {
      if (!state.settings) return;
      if (elements.tickSelect.value === 'custom') {
        state.settings.tickSize = state.settings.customTicks;
        syncControlValues();
        elements.dialog.showModal();
        setTimeout(() => { elements.customTicks.focus(); elements.customTicks.select(); }, 0);
      } else {
        state.settings.tickSize = Number(elements.tickSelect.value);
        commitSettings(true);
      }
    });
    elements.soundButton.addEventListener('click', async () => {
      if (!audio.ready) {
        audio.enabled = true;
        if (state.settings) state.settings.audio.enabled = true;
        await audio.start();
      } else {
        audio.setEnabled(!audio.enabled);
      }
    });
    elements.controlsButton.addEventListener('click', () => elements.dialog.showModal());
    elements.resetControls.addEventListener('click', () => {
      state.settings = structuredClone(state.defaults);
      audio.enabled = state.settings.audio.enabled;
      syncControlValues();
      commitSettings(true);
    });

    elements.customTicks.addEventListener('change', () => {
      state.settings.customTicks = clampInt(elements.customTicks.value, 1, 100000, 1);
      state.settings.tickSize = state.settings.customTicks;
      elements.tickSelect.value = ['1', '10', '100', '1000'].includes(String(state.settings.tickSize)) ? String(state.settings.tickSize) : 'custom';
      commitSettings(true);
    });
    elements.visibleBars.addEventListener('change', () => {
      state.settings.visibleBars = clampInt(elements.visibleBars.value, 20, 4000, 360);
      commitSettings(false);
    });
    elements.tapeRowCount.addEventListener('change', () => {
      state.settings.tapeRows = clampInt(elements.tapeRowCount.value, 10, 300, 90);
      commitSettings(false);
    });
    for (const [element, key] of [[elements.showChart, 'showChart'], [elements.showTape, 'showTape'], [elements.showSize, 'showSize']]) {
      element.addEventListener('change', () => { state.settings[key] = element.checked; commitSettings(false); });
    }
    const audioBindings = [
      [elements.masterVolume, 'masterVolume', Number], [elements.minimumGain, 'minimumGain', Number],
      [elements.buyPitch, 'buyPitchHz', Number],
      [elements.sellPitch, 'sellPitchHz', Number], [elements.soundDuration, 'durationMS', Number],
      [elements.largeSize, 'largeSize', Number], [elements.largeBoost, 'largeBoost', Number],
      [elements.maxVoices, 'maxVoices', Number]
    ];
    for (const [element, key, parser] of audioBindings) {
      element.addEventListener('input', () => {
        state.settings.audio[key] = parser(element.value);
        commitSettings(false);
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
        event.preventDefault();
        elements.tickerInput.focus();
      }
    });
  }

  function updateQuoteText() {
    const bid = state.quote.bid > 0 ? formatPrice(state.quote.bid) : '--';
    const ask = state.quote.ask > 0 ? formatPrice(state.quote.ask) : '--';
    elements.quoteText.textContent = `BID ${bid} / ASK ${ask}`;
  }

  function updateLiveMetrics(now) {
    const cutoff = now - 1000;
    while (state.rateTimes.length && state.rateTimes[0] < cutoff) state.rateTimes.shift();
    elements.tapeRate.textContent = `${state.rateTimes.length}/s`;
    const last = state.trades[state.trades.length - 1];
    elements.lastPrice.textContent = last ? formatPrice(last.p) : '--';
    updatePriceChange(last?.p, state.quote.previous_close);
    elements.streamText.textContent = `${formatSize(state.trades.length)} PRINTS${state.dropped ? ` / ${formatSize(state.dropped)} LAGGED` : ''}`;
    elements.clockText.textContent = `${new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date())} ET`;
  }

  function animationLoop(now) {
    if (state.dirtyChart && state.settings?.showChart) drawChart();
    if (state.dirtyTape && state.settings?.showTape) renderTape();
    if (now - state.lastMetricUpdate > 100) {
      updateLiveMetrics(now);
      state.lastMetricUpdate = now;
    }
    requestAnimationFrame(animationLoop);
  }

  function formatPrice(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    const decimals = number < 1 ? 4 : 2;
    return number.toFixed(decimals);
  }

  function updatePriceChange(lastPrice, previousClose) {
    const last = Number(lastPrice);
    const previous = Number(previousClose);
    const valid = Number.isFinite(last) && last > 0 && Number.isFinite(previous) && previous > 0;
    if (!valid) {
      elements.priceChange.textContent = '--';
      elements.priceChange.className = 'price-change neutral';
      elements.priceChange.removeAttribute('aria-label');
      return;
    }
    const percent = (last - previous) / previous * 100;
    const rounded = Math.abs(percent) < 0.005 ? 0 : percent;
    const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
    elements.priceChange.textContent = `${sign}${Math.abs(rounded).toFixed(2)}%`;
    elements.priceChange.className = `price-change ${rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'neutral'}`;
    elements.priceChange.setAttribute('aria-label', `${sign}${Math.abs(rounded).toFixed(2)} percent from previous close`);
  }

  function formatAxisPrice(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    return number < 1 ? number.toFixed(3) : number.toFixed(2);
  }

  function formatSize(value) {
    const number = Math.abs(Number(value) || 0);
    if (number >= 1e9) return `${(number / 1e9).toFixed(number >= 1e10 ? 0 : 1)}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e4 ? 0 : 1)}K`;
    return Math.round(number).toString();
  }

  function formatSigned(value) {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : number < 0 ? '-' : ''}${formatSize(number)}`;
  }

  function formatTime(timestamp) {
    if (!timestamp) return '--:--:--';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(timestamp));
  }

  bindControls();
  new ResizeObserver(() => { state.dirtyChart = true; }).observe(elements.chartPanel);
  connect();
  updateNavButtons();
  updateSoundButton();
  requestAnimationFrame(animationLoop);
})();
