import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';
import { FORECAST_HORIZONS, forecastReading, describeForecastError, etTime, percent } from './kronos-model.js';

export const kronosPanelManifest = {
  id: 'kronos-forecast', name: 'KRONOS FORECAST', version: '1.0.0',
  panelApiVersion: PANEL_API_VERSION, dataSchemaVersion: PANEL_DATA_SCHEMA_VERSION,
  description: 'Automatic completed-minute model frequencies. Experimental, uncalibrated, read-only.',
  supportedModes: ['live', 'replay'], requestedCapabilities: ['clock', 'forecast', 'settings'],
  defaultSettings: { horizon: 5 }, minimumWidth: 240,
  factory: createKronosPanel
};

export function createKronosPanel({ root, host, settings }) {
  root.classList.add('kronos-root');
  root.innerHTML = `<section class="kronos-panel" aria-label="Kronos experimental forecast">
    <div class="kronos-controls" aria-label="Forecast horizon"></div>
    <div class="kronos-basis">KRONOS · UNCALIBRATED</div>
    <div class="kronos-state" role="status"><strong>CONNECTING</strong><span>Automatic completed-minute forecasts</span></div>
    <div class="kronos-values" hidden>
      <div class="kronos-question"></div>
      <div class="kronos-numbers"><div><output class="kronos-above">—</output><span>ABOVE</span></div><div><output class="kronos-below">—</output><span>BELOW</span></div></div>
      <div class="kronos-sampling"></div>
      <div class="kronos-bounds" hidden></div>
      <div class="kronos-move"></div>
      <div class="kronos-details"></div>
    </div>
    <div class="kronos-clock"></div>
  </section>`;
  const query = (name) => root.querySelector(`.kronos-${name}`);
  const ui = Object.fromEntries(['controls','basis','state','values','question','numbers','above','below','sampling','bounds','move','details','clock'].map((name) => [name, query(name)]));
  let horizon = FORECAST_HORIZONS.includes(settings.horizon) ? settings.horizon : 5;
  let epoch = 0, stopped = false, inFlight = null, result = null, lastSecond = -1, nextPoll = 0;
  let snapshot = host.currentSnapshot(), lastOriginUS = 0;
  let stateMessage = { state: 'running', message: 'Requesting forecast from the latest completed minute' };
  const buttons = FORECAST_HORIZONS.map((value) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = `${value}m`;
    b.setAttribute('aria-label', `${value} completed one-minute bars`);
    b.addEventListener('click', () => { horizon = value; host.savePanelSettings({ horizon }); lastSecond = -1; paint(snapshot.clockUS || Date.now()*1000); }, { signal: host.signal });
    ui.controls.append(b); return b;
  });
  const clear = () => { epoch++; inFlight?.abort(); inFlight = null; result = null; nextPoll = 0; lastSecond = -1; lastOriginUS = 0; };
  const current = () => !stopped && host.isCurrent();
  const visible = () => !document.hidden && root.getClientRects().length > 0;

  function paint(nowUS) {
    if (!current()) return;
    const second = Math.floor(nowUS/1e6);
    if (second === lastSecond) return;
    lastSecond = second;
    buttons.forEach((b,i) => b.setAttribute('aria-pressed', String(horizon === FORECAST_HORIZONS[i])));
    ui.values.hidden = true; ui.state.hidden = false;
    ui.basis.textContent = `KRONOS${snapshot.mode === 'replay' ? ' · REPLAY' : ''} · UNCALIBRATED`;
    ui.clock.textContent = `${snapshot.symbol || '—'} · AUTO · ${horizon} completed bars`;
    ui.state.querySelector('strong').textContent = describeForecastError(stateMessage.state);
    ui.state.querySelector('span').textContent = stateMessage.message;
    if (!result) return;
    try {
      const view = forecastReading(result, horizon, nowUS);
      ui.clock.textContent = `${snapshot.symbol} · origin ${etTime(view.origin)} ET · age ${Math.floor(view.age)}s`;
      if (view.expired) { ui.state.querySelector('strong').textContent = 'NEXT CANDLE'; ui.state.querySelector('span').textContent = 'Previous forecast is no longer current; automatic update pending'; return; }
      if (view.above.unknown === view.n) {
        ui.state.querySelector('strong').textContent = 'UNKNOWN';
        ui.state.querySelector('span').textContent = `0/${view.n} paths usable at ${horizon}m. No directional estimate available.`;
        return;
      }
      const valid = view.n - view.above.unknown, partial = view.above.unknown > 0;
      ui.state.hidden = true; ui.values.hidden = false;
      ui.basis.textContent = `KRONOS${snapshot.mode === 'replay' ? ' · REPLAY' : ''} · ${valid}/${view.n} USABLE · UNCALIBRATED${view.shortContext ? " · SHORT HISTORY" : ""}`;
      ui.question.textContent = `Close vs $${view.reference.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} at ${etTime(view.close)} ET`;
      ui.above.textContent = percent(view.above.validValue); ui.below.textContent = percent(view.below.validValue);
      const leader = view.above.yes > view.below.yes ? 'above' : view.below.yes > view.above.yes ? 'below' : 'tie';
      ui.numbers.dataset.leader = leader;
      ui.above.nextElementSibling.textContent = leader === 'above' ? '▲ ABOVE · LEADS' : leader === 'tie' ? 'ABOVE · TIED' : 'ABOVE';
      ui.below.nextElementSibling.textContent = leader === 'below' ? '▼ BELOW · LEADS' : leader === 'tie' ? 'BELOW · TIED' : 'BELOW';
      ui.above.setAttribute('aria-label', `${view.above.yes} of ${valid} usable generated paths close above the reference; ${view.above.unknown} unusable paths excluded`);
      ui.below.setAttribute('aria-label', `${view.below.yes} of ${valid} usable generated paths close below the reference; ${view.below.unknown} unusable paths excluded`);
      ui.sampling.textContent = partial
        ? `USABLE PATHS ONLY · ${view.above.unknown} invalid · may be biased`
        : `Above: ${view.above.yes}/${view.n} · equal ${view.equal.yes}/${view.n} · 95% sampling ${percent(view.above.interval[0])}–${percent(view.above.interval[1])}`;
      ui.sampling.title = partial
        ? 'Percentages exclude invalid paths. Validity is not prediction accuracy; excluding paths may bias the estimate. Ranges allow invalid paths to fall on either side, and are not confidence intervals.'
        : 'Wilson interval for finite model sampling only. NOT a real-market probability or prediction-accuracy interval.';
      ui.move.textContent = view.median === null ? '' : `Median close move ${view.median >= 0 ? '+' : ''}${(view.median/100).toFixed(2)}%`;
      ui.bounds.hidden = !partial;
      ui.bounds.textContent = partial ? `All-path bounds: ↑ ${percent(view.above.bounds[0])}–${percent(view.above.bounds[1])} · ↓ ${percent(view.below.bounds[0])}–${percent(view.below.bounds[1])}` : '';
      ui.bounds.title = ui.sampling.title;
      ui.details.textContent = `${view.context} bars${view.shortContext ? ' · SHORT CONTEXT' : ''} · equal ${view.equal.yes}/${view.n}`;
      ui.details.title = `Amount is estimated by Kronos from volume × mean OHLC. No tape, news, execution or calibration model.${view.qualityWarning ? ` ${view.qualityWarning}.` : ''}`;
      ui.clock.textContent = `${snapshot.symbol} · ${etTime(view.origin)} → ${etTime(view.close)} ET · ${Math.floor(view.age)}s old${view.late ? ' · BAR-ANCHORED' : ''}`;
    } catch (error) {
      ui.state.querySelector('strong').textContent = 'WITHHELD';
      ui.state.querySelector('span').textContent = String(error?.message || error);
    }
  }

  async function poll(nowUS) {
    if (!current() || inFlight || !visible() || performance.now() < nextPoll) return;
    snapshot = host.currentSnapshot();
    if (!['live', 'replay'].includes(snapshot.mode)) {
      result = null; stateMessage = { state: 'unsupported_mode', message: 'Forecasts require IBKR live history or recorded replay data.' };
      nextPoll = performance.now()+1000; paint(nowUS); return;
    }
    if (!snapshot.symbol) return;
    const mine = epoch, symbol = snapshot.symbol, generation = snapshot.generation, mode = snapshot.mode;
    const controller = new AbortController(); inFlight = controller;
    const abort = () => controller.abort(); host.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 5000);
    try {
      const response = await host.requestForecast({ symbol, signal: controller.signal });
      if (!current() || mine !== epoch || symbol !== host.currentSnapshot().symbol || generation !== host.currentSnapshot().generation || mode !== host.currentSnapshot().mode) return;
      if (response.symbol !== symbol || response.generation !== generation) { result = null; stateMessage = { state: 'superseded', message: 'Waiting for the current symbol/data generation' }; return; }
      stateMessage = response;
      if (response.state === 'forecast' && response.result) {
        if (response.result.mode !== mode || response.result.symbol !== symbol || Date.parse(response.result.forecast_origin)*1000 !== response.origin_us) throw new Error('Response mode/origin/symbol mismatch');
        result = response.result;
      } else { result = null; }
      // Short local status polling while working; model itself runs once per bar.
      // Freshness-boundary wakeup below overrides this backoff at each new minute.
      nextPoll = performance.now() + (response.state === 'running' ? 1000 : 5000);
    } catch (error) {
      if (current() && mine === epoch) { result = null; stateMessage = { state: 'offline', message: controller.signal.aborted ? 'Tape backend forecast request timed out; retrying automatically' : 'Tape backend forecast endpoint is unavailable' }; nextPoll = performance.now()+10000; }
    } finally {
      clearTimeout(timeout); host.signal.removeEventListener('abort', abort);
      if (inFlight === controller) inFlight = null;
      lastSecond = -1; if (current()) paint(host.currentSnapshot().clockUS || nowUS);
    }
  }

  return {
    onEvent(event) {
      if (event.type === 'snapshot' || event.type === 'modeChanged') {
        clear(); snapshot = host.currentSnapshot();
        stateMessage = { state: 'running', message: 'Requesting forecast from the latest completed minute' };
      }
    },
    render(nowUS) {
      if (!current() || !visible()) { if (inFlight) inFlight.abort(); return; }
      snapshot = host.currentSnapshot();
      // Do not use replay wall time, receipt-time candles or a selected tick size.
      const origin = Math.floor(nowUS/60e6)*60e6;
      if (origin !== lastOriginUS) { lastOriginUS = origin; nextPoll = 0; lastSecond = -1; }
      void poll(nowUS);
      paint(nowUS);
    },
    unmount() { stopped = true; clear(); root.classList.remove('kronos-root'); root.replaceChildren(); }
  };
}
