import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';
import { applyEligibleTrades, calculateADR, calculateExtension, classifyRTH, displayNumber, extensionTone, marketParts, seedRTHContext } from './adr-rth-extension-model.js';

function markup(lookback, directionMode) {
  return `<div class="adr-panel" aria-live="polite">
    <div class="adr-heading"><strong>ADR RTH EXTENSION</strong><div class="adr-controls"><label>MODE <select class="adr-mode" aria-label="ADR direction mode"><option value="auto">AUTO</option><option value="low">FROM LOW</option><option value="high">FROM HIGH</option></select></label><label>LOOKBACK <input class="adr-lookback" type="number" min="5" max="60" value="${lookback}" aria-label="ADR lookback sessions"></label></div></div>
    <div class="adr-state"><strong>LOADING ADR HISTORY</strong><small></small><div class="adr-state-baseline"><b>ADR${lookback}</b><output>--</output></div></div>
    <div class="adr-ready" hidden>
      <div class="adr-primary"><strong class="adr-value">--</strong><span class="adr-percent">--</span></div>
      <div class="adr-baseline-card"><span class="adr-label">ADR${lookback}</span><strong class="adr-baseline">--</strong><small>${lookback}-DAY AVG RANGE</small></div>
      <span class="adr-history" hidden>--</span>
      <div class="adr-meter" aria-label="ADR extension reference scale"><i></i><b></b></div>
      <div class="adr-scale"><span>0.00</span><span>0.25</span><span>0.50</span><span>0.75</span><span>1.00</span><span>1.25+</span></div><small class="adr-reference">REFERENCE ONLY · 1.00 ADR IS NOT A REVERSAL SIGNAL</small>
    </div></div>`;
}

function timeET(timeUS) {
  if (!Number.isFinite(Number(timeUS)) || Number(timeUS) <= 0) return '--';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(Number(timeUS) / 1000));
}

