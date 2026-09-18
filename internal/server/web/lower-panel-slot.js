import { PanelHost } from './panel-host.js';
import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';
import { kronosPanelManifest } from './kronos-panel.js';
import { blankPanelManifest } from './blank-panel.js';

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
  panels.slots.lowerAnalytics = { activePanelId: 'kronos-forecast', ...saved?.slots?.lowerAnalytics };
  if (!['kronos-forecast','tick-chart','blank'].includes(panels.slots.lowerAnalytics.activePanelId)) panels.slots.lowerAnalytics.activePanelId = 'kronos-forecast';
  return panels;
}
export function createLowerPanelHost({ root, picker, settings, capabilities, saveSettings, tickVisible }) {
  const host = new PanelHost({ root, picker, settings, saveSettings,
    slotId: 'lowerAnalytics', fallbackId: 'kronos-forecast',
    registry: [kronosPanelManifest, tickChartManifest, blankPanelManifest],
    capabilities: { ...capabilities,
      setTickChartVisible: tickVisible,
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
