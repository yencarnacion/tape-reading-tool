export const PANEL_API_VERSION = 1;
export const PANEL_DATA_SCHEMA_VERSION = 1;
export const PRIMARY_ANALYTICS_SLOT = 'primaryAnalytics';

export function validatePanelManifest(manifest) {
  if (!manifest || typeof manifest.id !== 'string' || !/^[a-z0-9-]+$/.test(manifest.id)) {
    throw new Error('panel manifest has an invalid id');
  }
  if (manifest.panelApiVersion !== PANEL_API_VERSION || manifest.dataSchemaVersion !== PANEL_DATA_SCHEMA_VERSION) {
    throw new Error(`panel ${manifest.id} requires an incompatible panel API`);
  }
  if (typeof manifest.factory !== 'function') throw new Error(`panel ${manifest.id} has no factory`);
  return Object.freeze({ ...manifest });
}

