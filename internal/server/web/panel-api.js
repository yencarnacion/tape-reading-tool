export const PANEL_API_VERSION = 1;
export const PANEL_DATA_SCHEMA_VERSION = 1;
export const PRIMARY_ANALYTICS_SLOT = 'primaryAnalytics';
export const PANEL_CAPABILITIES = Object.freeze([
  'stream', 'formatters', 'clock', 'trades', 'completed-daily-rth-bars', 'rth-session-context', 'settings'
]);

export function immutablePanelData(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutablePanelData));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutablePanelData(entry)])));
  }
  return value;
}

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
  // The panel itself receives this manifest at mount, and the host reads the
  // declared grants again on every mount. A shallow freeze leaves the arrays and
  // the default settings writable through that reference, so a panel could add a
  // capability it never declared and collect it the next time the slot mounts it.
  // Copy before freezing so the registry module's own object is left alone.
  return Object.freeze({
    ...manifest,
    requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
    supportedModes: Object.freeze([...(manifest.supportedModes || [])]),
    defaultSettings: immutablePanelData(manifest.defaultSettings)
  });
}