function createADRPanel({ root, host, settings }) {
  let lookback = Math.max(5, Math.min(60, Math.round(Number(settings.lookbackSessions) || 20)));
  let directionMode = ['auto', 'high'].includes(String(settings.directionMode || '').toLowerCase()) ? String(settings.directionMode).toLowerCase() : 'low';
  let snapshot = host.currentSnapshot(); let adr = null; let context = null; let loadGeneration = 0; let mounted = true; let loadedSessionDateET = '';
  let pendingTrades = []; let pendingOverflow = false; let requestController = null;
  root.innerHTML = markup(lookback, directionMode); const $ = (selector) => root.querySelector(selector);
  const stateNode = $('.adr-state'), readyNode = $('.adr-ready'), input = $('.adr-lookback'), modeInput = $('.adr-mode');
  modeInput.value = directionMode;

  // A paused replay is stopped in time. Nothing delivered afterwards may advance
  // the panel clock, or the display would drift past the instant being examined.
  function frozen() { return snapshot.mode === 'replay' && snapshot.status?.state === 'paused'; }
  function showState(title, detail = '') { readyNode.hidden = true; stateNode.hidden = false; stateNode.querySelector('strong').textContent = title; stateNode.querySelector('small').textContent = detail; }
  function renderBasis() {
    $('.adr-state-baseline b').textContent = `ADR${lookback}`;
    $('.adr-state-baseline output').textContent = adr?.status === 'ready' ? `${displayNumber(adr.adr * 100)}%` : '--';
    $('.adr-label').textContent = `ADR${lookback}`;
    $('.adr-baseline-card small').textContent = `${lookback}-DAY AVG RANGE`;
  }
  function render() {
    if (!mounted) return;
    renderBasis();
    root.dataset.adrTone = 'neutral';
    $('.adr-primary').className = 'adr-primary adr-tone-neutral';
    const phase = classifyRTH(snapshot.clockUS);
    // The baseline excludes the current session and the seed is scoped to one
    // session date, so crossing into another session invalidates both. Without
    // this an application left running overnight, or a replay seek that lands
    // on an earlier date, would keep presenting the previous session's frozen
    // low and last as if they were current.
    if (phase.sessionDateET && loadedSessionDateET && phase.sessionDateET !== loadedSessionDateET) { void load(); return; }
    if (phase.phase === 'before-open') { showState('WAITING FOR RTH OPEN'); return; }
    if (adr?.status === 'insufficient') { showState('INSUFFICIENT ADR HISTORY', `${adr.completeSessions} / ${lookback} COMPLETED SESSIONS`); return; }
    if (adr?.status !== 'ready') { showState(adr?.status === 'unavailable' ? 'ADR HISTORY UNAVAILABLE' : 'LOADING ADR HISTORY'); return; }
    if (!context || context.status === 'building') { showState('BUILDING RTH RANGE'); return; }
    if (context.status === 'incomplete') { showState('RTH RANGE INCOMPLETE', 'SESSION DATA DOES NOT REACH 09:30 ET'); return; }
    if (context.status === 'unavailable' || context.status === 'stale') { showState('ADR HISTORY UNAVAILABLE'); return; }
    const value = calculateExtension(adr, context, directionMode);
    if (!['ready', 'closed'].includes(value.status)) { showState('BUILDING RTH RANGE'); return; }
    stateNode.hidden = true; readyNode.hidden = false;
    const selectedLabel = value.mode === 'high' ? 'FROM RTH HIGH' : 'FROM RTH LOW';
    $('.adr-value').textContent = `${displayNumber(value.extension)} ADR`; $('.adr-percent').textContent = `${value.percent >= 0 ? '+' : ''}${displayNumber(value.percent * 100)}% ${selectedLabel}${directionMode === 'auto' ? ' · AUTO' : ''}`;
    const selectedTone = extensionTone(value.mode, value.extension);
    root.dataset.adrTone = selectedTone;
    $('.adr-primary').className = `adr-primary adr-tone-${selectedTone}`;
    $('.adr-label').textContent = `ADR${lookback}`; $('.adr-baseline').textContent = `${displayNumber(adr.adr * 100)}%`; $('.adr-history').textContent = `${adr.completeSessions} / ${lookback}`;
    root.style.setProperty('--adr-width', `${Math.max(0, Math.min(100, value.extension / 1.25 * 100))}%`);
    root.classList.toggle('adr-closed', value.status === 'closed'); $('.adr-reference').textContent = `${value.status === 'closed' ? 'RTH CLOSED · ' : ''}REFERENCE ONLY · 1.00 ADR IS NOT A REVERSAL SIGNAL`;
  }

  async function load() {
    requestController?.abort(); requestController = new AbortController();
    const requestSignal = AbortSignal.any([host.signal, requestController.signal]);
    const token = ++loadGeneration; const phase = classifyRTH(snapshot.clockUS); adr = null; context = null; pendingTrades = []; pendingOverflow = false; showState('LOADING ADR HISTORY');
    loadedSessionDateET = phase.sessionDateET || '';
    if (!phase.sessionDateET || !snapshot.symbol) return;
    try {
      const [history, seed] = await Promise.all([
        host.getCompletedDailyBars({ symbol: snapshot.symbol, beforeSessionDateET: phase.sessionDateET, limit: lookback, signal: requestSignal }),
        host.getRTHSessionContext({ symbol: snapshot.symbol, sessionDateET: phase.sessionDateET, throughUS: snapshot.clockUS, signal: requestSignal })
      ]);
      if (!mounted || token !== loadGeneration || !host.isCurrent()) return;
      adr = calculateADR(history.bars, lookback, phase.sessionDateET);
      context = seedRTHContext(seed, { symbol: snapshot.symbol, sessionDateET: phase.sessionDateET });
      context = applyEligibleTrades(context, pendingTrades, { symbol: snapshot.symbol, sessionDateET: phase.sessionDateET });
      pendingTrades = [];
      if (pendingOverflow) { snapshot.clockUS = host.currentSnapshot().clockUS; void load(); return; }
      render();
    } catch (error) { if (mounted && token === loadGeneration && host.isCurrent()) { console.error('ADR panel data load failed', error); adr = { status: 'unavailable' }; context = { status: 'unavailable' }; render(); } }
  }

  input.addEventListener('change', () => { lookback = Math.max(5, Math.min(60, Math.round(Number(input.value) || 20))); input.value = String(lookback); host.savePanelSettings({ lookbackSessions: lookback, directionMode }); void load(); });
  modeInput.addEventListener('change', () => { directionMode = ['low', 'high'].includes(modeInput.value) ? modeInput.value : 'auto'; modeInput.value = directionMode; host.savePanelSettings({ lookbackSessions: lookback, directionMode }); render(); });
  return {
    onEvent(event) {
      if (event.type === 'snapshot') { snapshot = { ...snapshot, ...event.snapshot }; void load(); }
      else if (event.type === 'tradeBatch' && event.symbol === snapshot.symbol) {
        if (!frozen()) snapshot.clockUS = event.clockUS || snapshot.clockUS;
        const phase = marketParts(snapshot.clockUS);
        if (!context) {
          if (pendingTrades.length + event.trades.length <= 8192) pendingTrades.push(...event.trades); else pendingOverflow = true;
        } else context = applyEligibleTrades(context, event.trades, { symbol: snapshot.symbol, sessionDateET: phase?.sessionDateET });
        render();
      }
      else if (event.type === 'modeChanged') { snapshot.mode = event.mode; snapshot.status = { ...(event.status || snapshot.status) }; snapshot.clockUS = event.clockUS || snapshot.clockUS; render(); }
    },
    render(nowUS) { if (!frozen()) snapshot.clockUS = nowUS || snapshot.clockUS; render(); },
    unmount() { mounted = false; loadGeneration++; requestController?.abort(); root.replaceChildren(); root.classList.remove('adr-closed'); }
  };
}

export const adrRTHManifest = {
  id: 'adr-rth-extension', name: 'ADR RTH EXTENSION', version: '1.1.0', panelApiVersion: PANEL_API_VERSION, dataSchemaVersion: PANEL_DATA_SCHEMA_VERSION,
  description: 'Current chart-eligible extension from the running regular-session low or high, normalized by completed-session ADR.',
  supportedModes: ['live', 'massive', 'demo', 'replay', 'render'], requestedCapabilities: ['clock', 'trades', 'formatters', 'completed-daily-rth-bars', 'rth-session-context', 'settings'],
  defaultSettings: { lookbackSessions: 20, directionMode: 'low' }, minimumWidth: 280, factory: createADRPanel
};
