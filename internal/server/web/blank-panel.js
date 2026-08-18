import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION } from './panel-api.js';

export const blankPanelManifest = {
  id: 'blank', name: 'BLANK', version: '1.0.0', panelApiVersion: PANEL_API_VERSION,
  dataSchemaVersion: PANEL_DATA_SCHEMA_VERSION, description: 'An intentionally empty analytics panel.',
  supportedModes: ['live', 'massive', 'demo', 'replay', 'render'], requestedCapabilities: [], defaultSettings: {}, minimumWidth: 0,
  factory: ({ root }) => {
    root.classList.add('blank-analytics-panel');
    root.innerHTML = '<p>NO ANALYTICS PANEL</p>';
    return { render() {}, onEvent() {}, unmount() { root.classList.remove('blank-analytics-panel'); root.replaceChildren(); } };
  }
};
