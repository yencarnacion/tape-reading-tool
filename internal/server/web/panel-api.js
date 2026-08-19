export const PANEL_API_VERSION = 1;
export const PANEL_DATA_SCHEMA_VERSION = 1;
export const PRIMARY_ANALYTICS_SLOT = 'primaryAnalytics';
export const PANEL_CAPABILITIES = Object.freeze([
  'stream', 'formatters', 'clock', 'trades', 'completed-daily-rth-bars', 'rth-session-context', 'settings'
]);

export function validatePanelManifest(manifest) {
  if (!manifest || typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/.test(manifest.id)) {
    throw new Error('panel manifest has an invalid id');
  }
  if (manifest.panelApiVersion !== PANEL_API_VERSION || manifest.dataSchemaVersion !== PANEL_DATA_SCHEMA_VERSION) {
    throw new Error(`panel ${manifest.id} requires an incompatible panel API`);
  }
  if (!Array.isArray(manifest.requestedCapabilities) || manifest.requestedCapabilities.some((capability) => typeof capability !== 'string')) {
    throw new Error(`panel ${manifest.id} has invalid requested capabilities`);
  }
  if (manifest.requestedCapabilities.some((capability) => !PANEL_CAPABILITIES.includes(capability))) {
    throw new Error(`panel ${manifest.id} requests an unknown capability`);
  }
  if (!manifest.defaultSettings || typeof manifest.defaultSettings !== 'object' || Array.isArray(manifest.defaultSettings)) {
    throw new Error(`panel ${manifest.id} has invalid default settings`);
  }
  if (typeof manifest.factory !== 'function') throw new Error(`panel ${manifest.id} has no factory`);
  return Object.freeze({ ...manifest });
}
