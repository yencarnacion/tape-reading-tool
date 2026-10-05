import { PanelHost } from './panel-host.js';
import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';
import { kronosPanelManifest } from './kronos-panel.js';
import { optionsFlowManifest } from './options-flow-panel.js';
import { blankPanelManifest } from './blank-panel.js';

export const DEFAULT_LOWER_PANEL = 'options-flow';

// The original renderer still owns the canvas. This plugin only grants/releases
// its lower price region; the upper delta and the separate rewind are untouched.
export const tickChartManifest = {
  id: 'tick-chart', name: 'TICK CHART', version: '1.0.0', panelApiVersion: PANEL_API_VERSION,
  dataSchemaVersion: PANEL_DATA_SCHEMA_VERSION, description: 'Original tick-price canvas in the lower slot.',
  supportedModes: ['live','massive','demo','replay','render'], requestedCapabilities: ['tick-chart'], defaultSettings: {}, minimumWidth: 0,
  factory: ({ root, host }) => {
    root.classList.add('tick-chart-slot'); host.setTickChartVisible(true);
    return { unmount() { host.setTickChartVisible(false); root.classList.remove('tick-chart-slot'); } };
  }
};
export function lowerPanelSettings(panels, saved) {
  let id = saved?.slots?.lowerAnalytics?.activePanelId;
  // Move the former default on upgrade, then honor subsequent manual selections.
  if (id === 'kronos-forecast' && saved?.lowerDefaultId !== DEFAULT_LOWER_PANEL) id = DEFAULT_LOWER_PANEL;
  panels.lowerDefaultId = DEFAULT_LOWER_PANEL;
  panels.slots.lowerAnalytics = { activePanelId: ['kronos-forecast','options-flow','tick-chart','blank'].includes(id) ? id : DEFAULT_LOWER_PANEL };
  return panels;
}
export function createLowerPanelHost({ root, picker, settings, capabilities, saveSettings, tickVisible }) {
  const host = new PanelHost({ root, picker, settings, saveSettings,
    slotId: 'lowerAnalytics', fallbackId: DEFAULT_LOWER_PANEL,
    registry: [optionsFlowManifest, kronosPanelManifest, tickChartManifest, blankPanelManifest],
    capabilities: { ...capabilities,
      setTickChartVisible: tickVisible,
      getOptionsFlow: async ({symbol, signal}) => {
        const response = await fetch(`/api/panel-data/options-flow?${new URLSearchParams({symbol})}`, {signal});
        if (!response.ok) throw new Error('Options flow unavailable');
        return response.json();
      },
      requestForecast: async ({ symbol, signal }) => {
        const response = await fetch('/api/forecast', { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', 'X-Tape-Forecast': '1' }, body: JSON.stringify({ symbol }) });
        if (!response.ok) throw new Error(`Forecast endpoint returned HTTP ${response.status}`);
        return response.json();
      }
    }
  });
  host.swap(settings.slots.lowerAnalytics.activePanelId, false);
  return host;
}
