import { HORIZONS, BALANCE_DEADBAND_PERCENT, computeHorizon } from './tape-model.js';
import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';

export const TAPE_PRESSURE_MARKUP = `
  <header class="rolling-header" aria-hidden="true">
    <span>WINDOW</span><span>VOLUME / SIDE</span><span>DELTA%</span><span>SHARES/S</span><span>PRINTS/S</span><span>Δ MID</span><span>PACE</span>
  </header>
  <div class="rolling-rows">
    ${[[5, 'ignition', 'IGNITION'], [15, 'primary', 'PRIMARY'], [60, 'context', 'CONTEXT']].map(([seconds, kind, label]) => `
      <article class="rolling-row ${kind}" data-horizon="${seconds}">
        <div class="window-cell"><strong>${seconds}s</strong><small>${label}</small><b class="winner">BALANCED</b></div>
        <div class="metric-cell volume-cell" data-label="VOLUME"><output class="volume">0</output><small><span class="buyer-volume">B 0</span><span class="seller-volume">S 0</span></small></div>
        <div class="metric-cell delta-cell" data-label="DELTA%"><output class="delta-percent">0%</output><small class="signed-delta">Δ 0</small></div>
        <div class="metric-cell" data-label="SHARES/S"><output class="shares-rate">0</output></div>
        <div class="metric-cell" data-label="PRINTS/S"><output class="prints-rate">0</output></div>
        <div class="metric-cell" data-label="Δ MID"><output class="mid-change">0t</output></div>
        <div class="metric-cell" data-label="PACE"><output class="relative-pace">—</output></div>
        <div class="pressure-track" aria-hidden="true"><i></i></div>
      </article>`).join('')}
  </div>`;

function collect(root) {
  return new Map(HORIZONS.map((seconds) => {
    const row = root.querySelector(`[data-horizon="${seconds}"]`);
    return [seconds, {
      row, winner: row.querySelector('.winner'), volume: row.querySelector('.volume'),
      buyerVolume: row.querySelector('.buyer-volume'), sellerVolume: row.querySelector('.seller-volume'),
      deltaPercent: row.querySelector('.delta-percent'), signedDelta: row.querySelector('.signed-delta'),
      sharesRate: row.querySelector('.shares-rate'), printsRate: row.querySelector('.prints-rate'),
      midChange: row.querySelector('.mid-change'), relativePace: row.querySelector('.relative-pace')
    }];
  }));
}

function renderRow(cells, seconds, metric, format, blankWhenTruncated) {
  if (blankWhenTruncated && metric.truncated) {
    cells.row.className = `rolling-row ${seconds === 5 ? 'ignition' : seconds === 15 ? 'primary' : 'context'} balanced`;
    cells.row.style.setProperty('--pressure-width', '0%');
    cells.winner.textContent = 'NO DATA';
    for (const cell of [cells.volume, cells.deltaPercent, cells.sharesRate, cells.printsRate, cells.midChange, cells.relativePace]) cell.textContent = '--';
    cells.buyerVolume.textContent = 'B --'; cells.sellerVolume.textContent = 'S --'; cells.signedDelta.textContent = 'Δ --';
    cells.row.setAttribute('aria-label', `${seconds} seconds: outside the retained rewind buffer.`);
    return;
  }
  const magnitude = Math.abs(metric.deltaPercent);
  const direction = magnitude < BALANCE_DEADBAND_PERCENT ? 'balanced' : metric.deltaPercent > 0 ? 'buyer' : 'seller';
  cells.row.classList.remove('buyer', 'seller', 'balanced'); cells.row.classList.add(direction);
  cells.row.style.setProperty('--pressure-width', `${Math.min(50, magnitude / 2)}%`);
  cells.winner.textContent = direction === 'buyer' ? 'BUY ▶' : direction === 'seller' ? '◀ SELL' : 'BALANCED';
  cells.volume.textContent = format.size(metric.volume);
  cells.buyerVolume.textContent = `B ${format.size(metric.buyer)}`; cells.sellerVolume.textContent = `S ${format.size(metric.seller)}`;
  cells.deltaPercent.textContent = format.signedPercent(metric.deltaPercent); cells.signedDelta.textContent = `Δ ${format.signed(metric.delta)}`;
  cells.sharesRate.textContent = format.rate(metric.sharesRate); cells.printsRate.textContent = format.rate(metric.printsRate);
  cells.midChange.textContent = format.tickChange(metric.midTicks); cells.relativePace.textContent = format.relativePace(metric.relativePace);
}

export function createTapePressureInstance(root, { source, format, blankWhenTruncated = false } = {}) {
  root.classList.add('rolling-panel');
  root.innerHTML = TAPE_PRESSURE_MARKUP;
  const cells = collect(root);
  let mounted = true;
  return {
    render(nowUS) {
      if (!mounted || !Number.isFinite(nowUS) || nowUS <= 0) return;
      for (const seconds of HORIZONS) renderRow(cells.get(seconds), seconds, computeHorizon(source, seconds, nowUS), format, blankWhenTruncated);
    },
    unmount() { mounted = false; root.replaceChildren(); root.classList.remove('rolling-panel'); }
  };
}

export const tapePressureManifest = {
  id: 'tape-pressure', name: 'TAPE PRESSURE', version: '1.0.0',
  panelApiVersion: PANEL_API_VERSION, dataSchemaVersion: PANEL_DATA_SCHEMA_VERSION,
  description: 'Rolling 5, 15, and 60 second tape pressure.', supportedModes: ['live', 'massive', 'demo', 'replay', 'render'],
  requestedCapabilities: ['stream', 'clock'], defaultSettings: {}, minimumWidth: 280,
  factory: ({ root, host }) => createTapePressureInstance(root, { source: host.streamSource(), format: host.formatters() })
};
