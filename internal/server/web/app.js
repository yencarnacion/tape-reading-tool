(() => {
  'use strict';

  const STORAGE_KEY = 'tape-reading-tool.settings.v1';
  const SOUND_PROFILE_VERSION = 2;
  const LEGACY_SOUND_DEFAULTS = { buyPitchHz: 920, sellPitchHz: 330, durationMS: 42 };
  const MAX_LOCAL_TRADES = 120000;
  const LOCAL_TRADE_PRUNE_CHUNK = 8192;
  const HORIZONS = [5, 15, 60];
  const BALANCE_DEADBAND_PERCENT = 2;
  const ET_MINUTE_PARTS = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const $ = (id) => document.getElementById(id);
  const elements = {
    app: $('app'), workspace: $('workspace'), visualStack: $('visualStack'), chartPanel: $('chartPanel'), chart: $('chartCanvas'), chartEmpty: $('chartEmpty'), rollingPanel: $('rollingPanel'),
    replayMarketPanel: $('replayMarketPanel'), replayChart: $('replayChartCanvas'), replayChartEmpty: $('replayChartEmpty'),
    tapePanel: $('tapePanel'), tapeRows: $('tapeRows'), sizeHeading: $('sizeHeading'),
    tickerForm: $('tickerForm'), tickerInput: $('tickerInput'), historySelect: $('historySelect'),
    historyBack: $('historyBack'), historyForward: $('historyForward'), tickSelect: $('tickSelect'),
    soundButton: $('soundButton'), replayButton: $('replayButton'), controlsButton: $('controlsButton'), connectionState: $('connectionState'),
    lastPrice: $('lastPrice'), priceChange: $('priceChange'), maxDelta: $('maxDelta'), minDelta: $('minDelta'), tapeRate: $('tapeRate'),
    replayClock: $('replayClock'), replayClockTime: $('replayClockTime'),
    quoteText: $('quoteText'), streamText: $('streamText'), clockText: $('clockText'),
    dialog: $('controlsDialog'), resetControls: $('resetControls'),
    customTicks: $('customTicks'), visibleBars: $('visibleBars'), tapeRowCount: $('tapeRowCount'),
    showChart: $('showChart'), showTape: $('showTape'), showSize: $('showSize'),
    masterVolume: $('masterVolume'), masterValue: $('masterValue'), minimumGain: $('minimumGain'), minimumGainValue: $('minimumGainValue'),
    tapeRateEnabled: $('tapeRateEnabled'), tapeRateVolume: $('tapeRateVolume'), tapeRateVolumeValue: $('tapeRateVolumeValue'),
    buyPitch: $('buyPitch'), buyPitchValue: $('buyPitchValue'),
    sellPitch: $('sellPitch'), sellPitchValue: $('sellPitchValue'), soundDuration: $('soundDuration'), durationValue: $('durationValue'),
    largeSize: $('largeSize'), largeBoost: $('largeBoost'), largeBoostValue: $('largeBoostValue'), maxVoices: $('maxVoices'),
    replayDialog: $('replayDialog'), replayProvider: $('replayProvider'), replaySource: $('replaySource'),
    replayStart: $('replayStart'), replayEnd: $('replayEnd'), replaySpeed: $('replaySpeed'), replaySeek: $('replaySeek'),
    replaySeekButton: $('replaySeekButton'), replayStatus: $('replayStatus'), replayStop: $('replayStop'),
    replayPause: $('replayPause'), replayStartButton: $('replayStartButton')
  };

  const state = {
    symbol: 'AAPL', trades: [], bars: [], quote: {}, history: [], status: {},
    defaults: null, settings: null, ws: null, reconnectTimer: null, reconnectDelay: 500,
    tapePool: [], dropped: 0, dirtyChart: true, dirtyTape: true,
    navSymbols: [], navIndex: -1, lastMetricUpdate: 0,
    prefixBase: { volume: 0, buyer: 0, seller: 0, prints: 0 }, midpoints: [],
    serverClockUS: 0, serverClockAt: 0, replay: null, replayConfig: null,
    minuteBars: [], replayChartEndUS: 0, replayChartKey: '', dirtyReplayChart: true
  };

  const horizonElements = new Map(HORIZONS.map((seconds) => {
    const row = elements.rollingPanel.querySelector(`[data-horizon="${seconds}"]`);
    return [seconds, {
      row, winner: row.querySelector('.winner'), volume: row.querySelector('.volume'),
      buyerVolume: row.querySelector('.buyer-volume'), sellerVolume: row.querySelector('.seller-volume'),
      deltaPercent: row.querySelector('.delta-percent'), signedDelta: row.querySelector('.signed-delta'), sharesRate: row.querySelector('.shares-rate'),
      printsRate: row.querySelector('.prints-rate'), midChange: row.querySelector('.mid-change'),
      relativePace: row.querySelector('.relative-pace')
    }];
  }));

  class TapeAudio {
    constructor() {
      this.context = null;
      this.node = null;
      this.gain = null;
      this.tapeRateGain = null;
      this.ready = false;
      this.enabled = true;
      this.starting = false;
      this.currentTapeRate = 0;
    }

    async start() {
      if (this.ready || this.starting) return;
      this.starting = true;
      try {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        await this.context.audioWorklet.addModule('/audio-worklet.js');
        this.node = new AudioWorkletNode(this.context, 'tape-mixer', {
          numberOfInputs: 0,
          numberOfOutputs: 2,
          outputChannelCount: [2, 2]
        });
        this.gain = this.context.createGain();
        this.tapeRateGain = this.context.createGain();
        this.node.connect(this.gain, 0, 0).connect(this.context.destination);
        this.node.connect(this.tapeRateGain, 1, 0).connect(this.context.destination);
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
      const tapeRateValue = config.tapeRateEnabled ? config.tapeRateVolume : 0;
      this.tapeRateGain.gain.setTargetAtTime(tapeRateValue, this.context.currentTime, 0.025);
      this.node.port.postMessage({ type: 'tape-rate-active', active: tapeRateValue > 0 });
      this.node.port.postMessage({ type: 'tape-rate', rate: this.currentTapeRate });
    }

    setTapeRate(rate) {
      this.currentTapeRate = Math.max(0, Number(rate) || 0);
      if (this.ready) this.node.port.postMessage({ type: 'tape-rate', rate: this.currentTapeRate });
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
  const replayContext = elements.replayChart.getContext('2d', { alpha: false, desynchronized: true });

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
        profileVersion: SOUND_PROFILE_VERSION,
        enabled: audioConfig.enabled !== false,
        masterVolume: Number(audioConfig.master_volume) || 0.45,
        tapeRateEnabled: audioConfig.tape_rate_enabled !== false,
        tapeRateVolume: Number.isFinite(Number(audioConfig.tape_rate_volume)) ? Number(audioConfig.tape_rate_volume) : 0.35,
        minimumGain: Number(audioConfig.minimum_gain) || 0.65,
        buyPitchHz: Number(audioConfig.buy_pitch_hz) || 660,
        sellPitchHz: Number(audioConfig.sell_pitch_hz) || 490,
        durationMS: Number(audioConfig.duration_ms) || 110,
        largeSize: Number(audioConfig.large_size) || 1000,
        largeBoost: Number(audioConfig.large_boost) || 1.8,
        maxVoices: Number(audioConfig.max_voices) || 192
      }
    };
  }

  function mergeSettings(defaults, saved) {
    if (!saved || typeof saved !== 'object') return structuredClone(defaults);
    const result = { ...defaults, ...saved, audio: { ...defaults.audio, ...(saved.audio || {}) } };
    if ((Number(result.audio.profileVersion) || 1) < SOUND_PROFILE_VERSION) {
      for (const [key, legacyValue] of Object.entries(LEGACY_SOUND_DEFAULTS)) {
        if (Number(result.audio[key]) === legacyValue) result.audio[key] = defaults.audio[key];
      }
    }
    result.audio.profileVersion = SOUND_PROFILE_VERSION;
    result.tickSize = clampInt(result.tickSize, 1, 100000, defaults.tickSize);
    result.customTicks = clampInt(result.customTicks, 1, 100000, result.tickSize);
    result.visibleBars = clampInt(result.visibleBars, 20, 4000, defaults.visibleBars);
    result.tapeRows = clampInt(result.tapeRows, 10, 300, defaults.tapeRows);
    result.audio.masterVolume = clampNumber(result.audio.masterVolume, 0, 2, defaults.audio.masterVolume);
    result.audio.tapeRateEnabled = result.audio.tapeRateEnabled !== false;
    result.audio.tapeRateVolume = clampNumber(result.audio.tapeRateVolume, 0, 1, defaults.audio.tapeRateVolume);
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
      syncServerClock(message.server_time_ms);
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
      prepareTradeHistory();
      rebuildMinuteBars(state.trades);
      observeReceiptClock(state.trades);
      state.quote = snapshot.quote || {};
      state.history = snapshot.history || [];
      state.status = snapshot.status || {};
      state.replayConfig = message.replay_config || state.replayConfig;
      if (state.replayConfig) {
        elements.replayProvider.value = state.replayConfig.provider || 'all';
        elements.replaySource.value = state.replayConfig.source || 'live';
        elements.replaySpeed.value = String(state.replayConfig.speed || 1);
      }
      state.dropped = 0;
      elements.tickerInput.value = state.symbol;
      pushNavigation(state.symbol, state.navIndex < 0);
      updateHistory(state.history);
      rebuildBars();
      ensureTapePool();
      state.dirtyTape = true;
      setConnection(state.status);
      const chartKey = `${state.symbol}|${state.replayConfig?.source || 'live'}|${state.replayConfig?.provider || 'all'}`;
      if (state.status.mode === 'replay' && state.replayChartKey !== chartKey) {
        state.replayChartKey = chartKey;
        queueMicrotask(() => refreshReplayRange(false));
      }
      updateQuoteText();
      return;
    }
    if (message.type === 'trades' && message.symbol === state.symbol) {
      const trades = Array.isArray(message.trades) ? message.trades : [];
      if (message.quote) state.quote = message.quote;
      if (message.dropped) state.dropped += message.dropped;
      if (trades.length) {
        observeReceiptClock(trades);
        ingestTrades(trades);
      }
      updateQuoteText();
      return;
    }
    if (message.type === 'status') {
      if (message.status) {
        const pausing = message.status.mode === 'replay' && message.status.state === 'paused';
        if (pausing && state.status?.state !== 'paused') {
          state.serverClockUS = serverNowUS(performance.now());
          state.serverClockAt = performance.now();
        } else if (!pausing) {
          syncServerClock(message.server_time_ms);
        }
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
    for (const trade of trades) {
      appendTradePrefix(trade);
      state.trades.push(trade);
      addTradeToBars(trade);
      addTradeToMinuteBars(trade);
    }
    if (state.trades.length > MAX_LOCAL_TRADES + LOCAL_TRADE_PRUNE_CHUNK) {
      const removeCount = state.trades.length - MAX_LOCAL_TRADES;
      const lastRemoved = state.trades[removeCount - 1];
      state.prefixBase = prefixFromTrade(lastRemoved);
      state.trades.splice(0, removeCount);
      const firstSequence = state.trades[0]?.s || Infinity;
      const firstRetainedMidpoint = lowerBound(state.midpoints, firstSequence, (trade) => Number(trade.s) || 0);
      if (firstRetainedMidpoint > 0) state.midpoints.splice(0, firstRetainedMidpoint);
    }
    audio.push(trades);
    state.dirtyChart = true;
    state.dirtyReplayChart = true;
    state.dirtyTape = true;
  }

  function prepareTradeHistory() {
    state.prefixBase = { volume: 0, buyer: 0, seller: 0, prints: 0 };
    state.midpoints = [];
    let volumeTotal = 0;
    let buyerTotal = 0;
    let sellerTotal = 0;
    let printTotal = 0;
    for (const trade of state.trades) {
      const volume = Math.max(0, Number(trade.z) || 0);
      volumeTotal += volume;
      if (trade.d > 0) buyerTotal += volume;
      if (trade.d < 0) sellerTotal += volume;
      printTotal++;
      trade._volume = volumeTotal;
      trade._buyer = buyerTotal;
      trade._seller = sellerTotal;
      trade._prints = printTotal;
      addMidpoint(trade);
    }
  }

  function appendTradePrefix(trade) {
    const previousTrade = state.trades[state.trades.length - 1];
    const volume = Math.max(0, Number(trade.z) || 0);
    trade._volume = (previousTrade ? Number(previousTrade._volume) || 0 : state.prefixBase.volume) + volume;
    trade._buyer = (previousTrade ? Number(previousTrade._buyer) || 0 : state.prefixBase.buyer) + (trade.d > 0 ? volume : 0);
    trade._seller = (previousTrade ? Number(previousTrade._seller) || 0 : state.prefixBase.seller) + (trade.d < 0 ? volume : 0);
    trade._prints = (previousTrade ? Number(previousTrade._prints) || 0 : state.prefixBase.prints) + 1;
    addMidpoint(trade);
  }

  function prefixFromTrade(trade) {
    return {
      volume: Number(trade?._volume) || 0,
      buyer: Number(trade?._buyer) || 0,
      seller: Number(trade?._seller) || 0,
      prints: Number(trade?._prints) || 0
    };
  }

  function addMidpoint(trade) {
    const bid = Number(trade.b);
    const ask = Number(trade.a);
    if (bid > 0 && ask >= bid) {
      state.midpoints.push(trade);
    }
  }

  function syncServerClock(serverTimeMS) {
    const milliseconds = Number(serverTimeMS);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    state.serverClockUS = milliseconds * 1000;
    state.serverClockAt = performance.now();
  }

  function observeReceiptClock(trades) {
    let latest = 0;
    for (const trade of trades) latest = Math.max(latest, Number(trade.r) || 0);
    if (!latest) return;
    const estimated = serverNowUS(performance.now());
    if (!estimated || latest > estimated) {
      state.serverClockUS = latest;
      state.serverClockAt = performance.now();
    }
  }

  function serverNowUS(now) {
    if (state.status?.mode === 'replay' && state.status?.state === 'paused') return state.serverClockUS;
    if (state.serverClockUS > 0) return state.serverClockUS + Math.max(0, now - state.serverClockAt) * 1000;
    return Number(state.trades[state.trades.length - 1]?.r) || 0;
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

  function rebuildMinuteBars(trades) {
    state.minuteBars = [];
    for (const trade of trades) addTradeToMinuteBars(trade);
    state.dirtyReplayChart = true;
  }

  function addTradeToMinuteBars(trade) {
    const receiptUS = Number(trade.r) || Number(trade.t) * 1000;
    const price = Number(trade.p);
    const size = Math.max(0, Number(trade.z) || 0);
    if (!receiptUS || !Number.isFinite(price) || price <= 0) return;
    const timeUS = Math.floor(receiptUS / 6e7) * 6e7;
    let bar = state.minuteBars[state.minuteBars.length - 1];
    if (!bar || bar.timeUS !== timeUS) {
      bar = { timeUS, open: price, high: price, low: price, close: price, volume: 0, dollarVolume: 0 };
      state.minuteBars.push(bar);
      if (state.minuteBars.length > 2000) state.minuteBars.splice(0, state.minuteBars.length - 2000);
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += size;
    bar.dollarVolume += price * size;
  }

  function replaceReplayMinuteBars(rawBars, chartEndUS) {
    const loaded = (Array.isArray(rawBars) ? rawBars : []).map((bar) => ({
      timeUS: Number(bar.time_us), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low),
      close: Number(bar.close), volume: Number(bar.volume) || 0, dollarVolume: Number(bar.dollar_volume) || 0
    })).filter((bar) => bar.timeUS > 0 && bar.close > 0);
    state.minuteBars = loaded;
    state.replayChartEndUS = Number(chartEndUS) || 0;
    // Preserve prints that arrived while the chart-history request was in flight.
    for (const trade of state.trades) {
      if ((Number(trade.r) || 0) > state.replayChartEndUS) addTradeToMinuteBars(trade);
    }
    state.dirtyReplayChart = true;
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
    const rightAxis = width < 250 ? 46 : 52;
    const left = 6;
    const right = width - rightAxis;
    const top = 7;
    const bottom = 20;
    const usable = height - top - bottom;
    const paneGap = 8;
    const minimumRollingHeight = width <= 350 ? 224 : 184;
    const rollingPaneHeight = Math.min(Math.max(minimumRollingHeight, usable * 0.25), usable * 0.5);
    const remaining = Math.max(0, usable - rollingPaneHeight - paneGap * 2);
    const deltaPaneHeight = remaining * 0.30;
    const deltaTop = top;
    const deltaBottom = deltaTop + deltaPaneHeight;
    const rollingTop = deltaBottom + paneGap;
    const rollingBottom = rollingTop + rollingPaneHeight;
    const priceTop = rollingBottom + paneGap;
    const priceBottom = height - bottom;
    positionRollingPanel(rollingTop, rollingBottom);
    if (width < 80 || height < 120 || !state.bars.length) {
      elements.chartEmpty.classList.toggle('hidden', state.bars.length > 0);
      state.dirtyChart = false;
      return;
    }
    elements.chartEmpty.classList.add('hidden');
    const visible = state.bars.slice(-state.settings.visibleBars);
    const step = (right - left) / visible.length;

    let minimum = Infinity;
    let maximum = -Infinity;
    let maxAbsDelta = 0;
    let maxDelta = 0;
    let minDelta = 0;
    for (const bar of visible) {
      minimum = Math.min(minimum, bar.low);
      maximum = Math.max(maximum, bar.high);
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(bar.delta));
      maxDelta = Math.max(maxDelta, bar.delta);
      minDelta = Math.min(minDelta, bar.delta);
    }
    const pricePadding = Math.max((maximum - minimum) * 0.08, maximum * 0.00008, 0.005);
    minimum -= pricePadding;
    maximum += pricePadding;
    const priceY = (value) => priceBottom - (value - minimum) / (maximum - minimum) * (priceBottom - priceTop);
    const xAt = (index) => left + (index + 0.5) * step;

    context.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.textBaseline = 'middle';
    context.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = priceTop + (priceBottom - priceTop) * i / 4;
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

  function resizeReplayCanvas() {
    const rect = elements.replayChart.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (elements.replayChart.width !== width || elements.replayChart.height !== height) {
      elements.replayChart.width = width;
      elements.replayChart.height = height;
    }
  }

  function drawReplayChart() {
    resizeReplayCanvas();
    const rect = elements.replayChart.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    replayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    replayContext.fillStyle = '#0c0f13';
    replayContext.fillRect(0, 0, width, height);
    if (width < 160 || height < 150 || !state.minuteBars.length) {
      elements.replayChartEmpty.classList.toggle('hidden', state.minuteBars.length > 0);
      state.dirtyReplayChart = false;
      return;
    }
    elements.replayChartEmpty.classList.add('hidden');

    const indicators = calculateReplayIndicators(state.minuteBars);
    const rightAxis = width < 360 ? 48 : 56;
    const left = 7;
    const right = width - rightAxis;
    const top = 25;
    const axisBottom = 20;
    const paneGap = 8;
    const volumeHeight = Math.max(45, Math.min(92, (height - top - axisBottom) * 0.22));
    const volumeBottom = height - axisBottom;
    const volumeTop = volumeBottom - volumeHeight;
    const priceBottom = volumeTop - paneGap;
    const rightGapBars = Math.max(5, Math.min(100, Math.round(Number(state.replayConfig?.chart_right_gap_bars) || 5)));
    const capacity = Math.max(24, Math.min(180, Math.floor((right - left) / (width < 500 ? 5 : 7)) - rightGapBars));
    const start = Math.max(0, state.minuteBars.length - capacity);
    const visible = state.minuteBars.slice(start);
    const visibleIndicators = indicators.slice(start);
    const step = (right - left) / (visible.length + rightGapBars);
    const xAt = (index) => left + (index + 0.5) * step;

    let minimum = Infinity;
    let maximum = -Infinity;
    let maxVolume = 0;
    for (let index = 0; index < visible.length; index++) {
      const bar = visible[index];
      const values = visibleIndicators[index];
      minimum = Math.min(minimum, bar.low);
      maximum = Math.max(maximum, bar.high);
      for (const value of [values.vwap, values.sma9, values.sma20, values.upper, values.lower]) {
        if (Number.isFinite(value)) {
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
      maxVolume = Math.max(maxVolume, bar.volume);
    }
    const pricePadding = Math.max((maximum - minimum) * 0.07, maximum * 0.00008, 0.005);
    minimum -= pricePadding;
    maximum += pricePadding;
    const priceY = (value) => priceBottom - (value - minimum) / (maximum - minimum) * (priceBottom - top);

    replayContext.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    replayContext.lineWidth = 1;
    replayContext.textBaseline = 'middle';
    for (let index = 0; index <= 4; index++) {
      const y = top + (priceBottom - top) * index / 4;
      const price = maximum - (maximum - minimum) * index / 4;
      replayContext.strokeStyle = '#252b33';
      replayContext.beginPath(); replayContext.moveTo(left, y); replayContext.lineTo(right, y); replayContext.stroke();
      replayContext.fillStyle = '#8d96a2';
      replayContext.textAlign = 'left';
      replayContext.fillText(formatAxisPrice(price), right + 5, y);
    }

    const bodyWidth = Math.max(1, Math.min(8, step * 0.62));
    visible.forEach((bar, index) => {
      const x = xAt(index);
      const up = bar.close >= bar.open;
      const color = up ? '#34c7d9' : '#ff4d5e';
      replayContext.strokeStyle = color;
      replayContext.fillStyle = color;
      replayContext.beginPath(); replayContext.moveTo(x, priceY(bar.high)); replayContext.lineTo(x, priceY(bar.low)); replayContext.stroke();
      const openY = priceY(bar.open);
      const closeY = priceY(bar.close);
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      if (up) {
        replayContext.globalAlpha = 0.34;
        replayContext.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
        replayContext.globalAlpha = 1;
        replayContext.strokeRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
      } else {
        replayContext.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
      }
    });

    drawReplayIndicator('lower', '#f2f5f7', 1, 0.72);
    drawReplayIndicator('upper', '#f2f5f7', 1, 0.72);
    drawReplayIndicator('sma20', '#56c7ff', 1.4, 1);
    drawReplayIndicator('sma9', '#ff4d5e', 2.2, 1);
    drawReplayIndicator('vwap', '#ffd447', 2.6, 1);

    replayContext.strokeStyle = '#3a424c';
    replayContext.beginPath(); replayContext.moveTo(left, volumeTop); replayContext.lineTo(width, volumeTop); replayContext.stroke();
    replayContext.fillStyle = '#8d96a2';
    replayContext.textAlign = 'left';
    replayContext.textBaseline = 'top';
    replayContext.fillText('VOLUME', left + 2, volumeTop + 3);
    replayContext.textAlign = 'left';
    replayContext.fillText(formatSize(maxVolume), right + 5, volumeTop + 7);
    const volumeUsable = volumeHeight - 15;
    visible.forEach((bar, index) => {
      const heightValue = maxVolume ? bar.volume / maxVolume * volumeUsable : 0;
      replayContext.fillStyle = bar.close >= bar.open ? 'rgba(52,199,217,.68)' : 'rgba(255,77,94,.68)';
      replayContext.fillRect(xAt(index) - bodyWidth / 2, volumeBottom - heightValue, bodyWidth, heightValue);
    });

    const labelIndexes = visible.length < 3 ? [0] : [0, Math.floor((visible.length - 1) / 2), visible.length - 1];
    replayContext.fillStyle = '#78818c';
    replayContext.textBaseline = 'bottom';
    labelIndexes.forEach((index, labelIndex) => {
      replayContext.textAlign = labelIndex === 0 ? 'left' : labelIndex === labelIndexes.length - 1 ? 'right' : 'center';
      replayContext.fillText(formatTime(visible[index].timeUS / 1000).slice(0, 5), xAt(index), height - 2);
    });

    const last = visible[visible.length - 1];
    const currentY = priceY(last.close);
    replayContext.setLineDash([2, 3]);
    replayContext.strokeStyle = '#d8dde2';
    replayContext.globalAlpha = 0.62;
    replayContext.beginPath(); replayContext.moveTo(left, currentY); replayContext.lineTo(right, currentY); replayContext.stroke();
    replayContext.setLineDash([]);
    replayContext.globalAlpha = 1;
    replayContext.fillStyle = '#d8dde2';
    replayContext.fillRect(right, currentY - 9, rightAxis, 18);
    replayContext.fillStyle = '#090b0e';
    replayContext.textAlign = 'left';
    replayContext.textBaseline = 'middle';
    replayContext.font = '700 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    replayContext.fillText(formatPrice(last.close), right + 4, currentY);
    state.dirtyReplayChart = false;

    function drawReplayIndicator(key, color, lineWidth, alpha) {
      replayContext.strokeStyle = color;
      replayContext.lineWidth = lineWidth;
      replayContext.globalAlpha = alpha;
      replayContext.beginPath();
      let drawing = false;
      visibleIndicators.forEach((values, index) => {
        const value = values[key];
        if (!Number.isFinite(value)) {
          drawing = false;
          return;
        }
        if (!drawing) replayContext.moveTo(xAt(index), priceY(value));
        else replayContext.lineTo(xAt(index), priceY(value));
        drawing = true;
      });
      replayContext.stroke();
      replayContext.globalAlpha = 1;
    }
  }

  function calculateReplayIndicators(bars) {
    const result = [];
    let sum9 = 0;
    let sum20 = 0;
    let squares20 = 0;
    let sessionDate = '';
    let vwapDollars = 0;
    let vwapVolume = 0;
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index];
      sum9 += bar.close;
      sum20 += bar.close;
      squares20 += bar.close * bar.close;
      if (index >= 9) sum9 -= bars[index - 9].close;
      if (index >= 20) {
        sum20 -= bars[index - 20].close;
        squares20 -= bars[index - 20].close * bars[index - 20].close;
      }
      if (!bar._sessionDate) {
        const parts = Object.fromEntries(ET_MINUTE_PARTS.formatToParts(new Date(bar.timeUS / 1000)).map((part) => [part.type, part.value]));
        bar._sessionDate = `${parts.year}-${parts.month}-${parts.day}`;
        bar._minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
      }
      const date = bar._sessionDate;
      const minuteOfDay = bar._minuteOfDay;
      if (date !== sessionDate) {
        sessionDate = date;
        vwapDollars = 0;
        vwapVolume = 0;
      }
      if (minuteOfDay >= 9 * 60 + 30) {
        vwapDollars += bar.dollarVolume;
        vwapVolume += bar.volume;
      }
      const sma9 = index >= 8 ? sum9 / 9 : null;
      const sma20 = index >= 19 ? sum20 / 20 : null;
      const variance = index >= 19 ? Math.max(0, squares20 / 20 - sma20 * sma20) : 0;
      const deviation = Math.sqrt(variance);
      result.push({
        sma9, sma20,
        upper: sma20 === null ? null : sma20 + deviation * 2,
        lower: sma20 === null ? null : sma20 - deviation * 2,
        vwap: minuteOfDay >= 9 * 60 + 30 && vwapVolume > 0 ? vwapDollars / vwapVolume : null
      });
    }
    return result;
  }

  function positionRollingPanel(top, bottom) {
    elements.rollingPanel.style.top = `${Math.max(0, top)}px`;
    elements.rollingPanel.style.height = `${Math.max(0, bottom - top)}px`;
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
    const replayMode = status?.mode === 'replay';
    elements.replayButton.hidden = !replayMode;
    elements.replayClock.hidden = !replayMode;
    elements.replayMarketPanel.hidden = !replayMode;
    elements.workspace.classList.toggle('replay-mode', replayMode);
    state.dirtyReplayChart = true;
    if (replayMode) updateReplayControls({ ...(state.replay || {}), state: String(status?.state || '').toLowerCase(), message: status?.message });
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
    if (state.status?.mode === 'replay') elements.workspace.classList.add('replay-mode');
    if (!showChart && !showTape) elements.workspace.classList.add('both-hidden');
    else if (!showChart) elements.workspace.classList.add('chart-hidden');
    else if (!showTape) elements.workspace.classList.add('tape-hidden');
    elements.tapePanel.classList.toggle('hide-size', !showSize);
    ensureTapePool();
    state.dirtyChart = true;
    state.dirtyReplayChart = true;
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
    elements.tapeRateEnabled.checked = settings.audio.tapeRateEnabled;
    elements.tapeRateVolume.value = settings.audio.tapeRateVolume;
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
    elements.tapeRateVolumeValue.textContent = `${Math.round(state.settings.audio.tapeRateVolume * 100)}%`;
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
    elements.replayButton.addEventListener('click', async () => {
      elements.replayDialog.showModal();
      await refreshReplayRange();
    });
    elements.replayProvider.addEventListener('change', refreshReplayRange);
    elements.replaySource.addEventListener('change', refreshReplayRange);
    elements.replayStartButton.addEventListener('click', async () => {
      const startUS = inputToUS(elements.replayStart.value);
      const endUS = inputToUS(elements.replayEnd.value);
      await replayAction({
        action: 'start', symbol: state.symbol, provider: elements.replayProvider.value,
        source: elements.replaySource.value, start_us: startUS, end_us: endUS,
        speed: Number(elements.replaySpeed.value)
      });
    });
    elements.replayPause.addEventListener('click', async () => {
      await replayAction({ action: state.replay?.state === 'paused' ? 'resume' : 'pause' });
    });
    elements.replayStop.addEventListener('click', async () => { await replayAction({ action: 'stop' }); });
    elements.replaySeekButton.addEventListener('click', async () => {
      await replayAction({ action: 'seek', target_us: inputToUS(elements.replaySeek.value) });
    });
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
    elements.tapeRateEnabled.addEventListener('change', async () => {
      state.settings.audio.tapeRateEnabled = elements.tapeRateEnabled.checked;
      commitSettings(false);
      if (state.settings.audio.tapeRateEnabled && !audio.ready) await audio.start();
    });
    const audioBindings = [
      [elements.masterVolume, 'masterVolume', Number], [elements.tapeRateVolume, 'tapeRateVolume', Number],
      [elements.minimumGain, 'minimumGain', Number],
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

  async function refreshReplayRange(updateRangeInputs = true) {
    if (typeof updateRangeInputs !== 'boolean') updateRangeInputs = true;
    elements.replayStatus.textContent = 'LOADING RECORDINGS…';
    try {
      const query = new URLSearchParams({
        symbol: state.symbol, source: elements.replaySource.value, provider: elements.replayProvider.value
      });
      const response = await fetch(`/api/replay?${query}`);
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      state.replay = payload.replay || state.replay;
      replaceReplayMinuteBars(payload.chart_bars, payload.chart_end_us);
      const range = payload.range || {};
      if (!range.start_us || !range.end_us || !range.trades) {
        elements.replayStatus.textContent = `NO ${elements.replayProvider.value.toUpperCase()} ${elements.replaySource.value.toUpperCase()} TRADES FOR ${state.symbol}`;
        return;
      }
      const start = usToInput(range.start_us);
      const end = usToInput(range.end_us);
      if (updateRangeInputs || !elements.replayStart.value) {
        elements.replayStart.value = start;
        elements.replayEnd.value = end;
        elements.replaySeek.value = start.slice(0, 16);
      }
      for (const input of [elements.replayStart, elements.replayEnd, elements.replaySeek]) {
        input.min = start.slice(0, input === elements.replaySeek ? 16 : 19);
        input.max = end.slice(0, input === elements.replaySeek ? 16 : 19);
      }
      elements.replayStatus.textContent = `${formatSize(range.trades)} TRADES · ${formatSize(range.quotes)} QUOTES · ${formatReplayTime(range.start_us)}–${formatReplayTime(range.end_us)}`;
      updateReplayControls(state.replay);
    } catch (error) {
      elements.replayStatus.textContent = String(error.message || error).trim();
    }
  }

  async function replayAction(payload) {
    try {
      const response = await fetch('/api/replay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(await response.text());
      state.replay = await response.json();
      updateReplayControls(state.replay);
      if (payload.action === 'start' || payload.action === 'seek') await refreshReplayRange(false);
    } catch (error) {
      elements.replayStatus.textContent = String(error.message || error).trim();
    }
  }

  function updateReplayControls(replay) {
    if (!replay) return;
    state.replay = replay;
    const paused = replay.state === 'paused';
    elements.replayPause.textContent = paused ? 'RESUME' : 'PAUSE';
    elements.replayPause.classList.toggle('active', paused);
    elements.replayPause.disabled = !['replaying', 'paused'].includes(replay.state);
    elements.replayStop.disabled = !['replaying', 'paused'].includes(replay.state);
    if (replay.message) elements.replayStatus.textContent = `${String(replay.state || '').toUpperCase()} · ${replay.message}`;
  }

  function inputToUS(value) {
    const milliseconds = new Date(value).getTime();
    return Number.isFinite(milliseconds) ? Math.round(milliseconds * 1000) : 0;
  }

  function usToInput(value) {
    const date = new Date(Number(value) / 1000);
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatReplayTime(value) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date(Number(value) / 1000));
  }

  function updateQuoteText() {
    const bid = state.quote.bid > 0 ? formatPrice(state.quote.bid) : '--';
    const ask = state.quote.ask > 0 ? formatPrice(state.quote.ask) : '--';
    elements.quoteText.textContent = `BID ${bid} / ASK ${ask}`;
  }

  function lowerBound(items, target, selector) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (selector(items[middle]) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function upperBound(items, target, selector) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (selector(items[middle]) <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function totalsBetween(startUS, endUS, includeEnd = true) {
    const start = lowerBound(state.trades, startUS, (trade) => Number(trade.r) || 0);
    const end = (includeEnd ? upperBound : lowerBound)(state.trades, endUS, (trade) => Number(trade.r) || 0) - 1;
    if (start > end || end < 0 || start >= state.trades.length) return { volume: 0, buyer: 0, seller: 0, prints: 0 };
    const after = prefixFromTrade(state.trades[end]);
    const before = start > 0 ? prefixFromTrade(state.trades[start - 1]) : state.prefixBase;
    return {
      volume: Math.max(0, after.volume - before.volume),
      buyer: Math.max(0, after.buyer - before.buyer),
      seller: Math.max(0, after.seller - before.seller),
      prints: Math.max(0, after.prints - before.prints)
    };
  }

  function calculateHorizon(seconds, nowUS) {
    const durationUS = seconds * 1e6;
    const startUS = nowUS - durationUS;
    const totals = totalsBetween(startUS, nowUS);
    const baselineStartUS = startUS - durationUS;
    const baseline = totalsBetween(baselineStartUS, startUS, false);
    const oldestReceipt = Number(state.trades[0]?.r) || Infinity;
    const hasBaseline = oldestReceipt <= baselineStartUS;
    const sharesRate = totals.volume / seconds;
    const baselineRate = baseline.volume / seconds;
    const relativePace = hasBaseline
      ? baselineRate > 0 ? sharesRate / baselineRate : sharesRate > 0 ? Infinity : 1
      : null;
    const delta = totals.buyer - totals.seller;
    const deltaPercent = totals.volume > 0 ? delta / totals.volume * 100 : 0;
    const firstMidpoint = lowerBound(state.midpoints, startUS, (trade) => Number(trade.r) || 0);
    const afterLastMidpoint = upperBound(state.midpoints, nowUS, (trade) => Number(trade.r) || 0);
    let midTicks = 0;
    if (firstMidpoint < afterLastMidpoint) {
      const firstTrade = state.midpoints[firstMidpoint];
      const lastTrade = state.midpoints[afterLastMidpoint - 1];
      const first = (Number(firstTrade.b) + Number(firstTrade.a)) / 2;
      const last = (Number(lastTrade.b) + Number(lastTrade.a)) / 2;
      midTicks = (last - first) / priceTickSize(last);
    }
    return { ...totals, delta, deltaPercent, sharesRate, printsRate: totals.prints / seconds, midTicks, relativePace };
  }

  function priceTickSize(price) {
    return Number(price) > 0 && Number(price) < 1 ? 0.0001 : 0.01;
  }

  function updateRollingPanel(nowUS) {
    if (!nowUS) return;
    for (const seconds of HORIZONS) {
      const metric = calculateHorizon(seconds, nowUS);
      const cells = horizonElements.get(seconds);
      const magnitude = Math.abs(metric.deltaPercent);
      const direction = magnitude < BALANCE_DEADBAND_PERCENT ? 'balanced' : metric.deltaPercent > 0 ? 'buyer' : 'seller';
      cells.row.classList.remove('buyer', 'seller', 'balanced');
      cells.row.classList.add(direction);
      cells.row.style.setProperty('--pressure-width', `${Math.min(50, magnitude / 2)}%`);
      cells.winner.textContent = direction === 'buyer' ? 'BUY ▶' : direction === 'seller' ? '◀ SELL' : 'BALANCED';
      cells.volume.textContent = formatSize(metric.volume);
      cells.buyerVolume.textContent = `B ${formatSize(metric.buyer)}`;
      cells.sellerVolume.textContent = `S ${formatSize(metric.seller)}`;
      cells.deltaPercent.textContent = formatSignedPercent(metric.deltaPercent);
      cells.signedDelta.textContent = `Δ ${formatSigned(metric.delta)}`;
      cells.sharesRate.textContent = formatRate(metric.sharesRate);
      cells.printsRate.textContent = formatRate(metric.printsRate);
      cells.midChange.textContent = formatTickChange(metric.midTicks);
      cells.relativePace.textContent = formatRelativePace(metric.relativePace);
      cells.row.setAttribute('aria-label', `${seconds} seconds: ${formatSize(metric.volume)} total volume; ${formatSize(metric.buyer)} buyer initiated; ${formatSize(metric.seller)} seller initiated; delta ${formatSigned(metric.delta)}, ${formatSignedPercent(metric.deltaPercent)}; ${formatRate(metric.sharesRate)} shares per second; ${formatRate(metric.printsRate)} prints per second; midpoint ${formatTickChange(metric.midTicks)}; pace ${formatRelativePace(metric.relativePace)} versus the preceding ${seconds} seconds.`);
    }
  }

  function updateLiveMetrics(now) {
    const receiptNowUS = serverNowUS(now);
    const tapeRate = receiptNowUS ? totalsBetween(receiptNowUS - 1e6, receiptNowUS).prints : 0;
    elements.tapeRate.textContent = `${tapeRate >= 1000 ? formatSize(tapeRate) : tapeRate}/s`;
    audio.setTapeRate(tapeRate);
    updateRollingPanel(receiptNowUS);
    const last = state.trades[state.trades.length - 1];
    elements.lastPrice.textContent = last ? formatPrice(last.p) : '--';
    updatePriceChange(last?.p, state.quote.previous_close);
    elements.streamText.textContent = `${formatSize(state.trades.length)} PRINTS${state.dropped ? ` / ${formatSize(state.dropped)} LAGGED` : ''}`;
    const replayMode = state.status?.mode === 'replay';
    const replayState = String(state.replay?.state || state.status?.state || '').toLowerCase();
    const replayHasTimeline = replayMode && receiptNowUS && replayState !== 'ready' && replayState !== 'stopped';
    const clockDate = replayHasTimeline ? new Date(receiptNowUS / 1000) : new Date();
    const clockValue = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(clockDate);
    elements.clockText.textContent = `${replayMode ? (replayHasTimeline ? clockValue : '--:--:--') : clockValue} ET`;
    if (replayMode) elements.replayClockTime.textContent = replayHasTimeline ? clockValue : '--:--:--';
  }

  function animationLoop(now) {
    if (state.dirtyReplayChart && state.status?.mode === 'replay' && state.settings?.showChart) drawReplayChart();
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

  function formatRate(value) {
    const number = Math.max(0, Number(value) || 0);
    if (number >= 1000) return formatSize(number);
    if (number >= 100) return Math.round(number).toString();
    if (number >= 10) return number.toFixed(1).replace(/\.0$/, '');
    return number.toFixed(1);
  }

  function formatSignedPercent(value) {
    const number = Number(value) || 0;
    const rounded = Math.abs(number) < 0.5 ? 0 : Math.round(number);
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}%`;
  }

  function formatTickChange(value) {
    const number = Math.abs(Number(value)) < 0.05 ? 0 : Number(value) || 0;
    const absolute = Math.abs(number);
    const text = Math.abs(absolute - Math.round(absolute)) < 0.05 ? Math.round(absolute).toString() : absolute.toFixed(1);
    return `${number > 0 ? '+' : number < 0 ? '−' : ''}${text}t`;
  }

  function formatRelativePace(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return 'BUILD';
    if (!Number.isFinite(value)) return 'NEW';
    if (value >= 9.95) return '9.9×+';
    return `${value.toFixed(1)}×`;
  }

  function formatTime(timestamp) {
    if (!timestamp) return '--:--:--';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(timestamp));
  }

  bindControls();
  new ResizeObserver(() => { state.dirtyChart = true; state.dirtyReplayChart = true; }).observe(elements.visualStack);
  connect();
  updateNavButtons();
  updateSoundButton();
  requestAnimationFrame(animationLoop);
})();
