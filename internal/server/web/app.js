import {
  aggregateTickBars, appendMinuteBar, appendTickBar,
  calculateCandleRVOL, computeHorizon, computeTapeRate, lowerBound, rewindWindowStart, updatePriceScale
} from './tape-model.js';
import { createStreamSource, prefixFromTrade } from './tape-source.js';
import { RewindBuffer, createRewindSource } from './tape-rewind.js';
import { PanelHost } from './panel-host.js';
import { mergePanelSettings } from './panel-api.js';
import { tapePressureManifest, createTapePressureInstance } from './tape-pressure-panel.js';
import { blankPanelManifest } from './blank-panel.js';
import { adrRTHManifest } from './adr-rth-extension-panel.js';

(() => {
  'use strict';

  const STORAGE_KEY = 'tape-reading-tool.settings.v1';
  const SOUND_PROFILE_VERSION = 2;
  const LEGACY_SOUND_DEFAULTS = { buyPitchHz: 920, sellPitchHz: 330, durationMS: 42 };
  const MAX_LOCAL_TRADES = 120000;
  const LOCAL_TRADE_PRUNE_CHUNK = 8192;
  const ET_MINUTE_PARTS = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const $ = (id) => document.getElementById(id);
  const elements = {
    app: $('app'), workspace: $('workspace'), visualStack: $('visualStack'), chartPanel: $('chartPanel'), chart: $('chartCanvas'), chartEmpty: $('chartEmpty'),
    analyticsSlot: $('rollingPanel'), analyticsPanelRoot: $('analyticsPanelRoot'), analyticsPanelPicker: $('analyticsPanelPicker'),
    dayContext: $('dayContext'), dayContextCanvas: $('dayContextCanvas'), dayContextSession: $('dayContextSession'), dayContextChange: $('dayContextChange'), dayContextHigh: $('dayContextHigh'), dayContextLow: $('dayContextLow'), dayContextPosition: $('dayContextPosition'),
    replayMarketPanel: $('replayMarketPanel'), replayChart: $('replayChartCanvas'), replayChartEmpty: $('replayChartEmpty'),
    dailyChart: $('dailyChartCanvas'), dailyChartEmpty: $('dailyChartEmpty'), minuteChartTab: $('minuteChartTab'), dailyChartTab: $('dailyChartTab'),
    tapePanel: $('tapePanel'), tapeRows: $('tapeRows'), sizeHeading: $('sizeHeading'),
    tickerForm: $('tickerForm'), tickerInput: $('tickerInput'), historySelect: $('historySelect'), externalReplayBadge: $('externalReplayBadge'),
    historyBack: $('historyBack'), historyForward: $('historyForward'), tickSelect: $('tickSelect'),
    soundButton: $('soundButton'), replayButton: $('replayButton'), replayPlayButton: $('replayPlayButton'), replayPauseButton: $('replayPauseButton'), controlsButton: $('controlsButton'), connectionState: $('connectionState'),
    nbbo: $('nbbo'), bestBid: $('bestBid'), bestBidSize: $('bestBidSize'), nbboSpread: $('nbboSpread'), nbboSpreadDollars: $('nbboSpreadDollars'), bestAsk: $('bestAsk'), bestAskSize: $('bestAskSize'),
    lastPrice: $('lastPrice'), priceChange: $('priceChange'), maxDelta: $('maxDelta'), minDelta: $('minDelta'),
    maxDeltaDollars: $('maxDeltaDollars'), minDeltaDollars: $('minDeltaDollars'), tapeRate: $('tapeRate'),
    marketClock: $('marketClock'), marketClockLabel: $('marketClockLabel'), marketClockTime: $('marketClockTime'),
    relativeVolume: $('relativeVolume'), relativeVolumeValue: $('relativeVolumeValue'), relativeVolumeState: $('relativeVolumeState'),
    quoteText: $('quoteText'), streamText: $('streamText'),
    dialog: $('controlsDialog'), resetControls: $('resetControls'),
    customTicks: $('customTicks'), visibleBars: $('visibleBars'), tapeRowCount: $('tapeRowCount'),
    showChart: $('showChart'), showTape: $('showTape'), showSize: $('showSize'),
    masterVolume: $('masterVolume'), masterValue: $('masterValue'), minimumGain: $('minimumGain'), minimumGainValue: $('minimumGainValue'),
    tapeRateEnabled: $('tapeRateEnabled'), tapeRateVolume: $('tapeRateVolume'), tapeRateVolumeValue: $('tapeRateVolumeValue'),
    buyPitch: $('buyPitch'), buyPitchValue: $('buyPitchValue'),
    sellPitch: $('sellPitch'), sellPitchValue: $('sellPitchValue'), soundDuration: $('soundDuration'), durationValue: $('durationValue'),
    largeSize: $('largeSize'), largeBoost: $('largeBoost'), largeBoostValue: $('largeBoostValue'), maxVoices: $('maxVoices'),
    rewindPanel: $('rewindPanel'), rewindCanvas: $('rewindCanvas'), rewindBadge: $('rewindBadge'),
    rewindTicks: $('rewindTicks'), rewindSpeed: $('rewindSpeed'), rewindPlay: $('rewindPlay'),
    rewindStepBack: $('rewindStepBack'), rewindStepForward: $('rewindStepForward'), rewindExit: $('rewindExit'),
    rewindLast: $('rewindLast'), rewindMaxDelta: $('rewindMaxDelta'), rewindMinDelta: $('rewindMinDelta'),
    rewindMaxDeltaDollars: $('rewindMaxDeltaDollars'), rewindMinDeltaDollars: $('rewindMinDeltaDollars'),
    rewindRate: $('rewindRate'), rewindBid: $('rewindBid'), rewindAsk: $('rewindAsk'),
    rewindNotice: $('rewindNotice'), rewindClockTime: $('rewindClockTime'),
    replayDialog: $('replayDialog'), replayProvider: $('replayProvider'), replaySource: $('replaySource'),
    replayStart: $('replayStart'), replayEnd: $('replayEnd'), replaySpeed: $('replaySpeed'), replaySeek: $('replaySeek'),
    replaySeekButton: $('replaySeekButton'), replayStatus: $('replayStatus'), replayStop: $('replayStop'),
    replayPause: $('replayPause'), replayStartButton: $('replayStartButton')
  };

  const state = {
    symbol: 'AAPL', trades: [], bars: [], quote: {}, history: [], status: {},
    defaults: null, settings: null, ws: null, reconnectTimer: null, reconnectDelay: 500,
    tapePool: [], dropped: 0, dirtyChart: true, dirtyDayContext: true, dirtyTape: true, dayMapCorner: 0,
    navSymbols: [], navIndex: -1, lastMetricUpdate: 0,
    prefixBase: { volume: 0, buyer: 0, seller: 0, prints: 0 }, midpoints: [],
    serverClockUS: 0, serverClockAt: 0, replay: null, replayConfig: null, pendingReplayReset: false,
    externalTargetUS: 0, reportedAudioReady: null, reportedAudioAt: 0,
    minuteBars: [], dailyBars: [], marketChartView: 'minute', dailyHistorySymbol: '', dailyHistoryPending: false, dirtyDailyChart: true,
    replayChartEndUS: 0, replayChartKey: '', dirtyReplayChart: true, marketChartEnabled: false, xtraEnabled: false,
    rvolWarmup: { symbol: '', ready: false, pending: false, attempt: 0, token: 0, timer: null, controller: null },
    tickScale: null, minuteScale: null, renderNowMS: null, renderInitialized: false,
    rewindConfig: null, rewindPaneAvailable: false,
    rewind: {
      active: false, playing: false, buffer: null, source: null, targetSeq: 0, targetUS: 0,
      playbackEndUS: 0, holdForLiveClick: false, completed: false,
      speed: 0.25, tickSize: 1, bars: [], scale: null, dirty: false, notice: '',
      lastInteractionMS: 0, lastFrameMS: 0, token: 0, pressurePanel: null, pressureSource: null
    }
  };
  // The live and replay panes read every panel through this source. Live Rewind
  // adds a second source over the same aggregation code, never a second copy.
  const liveSource = createStreamSource(state);
  const DAY_MAP_CORNERS = ['', 'day-map-lower-left', 'day-map-lower-right', 'day-map-upper-right'];
  const DAY_MAP_CORNER_NAMES = ['upper-left', 'lower-left', 'lower-right', 'upper-right'];

  // Rewind owns an explicit Tape Pressure instance. It never clones or follows
  // the replaceable live analytics slot.
  const rewindRollingPanel = document.createElement('section');
  rewindRollingPanel.id = 'rewindRollingPanel';
  rewindRollingPanel.setAttribute('aria-label', 'Rewound tape pressure by horizon');
  elements.rewindPanel.append(rewindRollingPanel);
  let panelHost = null;

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
  const dayContext = elements.dayContextCanvas.getContext('2d', { alpha: false, desynchronized: true });
  const dailyContext = elements.dailyChart.getContext('2d', { alpha: false, desynchronized: true });

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
      },
      panels: { slots: { primaryAnalytics: { activePanelId: 'adr-rth-extension' } }, settings: { 'adr-rth-extension': { lookbackSessions: 20, directionMode: 'auto' } } }
    };
  }

  function mergeSettings(defaults, saved) {
    if (!saved || typeof saved !== 'object') return structuredClone(defaults);
    const result = {
      ...defaults, ...saved, audio: { ...defaults.audio, ...(saved.audio || {}) },
      panels: {
        slots: { primaryAnalytics: { ...defaults.panels.slots.primaryAnalytics, ...(saved.panels?.slots?.primaryAnalytics || {}) } },
        settings: { ...defaults.panels.settings, ...(saved.panels?.settings || {}) }
      }
    };
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
    if (!['tape-pressure', 'adr-rth-extension', 'blank'].includes(result.panels.slots.primaryAnalytics.activePanelId)) result.panels.slots.primaryAnalytics.activePanelId = 'adr-rth-extension';
    const adrMode = String(result.panels.settings['adr-rth-extension']?.directionMode || 'auto').toLowerCase();
    result.panels.settings['adr-rth-extension'] = { lookbackSessions: clampInt(result.panels.settings['adr-rth-extension']?.lookbackSessions, 5, 60, 20), directionMode: ['auto', 'low', 'high'].includes(adrMode) ? adrMode : 'auto' };
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
        panelHost = new PanelHost({
          root: elements.analyticsPanelRoot, picker: elements.analyticsPanelPicker,
          registry: [tapePressureManifest, adrRTHManifest, blankPanelManifest], settings: state.settings.panels, saveSettings,
          capabilities: {
            streamSource: () => liveSource,
            formatters: () => ({ size: formatSize, signedPercent: formatSignedPercent, signed: formatSigned, rate: formatRate, tickChange: formatTickChange, relativePace: formatRelativePace, price: formatPrice }),
            currentSnapshot: () => ({ symbol: state.symbol, mode: state.status?.mode || '', status: { ...state.status }, clockUS: serverNowUS(performance.now()), quote: { ...state.quote }, trades: state.trades.slice() }),
            getCompletedDailyBars: async ({ symbol, beforeSessionDateET, limit, signal }) => {
              const query = new URLSearchParams({ symbol, before: beforeSessionDateET, limit: String(limit) });
              const response = await fetch(`/api/panel-data/daily-bars?${query}`, { signal });
              if (!response.ok) throw new Error((await response.text()).trim() || 'daily history unavailable');
              return response.json();
            },
            getRTHSessionContext: async ({ symbol, sessionDateET, throughUS, signal }) => {
              const query = new URLSearchParams({ symbol, session: sessionDateET, through_us: String(Math.round(throughUS)) });
              const response = await fetch(`/api/panel-data/rth-context?${query}`, { signal });
              if (!response.ok) throw new Error((await response.text()).trim() || 'RTH context unavailable');
              return response.json();
            },
            // The host supplies the mounted panel's id and its declared defaults,
            // which shape what is written at every depth. Undeclared fields are
            // dropped and each panel's bounds are applied here, so a panel cannot
            // widen its own limits or write another panel's settings.
            savePanelSettings: (panelId, next, defaults) => {
              const merged = mergePanelSettings(defaults, next);
              if (panelId === 'adr-rth-extension') {
                merged.lookbackSessions = clampInt(merged.lookbackSessions, 5, 60, 20);
                merged.directionMode = ['auto', 'low', 'high'].includes(String(merged.directionMode || '').toLowerCase()) ? String(merged.directionMode).toLowerCase() : 'auto';
              }
              state.settings.panels.settings[panelId] = merged;
              saveSettings();
            }
          }
        });
        panelHost.swap(state.settings.panels.slots.primaryAnalytics.activePanelId, false);
        window.__tapeReadingPanels = {
          active: () => panelHost?.active?.id || null,
          socket: () => state.ws,
          symbol: () => state.symbol,
          debug: () => ({ ...(window.__tapePanelDebug || {}) }),
          swap: (id) => panelHost?.swap(id),
          event: (event) => panelHost?.event(event),
          injectError: () => panelHost?.active && panelHost.fail(panelHost.active.manifest, new Error('deliberate panel test error'), panelHost.active.generation)
        };
      }
      const snapshot = message.snapshot;
      const nextSymbol = snapshot.symbol || message.symbol;
      const symbolChanged = nextSymbol !== state.symbol;
      state.symbol = nextSymbol;
      // A scale from the previous ticker makes the new chart appear to ease or
      // animate into place. Start the new ticker from its own range so its
      // first rendered frame is already final.
      if (symbolChanged) {
        state.tickScale = null;
        state.minuteScale = null;
      }
      if (state.dailyHistorySymbol !== state.symbol) {
        state.dailyBars = [];
        state.dailyHistorySymbol = '';
        state.dirtyDailyChart = true;
        if (state.marketChartView === 'daily') void loadDailyHistory();
      }
      const snapshotTrades = Array.isArray(snapshot.trades) ? snapshot.trades : [];
      // A seek increments the store generation and publishes an empty replay
      // snapshot. Keep the last complete frame visible until the first batch
      // from the new position arrives, then swap atomically in the trades
      // handler. Painting this transient snapshot blanks every tape metric.
      const deferReplayReset = String(snapshot.status?.mode || '').toLowerCase() === 'replay'
        && !symbolChanged && snapshotTrades.length === 0 && state.trades.length > 0;
      if (deferReplayReset) {
        state.pendingReplayReset = true;
      } else {
        state.pendingReplayReset = false;
        state.trades = snapshotTrades;
        prepareTradeHistory();
      }
      // A replay seek clears the server store and emits an empty same-symbol
      // snapshot before delivery resumes. The replay API rebuilds the minute
      // chart through the seek position; do not let that snapshot race arrive
      // afterward and erase the loaded history.
      const preserveReplayChart = String(snapshot.status?.mode || '').toLowerCase() === 'replay'
        && !symbolChanged && state.minuteBars.length > 0;
      if (!preserveReplayChart) rebuildMinuteBars(state.trades);
      if (!deferReplayReset) {
        observeReceiptClock(state.trades);
        state.quote = snapshot.quote || {};
      }
      state.history = snapshot.history || [];
      state.status = snapshot.status || {};
      state.marketChartEnabled = state.status.mode === 'replay' || message.market_chart === true;
      state.xtraEnabled = message.xtra === true;
      state.rewindConfig = message.rewind || state.rewindConfig;
      // Live Rewind is also useful while practicing a historical replay. The
      // pane slot is reserved from startup so entering a rewind never reflows.
      const feedMode = String(state.status.mode || '').toLowerCase();
      state.rewindPaneAvailable = Boolean(state.rewindConfig?.enabled)
        && (feedMode === 'live' || feedMode === 'demo' || feedMode === 'replay')
        && (feedMode === 'replay' || message.rewind_pane === true || message.market_chart === true);
      // A snapshot means the delivered sequence is starting over: on a symbol
      // switch, a reconnect, or a server restart. Rewind history cannot be
      // assumed to continue across any of those.
      returnToLive();
      if (rewindEnabled()) {
        discardRewindBuffer();
        feedRewindBuffer(state.trades);
      } else {
        releaseRewindBuffer();
      }
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
      resetRVOLWarmup();
      const chartKey = `${state.symbol}|${state.replayConfig?.source || 'live'}|${state.replayConfig?.provider || 'all'}`;
      if (state.status.mode === 'replay' && state.replayChartKey !== chartKey) {
        state.replayChartKey = chartKey;
        queueMicrotask(() => refreshReplayRange(false));
      }
      updateQuoteText();
      panelHost?.event({ type: 'snapshot', snapshot: { symbol: state.symbol, mode: state.status?.mode || '', generation: snapshot.generation, clockUS: serverNowUS(performance.now()), quote: { ...state.quote }, trades: state.trades.slice() } });
      return;
    }
    if (message.type === 'trades' && message.symbol === state.symbol) {
      const trades = Array.isArray(message.trades) ? message.trades : [];
      if (state.pendingReplayReset && trades.length) {
        state.pendingReplayReset = false;
        state.trades = [];
        state.bars = [];
        prepareTradeHistory();
        state.tickScale = null;
        state.dirtyChart = true;
        state.dirtyTape = true;
      }
      if (message.quote) state.quote = message.quote;
      if (message.dropped) state.dropped += message.dropped;
      if (trades.length) {
        observeReceiptClock(trades);
        ingestTrades(trades);
      }
      updateQuoteText();
      panelHost?.event({ type: 'tradeBatch', symbol: state.symbol, trades, quote: message.quote || null, clockUS: serverNowUS(performance.now()) });
      return;
    }
    if (message.type === 'status') {
      if (message.status) {
        const previousMode = state.status?.mode;
        const previousState = state.status?.state;
        const pausing = message.status.mode === 'replay' && message.status.state === 'paused';
        if (pausing && state.status?.state !== 'paused') {
          state.serverClockUS = serverNowUS(performance.now());
          state.serverClockAt = performance.now();
        } else if (!pausing) {
          syncServerClock(message.server_time_ms);
        }
        state.status = message.status;
        if (message.status.mode === 'replay' && state.replay) {
          state.replay = {
            ...state.replay,
            state: message.status.state,
            message: message.status.message || state.replay.message
          };
          updateReplayControls(state.replay);
        }
        setConnection(message.status);
        ensureRVOLWarmup();
        // Status heartbeats repeat an unchanged mode several times a minute.
        // The panel lifecycle already receives the authoritative clock through
        // the animation frame, which knows to freeze a paused replay, so a
        // heartbeat must not be reported to panels as a mode change.
        if (message.status.mode !== previousMode || message.status.state !== previousState) {
          panelHost?.event({ type: 'modeChanged', mode: message.status.mode, status: { ...message.status }, clockUS: serverNowUS(performance.now()) });
        }
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
    // Read-only mirror of events that have already been delivered. The rewind
    // pane never feeds the audio worklet.
    feedRewindBuffer(trades);
    state.dirtyChart = true;
    state.dirtyReplayChart = true;
    state.dirtyDayContext = true;
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
    if (String(state.status?.mode || '').toLowerCase() === 'replay') {
      state.serverClockUS = latest;
      state.serverClockAt = performance.now();
      return;
    }
    const estimated = serverNowUS(performance.now());
    if (!estimated || latest > estimated) {
      state.serverClockUS = latest;
      state.serverClockAt = performance.now();
    }
  }

  function serverNowUS(now) {
    if (Number.isFinite(state.renderNowMS)) return state.serverClockUS;
    if (state.status?.mode === 'replay' && state.status?.state === 'paused') return state.serverClockUS;
    if (state.serverClockUS > 0) return state.serverClockUS + Math.max(0, now - state.serverClockAt) * 1000;
    return Number(state.trades[state.trades.length - 1]?.r) || 0;
  }

  function visualNowMS() {
    return Number.isFinite(state.renderNowMS) ? state.renderNowMS : performance.now();
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
    const before = state.bars.length;
    appendTickBar(state.bars, trade, tickSize);
    if (state.bars.length !== before) {
      const maxBars = Math.max(10000, (state.settings?.visibleBars || 360) * 3);
      if (state.bars.length > maxBars) state.bars.splice(0, state.bars.length - maxBars);
    }
  }

  function rebuildMinuteBars(trades) {
    state.minuteBars = [];
    for (const trade of trades) addTradeToMinuteBars(trade);
    state.dirtyReplayChart = true;
    state.dirtyDayContext = true;
  }

  function addTradeToMinuteBars(trade) {
    appendMinuteBar(state.minuteBars, trade);
  }

  function replaceReplayMinuteBars(rawBars, chartEndUS) {
    const loaded = (Array.isArray(rawBars) ? rawBars : []).map((bar) => ({
      timeUS: Number(bar.time_us), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low),
      close: Number(bar.close), volume: Number(bar.volume) || 0, dollarVolume: Number(bar.dollar_volume) || 0
    })).filter((bar) => bar.timeUS > 0 && bar.close > 0);
    state.minuteBars = loaded;
    state.replayChartEndUS = Number(chartEndUS) || 0;
    // Preserve prints that arrived while an ordinary chart-history request was
    // in flight. During a replay rewind these are prints from the old future
    // position, so merging them would leave candles visible past the new clock.
    if (!state.pendingReplayReset) {
      for (const trade of state.trades) {
        if ((Number(trade.t) * 1000 || 0) > state.replayChartEndUS) addTradeToMinuteBars(trade);
      }
    }
    state.dirtyReplayChart = true;
    state.dirtyDayContext = true;
  }

  function resetRVOLWarmup() {
    const warmup = state.rvolWarmup;
    clearTimeout(warmup.timer);
    warmup.timer = null;
    warmup.controller?.abort();
    warmup.symbol = state.symbol;
    warmup.ready = false;
    warmup.pending = false;
    warmup.attempt = 0;
    warmup.token++;
    ensureRVOLWarmup();
  }

  function ensureRVOLWarmup() {
    const warmup = state.rvolWarmup;
    if (String(state.status?.mode || '').toLowerCase() !== 'live' || warmup.ready || warmup.pending || warmup.timer || warmup.symbol !== state.symbol) return;
    void loadRVOLWarmup(warmup.token, state.symbol);
  }

  async function loadRVOLWarmup(token, symbol) {
    const warmup = state.rvolWarmup;
    if (token !== warmup.token || symbol !== state.symbol) return;
    warmup.pending = true;
    const controller = new AbortController();
    warmup.controller = controller;
    try {
      const response = await fetch(`/api/rvol-history?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      if (token !== warmup.token || symbol !== state.symbol) return;
      mergeRVOLWarmupBars(payload.bars, payload.through_us);
      warmup.ready = true;
      warmup.attempt = 0;
      clearTimeout(warmup.timer);
      warmup.timer = null;
    } catch (error) {
      if (error?.name === 'AbortError' || token !== warmup.token || symbol !== state.symbol) return;
      warmup.attempt++;
      const delay = Math.min(15000, 1000 * (2 ** Math.min(4, warmup.attempt)));
      clearTimeout(warmup.timer);
      warmup.timer = setTimeout(() => {
        warmup.timer = null;
        ensureRVOLWarmup();
      }, delay);
    } finally {
      if (token === warmup.token) {
        warmup.pending = false;
        warmup.controller = null;
      }
    }
  }

  function mergeRVOLWarmupBars(rawBars, throughUS) {
    const boundary = Number(throughUS) || 0;
    if (boundary <= 0) return;
    const merged = new Map();
    for (const raw of Array.isArray(rawBars) ? rawBars : []) {
      const bar = {
        timeUS: Number(raw.time_us), open: Number(raw.open), high: Number(raw.high), low: Number(raw.low),
        close: Number(raw.close), volume: Number(raw.volume) || 0, dollarVolume: Number(raw.dollar_volume) || 0
      };
      if (bar.timeUS > 0 && bar.timeUS < boundary && bar.close > 0) merged.set(bar.timeUS, bar);
    }
    // The IBKR bars are authoritative for completed minutes. Keep only local
    // receipt-time candles at and after the request boundary, including the
    // forming candle and anything that arrived while the request was in flight.
    for (const bar of state.minuteBars) {
      if (Number(bar.timeUS) >= boundary) merged.set(Number(bar.timeUS), bar);
    }
    const historyLimit = state.xtraEnabled ? 2200 : 2000;
    state.minuteBars = [...merged.values()].sort((left, right) => left.timeUS - right.timeUS).slice(-historyLimit);
    state.dirtyReplayChart = true;
    state.dirtyDayContext = true;
  }

  async function loadDailyHistory() {
    if (state.dailyHistoryPending || state.dailyHistorySymbol === state.symbol) return;
    state.dailyHistoryPending = true;
    elements.dailyChartEmpty.hidden = false;
    elements.dailyChartEmpty.textContent = 'LOADING 90 DAILY BARS…';
    try {
      const response = await fetch(`/api/daily-history?symbol=${encodeURIComponent(state.symbol)}`);
      if (!response.ok) throw new Error((await response.text()).trim());
      const payload = await response.json();
      if (payload.symbol !== state.symbol) return;
      state.dailyBars = (Array.isArray(payload.bars) ? payload.bars : []).map((bar) => ({
        timeUS: Number(bar.time_us), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low),
        close: Number(bar.close), volume: Number(bar.volume) || 0
      })).filter((bar) => bar.timeUS > 0 && bar.close > 0).slice(-90);
      state.dailyHistorySymbol = state.symbol;
      elements.dailyChartEmpty.textContent = state.dailyBars.length ? '' : 'NO DAILY HISTORY AVAILABLE';
      elements.dailyChartEmpty.hidden = state.dailyBars.length > 0;
      state.dirtyDailyChart = true;
    } catch (error) {
      elements.dailyChartEmpty.textContent = String(error.message || error).toUpperCase();
      elements.dailyChartEmpty.hidden = false;
    } finally {
      state.dailyHistoryPending = false;
    }
  }

  function selectMarketChart(view) {
    state.marketChartView = view === 'daily' ? 'daily' : 'minute';
    const daily = state.marketChartView === 'daily';
    elements.replayChart.hidden = daily;
    elements.dailyChart.hidden = !daily;
    elements.dayContext.hidden = daily;
    elements.replayChartEmpty.hidden = daily || state.minuteBars.length > 0;
    elements.dailyChartEmpty.hidden = !daily || state.dailyBars.length > 0;
    elements.minuteChartTab.classList.toggle('active', !daily);
    elements.dailyChartTab.classList.toggle('active', daily);
    elements.minuteChartTab.setAttribute('aria-pressed', String(!daily));
    elements.dailyChartTab.setAttribute('aria-pressed', String(daily));
    document.querySelector('.legend-vwap').hidden = daily;
    if (daily) {
      state.dirtyDailyChart = true;
      void loadDailyHistory();
    } else {
      state.dirtyReplayChart = true;
      state.dirtyDayContext = true;
    }
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

  function resizeCanvas(target) {
    const rect = target.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (target.canvas.width !== width || target.canvas.height !== height) {
      target.canvas.width = width;
      target.canvas.height = height;
      target.setDirty(true);
    }
  }

  // Exposed solely for deterministic browser validation.
  window.__tapeReadingScale = updatePriceScale;

  // One tick-chart renderer, two render targets. The live pane and the Live
  // Rewind pane pass different bars, tick sizes, scales, and panels; nothing
  // about the drawing itself is duplicated or forked.
  function drawTickChart(target) {
    resizeCanvas(target);
    const context = target.context;
    const bars = target.bars();
    const rect = target.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = target.background;
    context.fillRect(0, 0, width, height);
    const rightAxis = width < 250 ? 46 : 52;
    const left = 6;
    const right = width - rightAxis;
    const top = 7;
    const bottom = 20;
    const clockHeight = 54;
    const plotBottom = height - clockHeight;
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
    const priceBottom = plotBottom - bottom;
    target.layoutRolling(rollingTop, rollingBottom);
    if (width < 80 || height < 120 || !bars.length) {
      target.empty?.classList.toggle('hidden', bars.length > 0);
      target.setDirty(false);
      return;
    }
    target.empty?.classList.add('hidden');
    const visible = bars.slice(-target.visibleBars());
    const step = (right - left) / visible.length;

    let minimum = Infinity;
    let maximum = -Infinity;
    let maxAbsDelta = 0;
    let maxDelta = 0;
    let minDelta = 0;
    let maxDeltaDollars = 0;
    let minDeltaDollars = 0;
    for (const bar of visible) {
      minimum = Math.min(minimum, bar.low);
      maximum = Math.max(maximum, bar.high);
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(bar.delta));
      if (bar.delta > maxDelta) {
        maxDelta = bar.delta;
        maxDeltaDollars = bar.dollarDelta;
      }
      if (bar.delta < minDelta) {
        minDelta = bar.delta;
        minDeltaDollars = bar.dollarDelta;
      }
    }
    const pricePadding = Math.max((maximum - minimum) * 0.08, maximum * 0.00008, 0.005);
    minimum -= pricePadding;
    maximum += pricePadding;
    const scale = updatePriceScale(target.getScale(), minimum, maximum, visualNowMS());
    target.setScale(scale);
    minimum = scale.minimum; maximum = scale.maximum;
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
      context.fillText(formatTime(visible[index].time), xAt(index), plotBottom - 2);
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

    target.setDeltaMetrics(maxDelta, minDelta, maxDeltaDollars, minDeltaDollars);
    target.onDrawn?.(visible[visible.length - 1]);
    target.setDirty(Boolean(scale.contracting));

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

  const liveChartTarget = {
    canvas: elements.chart, context, empty: elements.chartEmpty, background: '#0c0f13',
    bars: () => state.bars,
    visibleBars: () => state.settings.visibleBars,
    getScale: () => state.tickScale,
    setScale: (value) => { state.tickScale = value; },
    setDirty: (value) => { state.dirtyChart = value; },
    layoutRolling: (top, bottom) => positionRollingPanel(elements.analyticsSlot, top, bottom),
    setDeltaMetrics: (maximum, minimum, maximumDollars, minimumDollars) => {
      elements.maxDelta.textContent = formatSigned(maximum);
      elements.minDelta.textContent = formatSigned(minimum);
      elements.maxDeltaDollars.textContent = formatSignedDollars(maximumDollars);
      elements.minDeltaDollars.textContent = formatSignedDollars(minimumDollars);
    }
  };

  function drawChart() {
    drawTickChart(liveChartTarget);
  }

  const rewindChartTarget = {
    canvas: elements.rewindCanvas,
    context: elements.rewindCanvas.getContext('2d', { alpha: false, desynchronized: true }),
    empty: null, background: '#080a0d',
    bars: () => state.rewind.bars,
    visibleBars: () => state.settings?.visibleBars || 360,
    getScale: () => state.rewind.scale,
    setScale: (value) => { state.rewind.scale = value; },
    setDirty: (value) => { state.rewind.dirty = value; },
    layoutRolling: (top, bottom) => positionRollingPanel(rewindRollingPanel, top, bottom),
    setDeltaMetrics: (maximum, minimum, maximumDollars, minimumDollars) => {
      elements.rewindMaxDelta.textContent = formatSigned(maximum);
      elements.rewindMinDelta.textContent = formatSigned(minimum);
      elements.rewindMaxDeltaDollars.textContent = formatSignedDollars(maximumDollars);
      elements.rewindMinDeltaDollars.textContent = formatSignedDollars(minimumDollars);
    }
  };

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

  function drawDayContext() {
    const canvas = elements.dayContextCanvas;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    dayContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    dayContext.fillStyle = '#090d12';
    dayContext.fillRect(0, 0, width, height);

    const latestBar = state.minuteBars[state.minuteBars.length - 1];
    if (!latestBar || width < 80 || height < 40) {
      elements.dayContext.classList.remove('above', 'below');
      elements.dayContextChange.textContent = '--';
      elements.dayContextHigh.textContent = '--';
      elements.dayContextLow.textContent = '--';
      elements.dayContextPosition.textContent = 'RANGE --';
      state.dirtyDayContext = false;
      return;
    }

    const partsFor = (bar) => Object.fromEntries(ET_MINUTE_PARTS.formatToParts(new Date(bar.timeUS / 1000)).map((part) => [part.type, part.value]));
    const latestParts = partsFor(latestBar);
    const sessionDate = `${latestParts.year}-${latestParts.month}-${latestParts.day}`;
    const bars = state.minuteBars.filter((bar) => {
      const parts = partsFor(bar);
      bar._dayMapMinute = Number(parts.hour) * 60 + Number(parts.minute);
      return `${parts.year}-${parts.month}-${parts.day}` === sessionDate && bar._dayMapMinute >= 4 * 60 && bar._dayMapMinute <= 20 * 60;
    });
    if (!bars.length) {
      state.dirtyDayContext = false;
      return;
    }

    const regular = bars.filter((bar) => bar._dayMapMinute >= 570 && bar._dayMapMinute < 960);
    const priorRegularBars = state.minuteBars.filter((bar) => {
      const parts = partsFor(bar);
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      const minute = Number(parts.hour) * 60 + Number(parts.minute);
      return date < sessionDate && minute >= 570 && minute < 960;
    });
    const usingRegularOpen = regular.length > 0;
    const reference = usingRegularOpen ? Number(regular[0].open) : Number(priorRegularBars[priorRegularBars.length - 1]?.close);
    const referenceLabel = usingRegularOpen ? '09:30 OPEN' : 'PREV CLOSE';
    const last = Number(bars[bars.length - 1].close);
    const hasReference = Number.isFinite(reference) && reference > 0;
    const high = Math.max(...bars.map((bar) => Number(bar.high)));
    const low = Math.min(...bars.map((bar) => Number(bar.low)));
    const hasExtended = bars.some((bar) => bar._dayMapMinute < 570 || bar._dayMapMinute >= 960);
    const startMinute = hasExtended ? 240 : 570;
    const endMinute = hasExtended ? 1200 : 960;
    const scaleLow = hasReference ? Math.min(low, reference) : low;
    const scaleHigh = hasReference ? Math.max(high, reference) : high;
    const pad = Math.max((scaleHigh - scaleLow) * .08, scaleHigh * .00008, .005);
    const minimum = scaleLow - pad;
    const maximum = scaleHigh + pad;
    const left = 5;
    const right = width - 5;
    const top = 5;
    const bottom = height - 13;
    const xAt = (bar) => left + (bar._dayMapMinute - startMinute) / (endMinute - startMinute) * (right - left);
    const yAt = (price) => bottom - (price - minimum) / (maximum - minimum) * (bottom - top);
    const direction = !hasReference ? 'neutral' : last > reference ? 'above' : last < reference ? 'below' : 'neutral';
    const color = direction === 'above' ? '#00bfc4' : direction === 'below' ? '#e69f00' : '#aab2bc';
    const change = hasReference ? (last - reference) / reference * 100 : null;
    const rangePosition = high > low ? (last - low) / (high - low) * 100 : 50;

    elements.dayContext.classList.toggle('above', direction === 'above');
    elements.dayContext.classList.toggle('below', direction === 'below');
    elements.dayContextSession.textContent = hasExtended ? '04:00–20:00 ET · XTD' : '09:30–16:00 ET';
    elements.dayContextChange.textContent = hasReference ? `${change > 0 ? '+' : ''}${change.toFixed(2)}% ${referenceLabel}` : '--';
    elements.dayContextHigh.textContent = formatPrice(high);
    elements.dayContextLow.textContent = formatPrice(low);
    elements.dayContextPosition.textContent = `${Math.round(rangePosition)}% OF RANGE`;
    elements.dayContext.setAttribute('aria-label', hasReference
      ? `Day map: last ${formatPrice(last)}, ${change >= 0 ? 'above' : 'below'} ${referenceLabel.toLowerCase()} by ${Math.abs(change).toFixed(2)} percent; high ${formatPrice(high)}, low ${formatPrice(low)}, at ${Math.round(rangePosition)} percent of the day range.`
      : `Day map: last ${formatPrice(last)}; previous regular-session close is unavailable; high ${formatPrice(high)}, low ${formatPrice(low)}, at ${Math.round(rangePosition)} percent of the day range.`);

    dayContext.lineWidth = 1;
    dayContext.strokeStyle = '#202832';
    for (let index = 0; index < 3; index++) {
      const y = top + (bottom - top) * index / 2;
      dayContext.beginPath(); dayContext.moveTo(left, y); dayContext.lineTo(right, y); dayContext.stroke();
    }
    if (hasExtended) {
      dayContext.fillStyle = 'rgba(141,150,162,.055)';
      dayContext.fillRect(left, top, xAt({ _dayMapMinute: 570 }) - left, bottom - top);
      dayContext.fillRect(xAt({ _dayMapMinute: 960 }), top, right - xAt({ _dayMapMinute: 960 }), bottom - top);
      dayContext.strokeStyle = '#343d48';
      for (const minute of [570, 960]) {
        const x = left + (minute - startMinute) / (endMinute - startMinute) * (right - left);
        dayContext.beginPath(); dayContext.moveTo(x, top); dayContext.lineTo(x, bottom); dayContext.stroke();
      }
    }
    dayContext.setLineDash([3, 3]);
    dayContext.strokeStyle = '#7d8792';
    dayContext.globalAlpha = .7;
    if (hasReference) {
      dayContext.beginPath(); dayContext.moveTo(left, yAt(reference)); dayContext.lineTo(right, yAt(reference)); dayContext.stroke();
    }
    dayContext.setLineDash([]);
    dayContext.globalAlpha = 1;

    dayContext.beginPath();
    bars.forEach((bar, index) => {
      const x = xAt(bar);
      const y = yAt(bar.close);
      if (index === 0) dayContext.moveTo(x, y); else dayContext.lineTo(x, y);
    });
    dayContext.strokeStyle = color;
    dayContext.lineWidth = 1.7;
    dayContext.stroke();
    const lastX = xAt(bars[bars.length - 1]);
    const lastY = yAt(last);
    dayContext.fillStyle = color;
    dayContext.beginPath(); dayContext.arc(lastX, lastY, 2.7, 0, Math.PI * 2); dayContext.fill();

    dayContext.font = '8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    dayContext.textBaseline = 'bottom';
    dayContext.fillStyle = '#77818d';
    dayContext.textAlign = 'left'; dayContext.fillText(hasExtended ? '04' : '09:30', left, height - 1);
    dayContext.textAlign = 'center'; dayContext.fillText('12', left + (720 - startMinute) / (endMinute - startMinute) * (right - left), height - 1);
    dayContext.textAlign = 'right'; dayContext.fillText(hasExtended ? '20' : '16', right, height - 1);
    state.dirtyDayContext = false;
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
    const standardRightAxis = width < 360 ? 48 : 56;
    const rightAxis = state.xtraEnabled ? (width < 500 ? 142 : 154) : standardRightAxis;
    const left = 7;
    const right = width - rightAxis;
    const top = 25;
    const axisBottom = 20;
    const paneGap = 8;
    const volumeHeight = Math.max(45, Math.min(92, (height - top - axisBottom) * 0.22));
    const volumeBottom = height - axisBottom;
    const volumeTop = volumeBottom - volumeHeight;
    const priceBottom = volumeTop - paneGap;
    elements.dayContext.style.setProperty('--day-map-bottom', `${height - priceBottom + 8}px`);
    elements.dayContext.style.setProperty('--day-map-right', `${rightAxis + 8}px`);
    const rightGapBars = Math.max(5, Math.min(100, Math.round(Number(state.replayConfig?.chart_right_gap_bars) || 5)));
    // Keep the same candle count with or without xtra. The wider xtra axis
    // compresses candle spacing but must not silently remove market context.
    const capacityRight = width - standardRightAxis;
    const capacity = Math.max(24, Math.min(180, Math.floor((capacityRight - left) / (width < 500 ? 5 : 7)) - rightGapBars));
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
    state.minuteScale = updatePriceScale(state.minuteScale, minimum, maximum, visualNowMS());
    minimum = state.minuteScale.minimum; maximum = state.minuteScale.maximum;
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

    let xtraLevels = [];
    if (state.xtraEnabled) {
      const candleMinimum = Math.min(...visible.map((bar) => bar.low));
      const candleMaximum = Math.max(...visible.map((bar) => bar.high));
      xtraLevels = calculateXtraLevels(state.minuteBars).filter((level) => level.price >= candleMinimum && level.price <= candleMaximum);
      drawXtraLevels(xtraLevels, priceY, left, right, rightAxis, top, priceBottom);
    }

    replayContext.strokeStyle = '#3a424c';
    replayContext.beginPath(); replayContext.moveTo(left, volumeTop); replayContext.lineTo(width, volumeTop); replayContext.stroke();
    const volumeUsable = volumeHeight - 15;
    visible.forEach((bar, index) => {
      const heightValue = maxVolume ? bar.volume / maxVolume * volumeUsable : 0;
      replayContext.fillStyle = bar.close >= bar.open ? 'rgba(52,199,217,.68)' : 'rgba(255,77,94,.68)';
      replayContext.fillRect(xAt(index) - bodyWidth / 2, volumeBottom - heightValue, bodyWidth, heightValue);
    });

    const last = visible[visible.length - 1];
    const currentVolume = formatCandleVolume(last.volume);
    const dayVolume = formatCandleVolume(volumeSinceFourAM(state.minuteBars));
    replayContext.textAlign = 'left';
    replayContext.textBaseline = 'top';
    replayContext.font = '800 24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const currentVolumeWidth = replayContext.measureText(currentVolume).width;
    const dayVolumeWidth = replayContext.measureText(dayVolume).width;
    const dayVolumeLeft = left + currentVolumeWidth + 20;
    // A narrow pane with a wide current candle leaves no room beside it. Drop
    // the day total rather than run it under the price axis.
    const showDayVolume = dayVolumeLeft + dayVolumeWidth <= right;
    replayContext.fillStyle = 'rgba(12,15,19,.88)';
    replayContext.fillRect(left, volumeTop + 14,
      showDayVolume ? currentVolumeWidth + dayVolumeWidth + 30 : currentVolumeWidth + 8, 29);
    replayContext.fillStyle = '#f2f5f7';
    replayContext.fillText(currentVolume, left + 2, volumeTop + 13);
    if (showDayVolume) {
      replayContext.fillStyle = '#34c7d9';
      replayContext.fillText(dayVolume, dayVolumeLeft, volumeTop + 13);
    }
    replayContext.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    replayContext.fillStyle = '#8d96a2';
    replayContext.fillText('VOLUME', left + 2, volumeTop + 3);
    replayContext.fillText(formatSize(maxVolume), right + 5, volumeTop + 7);
    if (showDayVolume) {
      const dayVolumeLabel = ['DAY VOL · 04:00 ET', 'DAY VOL 04:00', 'DAY VOL']
        .find((text) => dayVolumeLeft + replayContext.measureText(text).width <= right);
      replayContext.fillStyle = '#34c7d9';
      replayContext.fillText(dayVolumeLabel || '', dayVolumeLeft, volumeTop + 3);
    }

    const labelIndexes = visible.length < 3 ? [0] : [0, Math.floor((visible.length - 1) / 2), visible.length - 1];
    replayContext.fillStyle = '#78818c';
    replayContext.textBaseline = 'bottom';
    labelIndexes.forEach((index, labelIndex) => {
      replayContext.textAlign = labelIndex === 0 ? 'left' : labelIndex === labelIndexes.length - 1 ? 'right' : 'center';
      replayContext.fillText(formatTime(visible[index].timeUS / 1000).slice(0, 5), xAt(index), height - 2);
    });

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
    drawCurrentXtraBadges(xtraLevels, priceY, last.close, right, rightAxis, currentY);
    state.dirtyReplayChart = Boolean(state.minuteScale.contracting);

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

  function calculateXtraLevels(bars, quotedPreviousClose = Number(state.quote.previous_close), useDemo = String(state.status?.mode || '').toLowerCase() === 'demo') {
    if (!Array.isArray(bars) || !bars.length) return [];
    if (useDemo) return calculateDemoXtraLevels(bars);
    const sessions = new Map();
    for (const bar of bars) {
      const parts = easternMinuteParts(bar.timeUS);
      if (!parts || !Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) continue;
      const session = sessions.get(parts.day) || { premarket: [], regular: [] };
      if (parts.minute >= 240 && parts.minute < 570) session.premarket.push(bar);
      if (parts.minute >= 570 && parts.minute < 960) session.regular.push(bar);
      sessions.set(parts.day, session);
    }
    const days = [...sessions.keys()].sort();
    if (!days.length) return [];
    const currentDay = easternMinuteParts(bars[bars.length - 1].timeUS)?.day;
    const current = sessions.get(currentDay);
    const priorDay = days.filter((day) => day < currentDay && sessions.get(day).regular.length).at(-1);
    const prior = priorDay ? sessions.get(priorDay).regular : [];
    const previousClose = Number(quotedPreviousClose) > 0 ? Number(quotedPreviousClose) : prior.at(-1)?.close;
    const definitions = [
      { key: 'PDC', price: previousClose, color: '#E69F00', dash: [7, 3] },
      { key: 'PDH', price: prior.length ? Math.max(...prior.map((bar) => bar.high)) : NaN, color: '#56B4E9', dash: [2, 3] },
      { key: 'PMH', price: current?.premarket.length ? Math.max(...current.premarket.map((bar) => bar.high)) : NaN, color: '#009E73', dash: [9, 3, 2, 3] },
      { key: 'OPEN', price: current?.regular[0]?.open, color: '#F0E442', dash: [1, 3] },
      { key: 'RTHH', price: current?.regular.length ? Math.max(...current.regular.map((bar) => bar.high)) : NaN, color: '#00E5FF', dash: [12, 3, 3, 3] },
      { key: 'PDL', price: prior.length ? Math.min(...prior.map((bar) => bar.low)) : NaN, color: '#D55E00', dash: [4, 3] },
      { key: 'RTHL', price: current?.regular.length ? Math.min(...current.regular.map((bar) => bar.low)) : NaN, color: '#FF6B6B', dash: [6, 2, 1, 2] },
      { key: 'PML', price: current?.premarket.length ? Math.min(...current.premarket.map((bar) => bar.low)) : NaN, color: '#CC79A7', dash: [10, 3] }
    ];
    return definitions.filter((level) => Number.isFinite(level.price) && level.price > 0);
  }

  function calculateDemoXtraLevels(bars) {
    const minimum = Math.min(...bars.map((bar) => Number(bar.low)).filter(Number.isFinite));
    const maximum = Math.max(...bars.map((bar) => Number(bar.high)).filter(Number.isFinite));
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return [];
    const at = (fraction) => minimum + (maximum - minimum) * fraction;
    return [
      { key: 'PDC', price: at(0.48), color: '#E69F00', dash: [7, 3] },
      { key: 'PDH', price: at(0.92), color: '#56B4E9', dash: [2, 3] },
      { key: 'PMH', price: at(0.68), color: '#009E73', dash: [9, 3, 2, 3] },
      { key: 'OPEN', price: at(0.56), color: '#F0E442', dash: [1, 3] },
      { key: 'RTHH', price: at(0.80), color: '#00E5FF', dash: [12, 3, 3, 3] },
      { key: 'PDL', price: at(0.08), color: '#D55E00', dash: [4, 3] },
      { key: 'RTHL', price: at(0.20), color: '#FF6B6B', dash: [6, 2, 1, 2] },
      { key: 'PML', price: at(0.32), color: '#CC79A7', dash: [10, 3] }
    ];
  }

  function easternMinuteParts(timeUS) {
    const values = {};
    for (const part of ET_MINUTE_PARTS.formatToParts(new Date(Number(timeUS) / 1000))) {
      if (part.type !== 'literal') values[part.type] = part.value;
    }
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (!values.year || !values.month || !values.day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day: `${values.year}-${values.month}-${values.day}`, minute: hour * 60 + minute };
  }

  function drawXtraLevels(levels, priceY, left, right, rightAxis, top, bottom) {
    if (!levels.length) return;
    const placed = levels.map((level) => ({ ...level, lineY: priceY(level.price), labelY: priceY(level.price) })).sort((a, b) => a.labelY - b.labelY);
    const gap = 23;
    for (let index = 1; index < placed.length; index++) placed[index].labelY = Math.max(placed[index].labelY, placed[index - 1].labelY + gap);
    const overflow = placed.at(-1).labelY - (bottom - 11);
    if (overflow > 0) for (const level of placed) level.labelY -= overflow;
    for (let index = placed.length - 2; index >= 0; index--) placed[index].labelY = Math.min(placed[index].labelY, placed[index + 1].labelY - gap);
    const underflow = top + 11 - placed[0].labelY;
    if (underflow > 0) for (const level of placed) level.labelY += underflow;

    replayContext.save();
    replayContext.font = '700 18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    replayContext.textAlign = 'left';
    replayContext.textBaseline = 'middle';
    for (const level of placed) {
      replayContext.strokeStyle = level.color;
      replayContext.lineWidth = 1;
      replayContext.globalAlpha = 0.58;
      replayContext.setLineDash(level.dash);
      replayContext.beginPath();
      replayContext.moveTo(left, level.lineY);
      replayContext.lineTo(right, level.lineY);
      replayContext.stroke();
      replayContext.setLineDash([]);
      replayContext.globalAlpha = 0.9;
      replayContext.beginPath();
      replayContext.moveTo(right, level.lineY);
      replayContext.lineTo(right + 4, level.labelY);
      replayContext.stroke();
      replayContext.fillStyle = 'rgba(12,15,19,.92)';
      replayContext.fillRect(right + 4, level.labelY - 11, rightAxis - 4, 22);
      replayContext.fillStyle = level.color;
      replayContext.globalAlpha = 1;
      replayContext.fillText(`${level.key} ${formatPrice(level.price)}`, right + 6, level.labelY);
    }
    replayContext.restore();
  }

  function drawCurrentXtraBadges(levels, priceY, currentPrice, right, rightAxis, currentY) {
    // A current-price marker covers labels within its 18px height. Repeat the
    // level key beside the price so recognition does not depend on remembering
    // which colored/dashed line was there before the collision.
    const active = levels.filter((level) => Math.abs(priceY(level.price) - currentY) <= 10);
    if (!active.length) return;

    replayContext.save();
    replayContext.font = '800 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    replayContext.textAlign = 'left';
    replayContext.textBaseline = 'middle';
    let x = right + 8 + replayContext.measureText(formatPrice(currentPrice)).width;
    const limit = right + rightAxis - 3;
    for (const level of active) {
      const width = replayContext.measureText(level.key).width + 8;
      if (x + width > limit) break;
      replayContext.fillStyle = level.color;
      replayContext.fillRect(x, currentY - 7, width, 14);
      replayContext.fillStyle = '#090b0e';
      replayContext.fillText(level.key, x + 4, currentY);
      x += width + 3;
    }
    replayContext.restore();
  }

  // Exposed solely for deterministic browser validation.
  window.__tapeReadingXtraLevels = calculateXtraLevels;
  window.__tapeReadingExternalBadge = externalBadge;

  function drawDailyChart() {
    const canvas = elements.dailyChart;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    dailyContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    dailyContext.fillStyle = '#0c0f13';
    dailyContext.fillRect(0, 0, width, height);
    const bars = state.dailyBars.slice(-90);
    if (width < 160 || height < 150 || !bars.length) {
      state.dirtyDailyChart = false;
      return;
    }
    elements.dailyChartEmpty.hidden = true;
    const indicators = calculateDailyIndicators(bars);
    const axisWidth = width < 360 ? 48 : 56;
    const left = 7;
    const right = width - axisWidth;
    const top = 55;
    const bottom = height - 22;
    const step = (right - left) / bars.length;
    const xAt = (index) => left + (index + .5) * step;
    let minimum = Infinity;
    let maximum = -Infinity;
    bars.forEach((bar, index) => {
      minimum = Math.min(minimum, bar.low);
      maximum = Math.max(maximum, bar.high);
      for (const value of [indicators[index].sma9, indicators[index].sma20, indicators[index].upper, indicators[index].lower]) {
        if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
      }
    });
    const padding = Math.max((maximum - minimum) * .06, maximum * .0001, .01);
    minimum -= padding; maximum += padding;
    const yAt = (value) => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
    dailyContext.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    dailyContext.textBaseline = 'middle';
    for (let index = 0; index <= 4; index++) {
      const y = top + (bottom - top) * index / 4;
      dailyContext.strokeStyle = '#252b33';
      dailyContext.lineWidth = 1;
      dailyContext.beginPath(); dailyContext.moveTo(left, y); dailyContext.lineTo(right, y); dailyContext.stroke();
      dailyContext.fillStyle = '#8d96a2'; dailyContext.textAlign = 'left';
      dailyContext.fillText(formatAxisPrice(maximum - (maximum - minimum) * index / 4), right + 5, y);
    }
    const bodyWidth = Math.max(1, Math.min(6, step * .62));
    bars.forEach((bar, index) => {
      const x = xAt(index);
      const up = bar.close >= bar.open;
      const color = up ? '#34c7d9' : '#ff4d5e';
      dailyContext.strokeStyle = color; dailyContext.fillStyle = color;
      dailyContext.beginPath(); dailyContext.moveTo(x, yAt(bar.high)); dailyContext.lineTo(x, yAt(bar.low)); dailyContext.stroke();
      const bodyTop = Math.min(yAt(bar.open), yAt(bar.close));
      const bodyHeight = Math.max(1, Math.abs(yAt(bar.open) - yAt(bar.close)));
      if (up) {
        dailyContext.globalAlpha = .3; dailyContext.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight); dailyContext.globalAlpha = 1;
        dailyContext.strokeRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
      } else dailyContext.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
    });
    drawLine('lower', '#f2f5f7', 1, .72);
    drawLine('upper', '#f2f5f7', 1, .72);
    drawLine('sma20', '#56c7ff', 1.6, 1);
    drawLine('sma9', '#ff4d5e', 2.1, 1);
    const labelIndexes = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
    dailyContext.fillStyle = '#78818c'; dailyContext.textBaseline = 'bottom';
    labelIndexes.forEach((index, position) => {
      dailyContext.textAlign = position === 0 ? 'left' : position === 2 ? 'right' : 'center';
      dailyContext.fillText(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(new Date(bars[index].timeUS / 1000)), xAt(index), height - 3);
    });
    const last = bars[bars.length - 1];
    const lastY = yAt(last.close);
    dailyContext.setLineDash([2, 3]); dailyContext.strokeStyle = '#d8dde2'; dailyContext.globalAlpha = .65;
    dailyContext.beginPath(); dailyContext.moveTo(left, lastY); dailyContext.lineTo(right, lastY); dailyContext.stroke();
    dailyContext.setLineDash([]); dailyContext.globalAlpha = 1;
    dailyContext.fillStyle = '#d8dde2'; dailyContext.fillRect(right, lastY - 9, axisWidth, 18);
    dailyContext.fillStyle = '#090b0e'; dailyContext.textAlign = 'left'; dailyContext.textBaseline = 'middle';
    dailyContext.fillText(formatPrice(last.close), right + 4, lastY);
    state.dirtyDailyChart = false;

    function drawLine(key, color, lineWidth, alpha) {
      dailyContext.beginPath(); let drawing = false;
      indicators.forEach((values, index) => {
        const value = values[key];
        if (!Number.isFinite(value)) { drawing = false; return; }
        if (drawing) dailyContext.lineTo(xAt(index), yAt(value)); else dailyContext.moveTo(xAt(index), yAt(value));
        drawing = true;
      });
      dailyContext.strokeStyle = color; dailyContext.lineWidth = lineWidth; dailyContext.globalAlpha = alpha; dailyContext.stroke(); dailyContext.globalAlpha = 1;
    }
  }

  function calculateDailyIndicators(bars) {
    let sum9 = 0; let sum20 = 0; let squares20 = 0;
    return bars.map((bar, index) => {
      sum9 += bar.close; sum20 += bar.close; squares20 += bar.close * bar.close;
      if (index >= 9) sum9 -= bars[index - 9].close;
      if (index >= 20) { sum20 -= bars[index - 20].close; squares20 -= bars[index - 20].close ** 2; }
      const sma9 = index >= 8 ? sum9 / 9 : null;
      const sma20 = index >= 19 ? sum20 / 20 : null;
      const deviation = sma20 === null ? 0 : Math.sqrt(Math.max(0, squares20 / 20 - sma20 * sma20));
      return { sma9, sma20, upper: sma20 === null ? null : sma20 + deviation * 2, lower: sma20 === null ? null : sma20 - deviation * 2 };
    });
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

  function positionRollingPanel(panel, top, bottom) {
    panel.style.top = `${Math.max(0, top)}px`;
    panel.style.height = `${Math.max(0, bottom - top)}px`;
  }

  function setConnection(status) {
    const connected = Boolean(status && status.connected);
    const stateName = String(status?.state || 'waiting').toUpperCase();
    const className = connected ? 'connection-state live' : /ERROR|DEGRADED/.test(stateName) ? 'connection-state error' : 'connection-state';
    elements.connectionState.className = className;
    elements.connectionState.querySelector('span').textContent = stateName;
    elements.connectionState.title = status?.message || stateName;
    const replayMode = status?.mode === 'replay';
    const relativeVolumeMode = ['live', 'massive', 'demo', 'replay'].includes(String(status?.mode || '').toLowerCase());
    elements.replayButton.hidden = !replayMode;
    elements.replayPlayButton.hidden = !replayMode;
    elements.replayPauseButton.hidden = !replayMode;
    elements.relativeVolume.hidden = !relativeVolumeMode;
    // The rewind pane lives in this slot, so the slot is present for the whole
    // session rather than appearing when a rewind starts.
    elements.replayMarketPanel.hidden = !paneSlotReserved();
    elements.replayMarketPanel.setAttribute('aria-label', `${replayMode ? 'Replay' : 'Live'} one-minute price and volume chart`);
    elements.replayChartEmpty.textContent = replayMode ? 'START REPLAY TO BUILD THE CHART' : 'WAITING FOR LIVE MINUTE BARS';
    // After the chart's own empty state, so a rewind-only slot keeps its hint.
    applyRewindSlot();
    applyWorkspaceClasses();
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
    // Never leave the trader looking at another symbol's past.
    returnToLive('symbol change');
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

  // True whenever the pane beside the tape tool is present: for replay, for the
  // live market chart, or because Live Rewind reserved it at startup.
  function paneSlotReserved() {
    return state.status?.mode === 'replay' || state.marketChartEnabled || state.rewindPaneAvailable;
  }

  // Every workspace class is toggled here rather than rebuilt from scratch, so no
  // caller can silently drop one. Rebuilding the list is what previously
  // collapsed the reserved rewind pane on any settings change.
  function applyWorkspaceClasses() {
    const replayMode = state.status?.mode === 'replay';
    const showChart = state.settings ? state.settings.showChart : true;
    const showTape = state.settings ? state.settings.showTape : true;
    const workspace = elements.workspace;
    workspace.classList.toggle('replay-mode', replayMode);
    workspace.classList.toggle('market-chart-mode', paneSlotReserved());
    workspace.classList.toggle('both-hidden', !showChart && !showTape);
    workspace.classList.toggle('chart-hidden', !showChart && showTape);
    workspace.classList.toggle('tape-hidden', showChart && !showTape);
  }

  function applyLayout() {
    if (!state.settings) return;
    const { showSize } = state.settings;
    applyWorkspaceClasses();
    elements.replayMarketPanel.hidden = !paneSlotReserved();
    applyRewindSlot();
    elements.tapePanel.classList.toggle('hide-size', !showSize);
    ensureTapePool();
    state.dirtyChart = true;
    state.dirtyReplayChart = true;
    state.dirtyDayContext = true;
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
    const moveDayMap = () => {
      elements.dayContext.classList.remove(...DAY_MAP_CORNERS.filter(Boolean));
      state.dayMapCorner = (state.dayMapCorner + 1) % DAY_MAP_CORNERS.length;
      const cornerClass = DAY_MAP_CORNERS[state.dayMapCorner];
      if (cornerClass) elements.dayContext.classList.add(cornerClass);
      elements.dayContext.dataset.corner = DAY_MAP_CORNER_NAMES[state.dayMapCorner];
    };
    elements.dayContext.addEventListener('click', moveDayMap);
    elements.dayContext.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      moveDayMap();
    });
    elements.minuteChartTab.addEventListener('click', () => selectMarketChart('minute'));
    elements.dailyChartTab.addEventListener('click', () => selectMarketChart('daily'));
    elements.tickerForm.addEventListener('submit', (event) => {
      event.preventDefault();
      switchSymbol(elements.tickerInput.value, true);
      elements.tickerInput.select();
    });
    elements.tickerInput.addEventListener('focus', () => elements.tickerInput.select());
    elements.externalReplayBadge.addEventListener('click', async () => {
      // Ordinary replay transport is intentionally a manual action and the
      // server detaches ownership before applying it.
      await replayAction({ action: 'pause' }).catch(() => {});
      await refreshExternalReplayStatus();
    });
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
        postUIEvent('tick_size', state.settings.tickSize);
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
    elements.replayPlayButton.addEventListener('click', async () => {
      await replayAction({ action: 'resume' });
    });
    elements.replayPauseButton.addEventListener('click', async () => {
      await replayAction({ action: 'pause' });
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
      if (panelHost) {
        panelHost.settings = state.settings.panels;
        panelHost.swap('tape-pressure');
      }
    });

    elements.customTicks.addEventListener('change', () => {
      state.settings.customTicks = clampInt(elements.customTicks.value, 1, 100000, 1);
      state.settings.tickSize = state.settings.customTicks;
      elements.tickSelect.value = ['1', '10', '100', '1000'].includes(String(state.settings.tickSize)) ? String(state.settings.tickSize) : 'custom';
      commitSettings(true);
      postUIEvent('tick_size', state.settings.tickSize);
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
    elements.rewindTicks.addEventListener('change', () => {
      // The rewind pane's granularity is independent of live: re-aggregating the
      // same seconds more finely is the point of the feature.
      state.rewind.tickSize = clampInt(elements.rewindTicks.value, 1, 100000, 1);
      state.rewind.scale = null;
      state.rewind.dirty = true;
      markRewindInteraction();
    });
    elements.rewindSpeed.addEventListener('change', () => {
      state.rewind.speed = clampNumber(elements.rewindSpeed.value, 0.25, 2, 1);
      markRewindInteraction();
    });
    elements.rewindPlay.addEventListener('click', toggleRewindPlayback);
    elements.rewindStepBack.addEventListener('click', () => stepRewind(-1));
    elements.rewindStepForward.addEventListener('click', () => stepRewind(1));
    elements.rewindExit.addEventListener('click', () => returnToLive('exit'));
    elements.rewindPanel.addEventListener('pointerdown', markRewindInteraction);

    document.addEventListener('keydown', (event) => {
      const editing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
      if (event.key === '/' && !editing) {
        event.preventDefault();
        elements.tickerInput.focus();
        return;
      }
      // Every shortcut stays inert while an input or select has focus.
      if (editing || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') {
        if (state.rewind.active) {
          event.preventDefault();
          // Once the trader has deliberately paused, only the visible LIVE
          // control dismisses the pane. This prevents an incidental shortcut
          // from discarding the held replay position.
          if (!state.rewind.holdForLiveClick) returnToLive('escape');
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        if (!rewindEnabled()) return;
        event.preventDefault();
        const depth = event.ctrlKey ? REWIND_DEPTHS.ctrl : event.shiftKey ? REWIND_DEPTHS.shift : REWIND_DEPTHS.plain;
        void enterRewind(depth);
        return;
      }
      if (!state.rewind.active) return;
      if (event.key === ' ') {
        event.preventDefault();
        toggleRewindPlayback();
        return;
      }
      if (event.key === ',' || event.key === '.') {
        event.preventDefault();
        stepRewind(event.key === ',' ? -1 : 1);
      }
    });
  }

  // externalBadge is pure so the badge contract can be checked without a
  // controller attached. The tape may never look current while fast-follow
  // suppression is on, and an audio-locked session may never read as FOLLOWING.
  // The badge is a compact toolbar chip, so it carries the market clock alone.
  // The replay range picker keeps its own dated format.
  function formatExternalClock(value) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(Number(value) / 1000));
  }

  function externalBadge(control, audioReady, audioEnabled, fallbackSymbol) {
    const state = String(control?.state || '').toLowerCase();
    const attached = Boolean(control?.attached);
    // A controller whose first cue is rejected never attaches. Those states still
    // have to reach the operator, or a refused cue looks like nothing happened.
    const reportedWhileUnattached = ['detached', 'data_incomplete', 'error', 'cueing'];
    if (!attached && !reportedWhileUnattached.includes(state)) {
      return { visible: false, label: '', text: '', suppressed: false };
    }
    if (!attached && state === 'detached') {
      return { visible: true, label: 'DETACHED', text: 'EXTERNAL REPLAY · DETACHED', suppressed: false };
    }
    const fast = Boolean(control?.fast_follow);
    let label = state.replaceAll('_', ' ').toUpperCase();
    if (control?.error && state === 'error') label = `ERROR · ${String(control.error).toUpperCase()}`;
    else if (!fast && audioEnabled && !audioReady && (state === 'following' || state === 'paused')) label = 'AUDIO LOCKED';
    const at = Number(control?.target_us) > 0 ? formatExternalClock(Number(control.target_us)) : '--:--:--';
    const symbol = control?.symbol || fallbackSymbol || '';
    return {
      visible: true, label, suppressed: fast,
      text: `EXTERNAL REPLAY · ${symbol} · ${at} · ${label}`
    };
  }

  async function refreshExternalReplayStatus() {
    try {
      const response = await fetch('/api/external-replay/status', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      const control = payload.control || {};
      const audioEnabled = state.settings?.audio?.enabled !== false;
      const badge = externalBadge(control, audio.ready, audioEnabled, state.symbol);
      elements.externalReplayBadge.hidden = !badge.visible;
      elements.tapePanel.classList.toggle('fast-follow', badge.suppressed);
      elements.externalReplayBadge.classList.toggle('fast', badge.suppressed);
      elements.externalReplayBadge.classList.toggle('locked', badge.label === 'AUDIO LOCKED');
      elements.externalReplayBadge.classList.toggle('alert', badge.label.startsWith('ERROR') || badge.label === 'DATA INCOMPLETE');
      const targetUS = Number(control.target_us) || 0;
      if (control.attached && targetUS && targetUS !== state.externalTargetUS) {
        state.externalTargetUS = targetUS;
        refreshReplayRange(false).catch(() => {});
      }
      if (badge.visible) elements.externalReplayBadge.textContent = badge.text;
      reportAudioReadiness(Boolean(payload.enabled));
    } catch (_) {}
  }

  // A controller cannot see whether this tab has unlocked Web Audio, so the tab
  // says so itself. Only the newest report is kept server side.
  function reportAudioReadiness(enabled) {
    if (!enabled) return;
    const ready = Boolean(audio.ready && audio.enabled);
    if (ready === state.reportedAudioReady && state.reportedAudioAt && Date.now() - state.reportedAudioAt < 3000) return;
    state.reportedAudioReady = ready;
    state.reportedAudioAt = Date.now();
    fetch('/api/external-replay/ui', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_ready: ready })
    }).catch(() => {});
  }

  // Fire and forget: a display change is recorded on the receipt timeline so a
  // later rewind or replay can restore the view the trader was looking at.
  function postUIEvent(kind, value) {
    if (!['live'].includes(String(state.status?.mode || '').toLowerCase())) return;
    void fetch('/api/ui-event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, symbol: state.symbol, value: Number(value) || 0 })
    }).catch(() => {});
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
      await refreshExternalReplayStatus();
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
    elements.replayPlayButton.disabled = !paused;
    elements.replayPauseButton.disabled = replay.state !== 'replaying';
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
    const bidSize = state.quote.bid_size >= 0 && state.quote.bid > 0 ? formatSize(state.quote.bid_size) : '--';
    const askSize = state.quote.ask_size >= 0 && state.quote.ask > 0 ? formatSize(state.quote.ask_size) : '--';
    elements.bestBid.textContent = bid;
    elements.bestAsk.textContent = ask;
    elements.bestBidSize.textContent = `× ${bidSize}`;
    elements.bestAskSize.textContent = `× ${askSize}`;
    const hasSpread = state.quote.ask > 0 && state.quote.bid > 0 && state.quote.ask >= state.quote.bid;
    const spread = hasSpread ? state.quote.ask - state.quote.bid : 0;
    const spreadCents = spread * 100;
    elements.nbboSpread.textContent = hasSpread ? `${spreadCents.toFixed(1).replace(/\.0$/, '')}¢` : '--';
    elements.nbboSpreadDollars.textContent = hasSpread ? `$${formatPrice(spread)}` : '--';
    elements.nbbo.title = hasSpread ? `IBKR SMART NBBO spread ${formatPrice(spread)}` : 'IBKR SMART national best bid and offer';
    elements.nbbo.setAttribute('aria-label', `IBKR best bid ${bid}, size ${bidSize}; best ask ${ask}, size ${askSize}${hasSpread ? `; spread ${formatPrice(spread)}` : ''}`);
    elements.quoteText.textContent = `BID ${bid} / ASK ${ask}`;
  }

  function updateRelativeVolume(nowUS) {
    const metric = calculateCandleRVOL(state.minuteBars, nowUS);
    elements.relativeVolume.classList.remove('building', 'quiet', 'normal', 'elevated', 'surge');
    if (!metric) {
      elements.relativeVolume.classList.add('building');
      elements.relativeVolumeValue.textContent = '--';
      elements.relativeVolumeState.textContent = 'BUILDING';
      elements.relativeVolume.style.setProperty('--rvol-width', '0%');
      elements.relativeVolume.setAttribute('aria-label', 'Relative volume pace is building its recent-candle baseline.');
      return;
    }

    const level = metric.ratio < 0.75 ? 'quiet' : metric.ratio < 1.25 ? 'normal' : metric.ratio < 2 ? 'elevated' : 'surge';
    elements.relativeVolume.classList.add(level);
    elements.relativeVolumeValue.textContent = `${metric.ratio < 10 ? metric.ratio.toFixed(1) : Math.round(metric.ratio)}×`;
    elements.relativeVolumeState.textContent = level.toUpperCase();
    elements.relativeVolume.style.setProperty('--rvol-width', `${Math.min(100, metric.ratio / 3 * 100)}%`);
    const timing = metric.forming ? `${Math.round(metric.elapsedSeconds)} seconds into the candle` : 'completed candle';
    elements.relativeVolume.setAttribute('aria-label', `Relative volume pace ${metric.ratio.toFixed(2)} times, ${level}; ${timing}; compared with the median volume of ${metric.baselineBars} recent completed candles.`);
  }

  function updateLiveMetrics(now) {
    const receiptNowUS = serverNowUS(now);
    const tapeRate = computeTapeRate(liveSource, receiptNowUS);
    elements.tapeRate.textContent = `${tapeRate >= 1000 ? formatSize(tapeRate) : tapeRate}/s`;
    audio.setTapeRate(tapeRate);
    panelHost?.render(receiptNowUS);
    const last = state.trades[state.trades.length - 1];
    elements.lastPrice.textContent = last ? formatPrice(last.p) : '--';
    updatePriceChange(last?.p, state.quote.previous_close);
    elements.streamText.textContent = `${formatSize(state.trades.length)} PRINTS${state.dropped ? ` / ${formatSize(state.dropped)} LAGGED` : ''}`;
    const replayMode = state.status?.mode === 'replay';
    const relativeVolumeMode = ['live', 'massive', 'demo', 'replay'].includes(String(state.status?.mode || '').toLowerCase());
    const replayState = String(state.replay?.state || state.status?.state || '').toLowerCase();
    const replayHasTimeline = replayMode && receiptNowUS && replayState !== 'ready' && replayState !== 'stopped';
    if (relativeVolumeMode) updateRelativeVolume(replayMode ? (replayHasTimeline ? receiptNowUS : 0) : receiptNowUS);
    const clockDate = replayHasTimeline ? new Date(receiptNowUS / 1000) : new Date();
    const clockValue = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(clockDate);
    const displayedClock = replayMode ? (replayHasTimeline ? clockValue : '--:--:--') : clockValue;
    elements.marketClockLabel.textContent = replayMode ? 'REPLAY TIME' : 'MARKET TIME';
    elements.marketClockTime.textContent = displayedClock;
    elements.marketClock.setAttribute('aria-label', `${replayMode ? 'Replay' : 'New York market'} time ${displayedClock} Eastern Time`);
  }

  // ------------------------------------------------------------- Live Rewind
  //
  // Chase play: reading behind the write head while the write continues. The
  // live tape, its rolling horizons, RVOL, the audio worklet, the SQLite
  // recorder, and the IBKR subscription are all untouched while this runs.
  //
  // The rewind pane emits no audio at all, deliberately. The AudioWorklet is a
  // live-state signal: mixing replayed prints into it during a spike would
  // corrupt the trader's real-time read of the market. The intended ergonomic is
  // ears live, eyes rewound.

  const REWIND_DEPTHS = { plain: 5, shift: 15, ctrl: 30 };
  const REWIND_AUTO_SPEED = 0.25;

  function rewindEnabled() {
    return Boolean(state.rewindConfig?.enabled) && state.rewindPaneAvailable;
  }

  // Nothing is reserved until the pane exists to show it. Without this gate a
  // plain live session with no rewind pane still reserved the whole buffer and
  // mirrored every print for a feature the trader cannot reach.
  function ensureRewindBuffer() {
    if (state.rewind.buffer || !rewindEnabled()) return state.rewind.buffer;
    state.rewind.buffer = new RewindBuffer({
      bufferSeconds: Number(state.rewindConfig.buffer_seconds) || 180,
      maxPrintsPerSecond: Number(state.rewindConfig.max_prints_per_second) || 2000
    });
    state.rewind.source = createRewindSource(state.rewind.buffer, {
      symbol: () => state.symbol,
      fetchRange: async (symbol, fromSeq, toSeq) => {
        const query = new URLSearchParams({ symbol, seq_from: String(fromSeq), seq_to: String(toSeq) });
        const response = await fetch(`/api/tape/range?${query}`);
        if (!response.ok) throw new Error((await response.text()).trim());
        return response.json();
      }
    });
    return state.rewind.buffer;
  }

  // Called from the delivery path. One bounded write per print, no allocation,
  // and no interaction with the live history the tape renders from.
  function feedRewindBuffer(trades) {
    const buffer = ensureRewindBuffer();
    if (!buffer) return;
    for (const trade of trades) buffer.push(trade);
  }

  // Drops the retained events but keeps the columns, for a symbol switch or a
  // reconnect where rewind stays available.
  function discardRewindBuffer() {
    state.rewind.buffer?.reset();
    state.rewind.notice = '';
  }

  // Releases the columns themselves when rewind is not available at all.
  function releaseRewindBuffer() {
    state.rewind.pressurePanel?.unmount?.();
    state.rewind.pressurePanel = null;
    state.rewind.pressureSource = null;
    state.rewind.buffer = null;
    state.rewind.source = null;
    state.rewind.bars = [];
    state.rewind.notice = '';
  }

  async function enterRewind(seconds) {
    if (!rewindEnabled()) return;
    const buffer = ensureRewindBuffer();
    if (!buffer || buffer.count === 0) return;
    const rewind = state.rewind;
    // Capture a fixed segment endpoint. At 0.25x a player chasing the moving
    // live head can never catch it; a five-second segment must instead replay
    // the five seconds that existed when the shortcut was pressed, then jump to
    // the current live view.
    const fromUS = rewind.active && rewind.targetUS ? rewind.targetUS : buffer.lastReceivedUS();
    const targetUS = Math.max(buffer.firstReceivedUS(), fromUS - seconds * 1e6);
    if (!rewind.active) {
      rewind.active = true;
      rewind.holdForLiveClick = false;
      rewind.tickSize = Number(elements.rewindTicks.value) || state.settings?.tickSize || 1;
      rewind.scale = null;
      elements.rewindPanel.hidden = false;
    }
    rewind.playbackEndUS = fromUS;
    rewind.completed = false;
    rewind.speed = REWIND_AUTO_SPEED;
    elements.rewindSpeed.value = String(REWIND_AUTO_SPEED);
    setRewindPlaying(false);
    markRewindInteraction();
    if (await seekRewind(targetUS)) setRewindPlaying(true);
  }

  async function seekRewind(targetUS) {
    const rewind = state.rewind;
    const buffer = rewind.buffer;
    if (!rewind.active || !buffer || buffer.count === 0) return false;
    const clamped = Math.min(Math.max(targetUS, buffer.firstReceivedUS()), buffer.lastReceivedUS());
    rewind.targetUS = clamped;
    rewind.targetSeq = rewind.source.seqAtOrBefore(clamped);
    // Only the window actually being read is backfilled. The deepest metric is
    // the 60-second pace baseline, which reaches twice its horizon behind.
    const windowStartUS = clamped - 2 * 60 * 1e6;
    const fromSeq = rewind.source.seqAtOrBefore(windowStartUS) || buffer.firstSeq();
    const token = ++rewind.token;
    const contiguous = await rewind.source.ensure(fromSeq, rewind.targetSeq);
    if (token !== rewind.token || !rewind.active) return false;
    rewind.notice = contiguous ? '' : 'GAP IN THE REWIND RANGE COULD NOT BE BACKFILLED';
    rewind.dirty = true;
    return true;
  }

  function stepRewind(delta) {
    const rewind = state.rewind;
    if (!rewind.active || !rewind.source) return;
    // Print stepping is a deliberate pause just like Space or the PAUSE button.
    rewind.holdForLiveClick = true;
    rewind.completed = false;
    setRewindPlaying(false);
    const nextSeq = rewind.targetSeq + delta;
    const receipt = rewind.source.receivedUSAt(nextSeq);
    if (!receipt) {
      // Sequences are dense in the buffer, so a miss means an edge was reached.
      if (delta > 0) finishRewindSegment(rewind.source.lastReceivedUS());
      return;
    }
    rewind.targetSeq = nextSeq;
    rewind.targetUS = receipt;
    rewind.dirty = true;
    markRewindInteraction();
  }

  function toggleRewindPlayback() {
    const rewind = state.rewind;
    if (!rewind.active) return;
    if (rewind.playing) {
      // A manual pause latches the pane. Resuming does not clear the latch: when
      // this segment finishes it waits at the endpoint until LIVE is clicked.
      rewind.holdForLiveClick = true;
      rewind.completed = false;
      setRewindPlaying(false);
    } else {
      setRewindPlaying(true);
    }
    markRewindInteraction();
    rewind.dirty = true;
  }

  function setRewindPlaying(playing) {
    const rewind = state.rewind;
    rewind.playing = Boolean(playing);
    rewind.lastFrameMS = performance.now();
    elements.rewindPlay.textContent = rewind.playing ? 'PAUSE' : 'PLAY';
    elements.rewindPlay.classList.toggle('active', rewind.playing);
  }

  function markRewindInteraction() {
    state.rewind.lastInteractionMS = performance.now();
  }

  // A trader stranded in the past while the market moves is a real financial
  // risk, so every exit path leads back to live.
  function returnToLive(reason = '') {
    const rewind = state.rewind;
    if (!rewind.active) return;
    rewind.active = false;
    rewind.playing = false;
    rewind.targetSeq = 0;
    rewind.targetUS = 0;
    rewind.playbackEndUS = 0;
    rewind.holdForLiveClick = false;
    rewind.completed = false;
    rewind.token++;
    rewind.notice = '';
    elements.rewindPanel.hidden = true;
    elements.rewindPlay.textContent = 'PLAY';
    elements.rewindPlay.classList.remove('active');
    elements.rewindNotice.hidden = true;
    if (reason) elements.rewindBadge.textContent = 'LIVE';
    updateRewindIdleHint();
  }

  function finishRewindSegment(endpointUS = 0) {
    const rewind = state.rewind;
    if (rewind.holdForLiveClick) {
      const endpoint = endpointUS || rewind.playbackEndUS || rewind.targetUS;
      rewind.targetUS = endpoint;
      rewind.targetSeq = rewind.source.seqAtOrBefore(endpoint) || rewind.targetSeq;
      rewind.completed = true;
      setRewindPlaying(false);
      rewind.dirty = true;
      return;
    }
    returnToLive('replay complete');
  }

  function advanceRewindPlayback(nowMS) {
    const rewind = state.rewind;
    if (!rewind.active || !rewind.playing) return;
    const elapsedMS = Math.max(0, nowMS - (rewind.lastFrameMS || nowMS));
    rewind.lastFrameMS = nowMS;
    const advanced = rewind.targetUS + elapsedMS * 1000 * rewind.speed;
    const endpoint = rewind.playbackEndUS || rewind.buffer.lastReceivedUS();
    if (advanced >= endpoint) {
      rewind.targetUS = endpoint;
      rewind.targetSeq = rewind.source.seqAtOrBefore(endpoint) || rewind.targetSeq;
      finishRewindSegment(endpoint);
      return;
    }
    rewind.targetUS = advanced;
    rewind.targetSeq = rewind.source.seqAtOrBefore(advanced) || rewind.targetSeq;
    rewind.dirty = true;
  }

  function drawRewindPane() {
    const rewind = state.rewind;
    if (!rewind.active || !rewind.source || !rewind.targetSeq) return;
    const source = rewind.source;
    const nowUS = rewind.targetUS;
    // Anchored on a real live bar boundary, so the pane reproduces the live bar
    // phase whenever the tick sizes agree. An offset back from the target would
    // start mid-bar and shift every bar in the pane against live.
    const fromSeq = rewindWindowStart({
      liveBars: state.bars, liveTickSize: state.settings?.tickSize || 1, tickSize: rewind.tickSize,
      targetSeq: rewind.targetSeq, floorSeq: source.firstSeq(),
      visibleBars: state.settings?.visibleBars || 360
    });
    rewind.bars = aggregateTickBars(source, fromSeq, rewind.targetSeq, rewind.tickSize);
    drawTickChart(rewindChartTarget);

    if (!rewind.pressurePanel || rewind.pressureSource !== source) {
      rewind.pressurePanel?.unmount?.();
      rewind.pressureSource = source;
      rewind.pressurePanel = createTapePressureInstance(rewindRollingPanel, {
        source, blankWhenTruncated: true,
        format: { size: formatSize, signedPercent: formatSignedPercent, signed: formatSigned, rate: formatRate, tickChange: formatTickChange, relativePace: formatRelativePace }
      });
    }
    rewind.pressurePanel.render(nowUS);
    const behindSeconds = (source.lastReceivedUS() - nowUS) / 1e6;
    elements.rewindBadge.textContent = `REWIND −${behindSeconds.toFixed(1)}s`;
    elements.rewindBadge.setAttribute('aria-label', `Rewound ${behindSeconds.toFixed(1)} seconds behind live`);
    elements.rewindRate.textContent = `${formatRate(computeTapeRate(source, nowUS))}/s`;
    const quote = source.quoteAt(rewind.targetSeq);
    elements.rewindBid.textContent = quote.bid > 0 ? formatPrice(quote.bid) : '--';
    elements.rewindAsk.textContent = quote.ask > 0 ? formatPrice(quote.ask) : '--';
    const event = source.at(rewind.targetSeq);
    elements.rewindLast.textContent = event ? formatPrice(event.p) : '--';
    elements.rewindClockTime.textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date(nowUS / 1000));
    const retained = source.retainedSeconds();
    const shortfall = retained + 1 < (Number(state.rewindConfig?.buffer_seconds) || 180);
    const held = rewind.completed
      ? 'REPLAY COMPLETE · ← REPLAY AGAIN · CLICK LIVE TO EXIT'
      : rewind.holdForLiveClick && !rewind.playing
        ? 'PAUSED · ← REPLAY AGAIN · CLICK LIVE TO EXIT'
        : rewind.holdForLiveClick
          ? 'PAUSE LATCHED · CLICK LIVE TO EXIT WHEN COMPLETE'
          : '';
    const notice = rewind.notice || held || (shortfall ? `REWIND BUFFER ${retained.toFixed(0)}s` : '');
    elements.rewindNotice.textContent = notice;
    elements.rewindNotice.hidden = !notice;
  }

  // When the slot is reserved for rewind alone, the one-minute chart furniture
  // stays out of it and the empty state explains the shortcuts instead.
  function applyRewindSlot() {
    const rewindOnly = state.rewindPaneAvailable && !state.marketChartEnabled;
    elements.replayChart.hidden = rewindOnly || state.marketChartView === 'daily';
    elements.dailyChart.hidden = rewindOnly || state.marketChartView !== 'daily';
    elements.dayContext.hidden = rewindOnly || state.marketChartView === 'daily';
    document.querySelector('.market-chart-tabs').hidden = rewindOnly;
    document.querySelector('.replay-chart-legend').hidden = rewindOnly;
    if (rewindOnly) updateRewindIdleHint();
  }

  function updateRewindIdleHint() {
    if (!rewindEnabled() || state.marketChartEnabled) return;
    elements.replayChartEmpty.textContent = 'LIVE REWIND READY · ← 5s · SHIFT+← 15s · CTRL+← 30s';
    elements.replayChartEmpty.classList.remove('hidden');
    elements.replayChartEmpty.hidden = false;
  }

  function animationLoop(now) {
    // Rewind is stepped first and drawn on its own dirty flag. It never sets a
    // live dirty flag, so the live canvas keeps its redraw-only-on-change
    // behavior while a rewind is on screen.
    advanceRewindPlayback(now);
    if (state.rewind.active) {
      const autoReturnMS = (Number(state.rewindConfig?.auto_return_seconds) || 20) * 1000;
      if (!state.rewind.playing && !state.rewind.holdForLiveClick &&
          now - state.rewind.lastInteractionMS > autoReturnMS) returnToLive('inactivity');
      else if (state.rewind.dirty) drawRewindPane();
    }
    if (state.dirtyReplayChart && (state.status?.mode === 'replay' || state.marketChartEnabled) && state.settings?.showChart) drawReplayChart();
    if (state.dirtyChart && state.settings?.showChart) drawChart();
    if (state.dirtyDayContext && state.settings?.showChart) drawDayContext();
    if (state.dirtyDailyChart && state.marketChartView === 'daily' && state.settings?.showChart) drawDailyChart();
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

  function formatCandleVolume(value) {
    const number = Math.max(0, Number(value) || 0);
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [divisor, suffix] of units) {
      if (number < divisor) continue;
      const scaled = number / divisor;
      const decimals = scaled < 10 ? 2 : 1;
      return `${scaled.toFixed(decimals).replace(/\.0+$|(?<=\.[0-9])0$/, '')}${suffix}`;
    }
    return Math.round(number).toLocaleString('en-US');
  }

  function formatSigned(value) {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : number < 0 ? '-' : ''}${formatSize(number)}`;
  }

  function formatSignedDollars(value) {
    const number = Number(value) || 0;
    return `${number > 0 ? '+' : number < 0 ? '-' : ''}$${formatCandleVolume(Math.abs(number))}`;
  }

  function volumeSinceFourAM(bars) {
    const latest = bars?.[bars.length - 1];
    const latestParts = latest ? easternMinuteParts(latest.timeUS) : null;
    if (!latestParts) return 0;
    // Minute bars are ordered, so the 04:00 boundary is a binary search.
    // Formatting every bar's Eastern time would put one Intl call per retained
    // minute — up to 2200 of them — inside the per-frame chart path.
    let low = 0;
    let high = bars.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const parts = easternMinuteParts(bars[middle].timeUS);
      const inSession = parts && (parts.day > latestParts.day ||
        (parts.day === latestParts.day && parts.minute >= 4 * 60));
      if (inSession) high = middle;
      else low = middle + 1;
    }
    let total = 0;
    for (let index = low; index < bars.length; index++) {
      total += Math.max(0, Number(bars[index].volume) || 0);
    }
    return total;
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

  window.__tapeReadingCandleVolume = formatCandleVolume;
  window.__tapeReadingSignedDollars = formatSignedDollars;
  window.__tapeReadingVolumeSinceFourAM = volumeSinceFourAM;
  // Exposed solely for deterministic browser validation.
  window.__tapeReadingReplayToolbar = {
    update: (replay) => updateReplayControls(replay),
    setMode: (mode) => setConnection({ ...state.status, mode }),
    mode: () => state.status?.mode || ''
  };
  // Exposed solely for deterministic browser validation.
  window.__tapeReadingRewind = {
    state() {
      const rewind = state.rewind;
      return {
        available: rewindEnabled(), active: rewind.active, playing: rewind.playing,
        targetSeq: rewind.targetSeq, targetUS: rewind.targetUS, tickSize: rewind.tickSize,
        playbackEndUS: rewind.playbackEndUS, holdForLiveClick: rewind.holdForLiveClick,
        completed: rewind.completed, speed: rewind.speed, bars: rewind.bars.length, notice: rewind.notice,
        // The pane's first bar must start on one of the live pane's own bar
        // boundaries, otherwise every bar shown is shifted against live.
        firstBarSeq: rewind.bars[0]?.firstSeq || 0,
        phaseAnchored: rewind.bars.length > 0 && state.bars.some((bar) => bar.firstSeq === rewind.bars[0].firstSeq),
        liveTickSize: state.settings?.tickSize || 0,
        buffered: rewind.buffer?.count || 0, retainedSeconds: rewind.buffer?.retainedSeconds() || 0,
        bufferBytes: rewind.buffer?.bytes || 0, gaps: rewind.buffer?.gapList.length || 0,
        behindSeconds: rewind.active ? (rewind.source.lastReceivedUS() - rewind.targetUS) / 1e6 : 0
      };
    },
    enter: (seconds) => enterRewind(seconds),
    step: (delta) => stepRewind(delta),
    toggle: () => toggleRewindPlayback(),
    exit: () => returnToLive('validation')
  };
  window.__tapeReadingRender = {
    ready() {
      return Boolean(state.settings && state.ws?.readyState === WebSocket.OPEN);
    },
    async frame(targetUS) {
      const target = Number(targetUS);
      if (!Number.isFinite(target) || target <= 0) throw new Error('invalid render timestamp');
      const response = await fetch('/api/render', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'step', target_us: Math.round(target) })
      });
      if (!response.ok) throw new Error((await response.text()).trim());
      const payload = await response.json();
      const expected = Number(payload.last_seq) || 0;
      const deadline = performance.now() + 10000;
      while ((Number(state.trades[state.trades.length - 1]?.s) || 0) < expected) {
        if (performance.now() > deadline) throw new Error(`browser did not receive replay sequence ${expected}`);
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      if (payload.quote) state.quote = payload.quote;
      state.replay = payload.replay;
      state.status = { ...state.status, mode: 'replay', state: 'replaying', connected: true, message: 'deterministic render' };
      setConnection(state.status);
      state.serverClockUS = target;
      state.serverClockAt = performance.now();
      state.renderNowMS = target / 1000;
      if (!state.renderInitialized) {
        await document.fonts.ready;
        await refreshReplayRange(false);
        state.renderInitialized = true;
      }
      state.dirtyChart = true;
      state.dirtyReplayChart = true;
      state.dirtyDayContext = true;
      state.dirtyTape = true;
      drawReplayChart();
      drawChart();
      drawDayContext();
      renderTape();
      updateLiveMetrics(performance.now());
      updateQuoteText();
      elements.soundButton.textContent = state.settings.audio.enabled ? 'SOUND ON' : 'SOUND OFF';
      elements.soundButton.className = `sound-button ${state.settings.audio.enabled ? 'active' : 'muted'}`;
      return {
        target_us: target,
        sequence: expected,
        clock: elements.marketClockTime.textContent,
        trades: state.trades.length
      };
    }
  };
  bindControls();
  new ResizeObserver(() => { state.dirtyChart = true; state.dirtyReplayChart = true; state.dirtyDayContext = true; state.dirtyDailyChart = true; }).observe(elements.visualStack);
  connect();
  refreshExternalReplayStatus();
  setInterval(refreshExternalReplayStatus, 500);
  updateNavButtons();
  updateSoundButton();
  requestAnimationFrame(animationLoop);
})();
