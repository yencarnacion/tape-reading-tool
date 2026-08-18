import { PANEL_API_VERSION, PANEL_DATA_SCHEMA_VERSION, validatePanelManifest } from './panel-api.js';

export class PanelHost {
  constructor({ root, picker, registry, capabilities, settings, saveSettings }) {
    this.root = root; this.picker = picker; this.capabilities = capabilities;
    this.settings = settings; this.saveSettings = saveSettings; this.generation = 0; this.active = null;
    this.registry = new Map(registry.map((definition) => { const manifest = validatePanelManifest(definition); return [manifest.id, manifest]; }));
    picker.replaceChildren(...[...this.registry.values()].map((manifest) => {
      const option = document.createElement('option'); option.value = manifest.id; option.textContent = manifest.name; return option;
    }));
    picker.addEventListener('change', () => this.swap(picker.value));
  }

  validId(id) { return this.registry.has(id) ? id : 'tape-pressure'; }

  swap(requestedId, persist = true) {
    const id = this.validId(requestedId); const manifest = this.registry.get(id); const generation = ++this.generation;
    if (this.active) {
      try { this.active.controller.abort(); this.active.instance?.unmount?.(); } catch (error) { console.error('panel unmount failed', error); }
      this.unmountCount = (this.unmountCount || 0) + 1;
    }
    this.active = null; this.root.className = 'analytics-panel-root panel-loading'; this.root.textContent = `LOADING ${manifest.name}`; this.picker.value = id;
    const controller = new AbortController();
    const host = Object.freeze({
      apiVersion: PANEL_API_VERSION, dataSchemaVersion: PANEL_DATA_SCHEMA_VERSION,
      signal: controller.signal, generation, isCurrent: () => this.generation === generation && !controller.signal.aborted,
      ...this.capabilities
    });
    try {
      this.root.className = 'analytics-panel-root'; this.root.replaceChildren();
      const instance = manifest.factory({ root: this.root, host, manifest, settings: Object.freeze({ ...(this.settings.settings?.[id] || manifest.defaultSettings) }) });
      this.active = { id, manifest, instance: instance || {}, controller, generation };
      instance?.onEvent?.({ type: 'snapshot', snapshot: this.capabilities.currentSnapshot() });
    } catch (error) { this.fail(manifest, error, generation); }
    if (persist) {
      this.settings.slots.primaryAnalytics.activePanelId = id;
      this.saveSettings();
    }
    this.mountCount = (this.mountCount || 0) + 1;
    window.__tapePanelDebug = { activePanelId: id, generation, mountCount: this.mountCount, unmountCount: this.unmountCount || 0 };
  }

  event(event) {
    const active = this.active; if (!active) return;
    try { active.instance?.onEvent?.(event); } catch (error) { this.fail(active.manifest, error, active.generation); }
  }

  render(nowUS) {
    const active = this.active; if (!active) return;
    try { active.instance?.render?.(nowUS); } catch (error) { this.fail(active.manifest, error, active.generation); }
  }

  fail(manifest, error, generation) {
    if (generation !== this.generation) return;
    console.error(`panel ${manifest.id} stopped`, error); this.active?.controller.abort(); this.active = null;
    this.root.className = 'analytics-panel-root panel-error'; this.root.replaceChildren();
    const title = document.createElement('strong'); title.textContent = `${manifest.name} STOPPED`;
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'View error';
    const message = document.createElement('pre'); message.textContent = String(error?.message || error); details.append(summary, message);
    const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Reload panel'; reload.addEventListener('click', () => this.swap(manifest.id, false));
    this.root.append(title, reload, details);
  }
}
