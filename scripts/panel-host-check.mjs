import assert from 'node:assert/strict';
import { PanelHost } from '../internal/server/web/panel-host.js';
import { validatePanelManifest } from '../internal/server/web/panel-api.js';

globalThis.window = {};
globalThis.document = { createElement: () => ({ value: '', textContent: '' }) };

const root = { className: '', textContent: '', replaceChildren() {} };
const picker = { value: '', replaceChildren() {}, addEventListener() {} };
const settings = { slots: { primaryAnalytics: { activePanelId: 'blank' } }, settings: { configured: { count: 7 } } };
const saves = [];
const capabilities = {
  currentSnapshot: () => ({ symbol: 'AAPL' }),
  streamSource: () => 'stream', formatters: () => 'formatters',
  getCompletedDailyBars: () => 'bars', getRTHSessionContext: () => 'context',
  savePanelSettings: (...args) => saves.push(args),
  generation: 'must not leak', arbitraryNetwork: () => 'must not leak'
};

function manifest(id, requestedCapabilities, defaultSettings, inspect) {
  return {
    id, name: id, version: '1.0.0', panelApiVersion: 1, dataSchemaVersion: 1,
    description: '', supportedModes: ['demo'], requestedCapabilities, defaultSettings,
    minimumWidth: 0, factory: ({ host, settings: mountedSettings }) => {
      inspect(host, mountedSettings);
      return {};
    }
  };
}

const registry = [
  manifest('blank', [], {}, (host) => {
    assert.equal(host.currentSnapshot, undefined);
    assert.equal(host.getCompletedDailyBars, undefined);
    assert.equal(host.savePanelSettings, undefined);
    assert.equal(host.arbitraryNetwork, undefined);
    assert.equal(typeof host.generation, 'number');
  }),
  manifest('streaming', ['stream', 'formatters'], {}, (host) => {
    assert.equal(host.streamSource(), 'stream');
    assert.equal(host.formatters(), 'formatters');
    assert.equal(host.currentSnapshot, undefined);
    assert.equal(host.getRTHSessionContext, undefined);
  }),
  manifest('configured', ['clock', 'formatters', 'completed-daily-rth-bars', 'settings'], { count: 5, addedLater: true }, (host, mountedSettings) => {
    assert.deepEqual(mountedSettings, { count: 7, addedLater: true });
    assert.deepEqual(host.currentSnapshot(), { symbol: 'AAPL' });
    assert.equal(host.formatters(), 'formatters');
    assert.equal(host.getCompletedDailyBars(), 'bars');
    assert.equal(host.getRTHSessionContext, undefined);
    assert.equal(host.arbitraryNetwork, undefined);
    host.savePanelSettings({ count: 9, undeclared: true });
  })
];

// A panel is handed its own manifest and the host rereads the declared grants on
// every mount, so those declarations must be immutable through that reference.
const declared = validatePanelManifest(manifest('immutable', ['clock'], { count: 1 }, () => {}));
assert.throws(() => declared.requestedCapabilities.push('rth-session-context'), TypeError);
assert.throws(() => declared.supportedModes.push('live'), TypeError);
assert.throws(() => { declared.defaultSettings.smuggled = true; }, TypeError);
assert.deepEqual(declared.requestedCapabilities, ['clock']);
assert.deepEqual(declared.defaultSettings, { count: 1 });

assert.throws(() => new PanelHost({
  root, picker,
  registry: [manifest('unknown-capability', ['arbitrary-network'], {}, () => {})],
  capabilities, settings, saveSettings() {}
}), /unknown capability/);

const panelHost = new PanelHost({ root, picker, registry, capabilities, settings, saveSettings() {} });
panelHost.swap('blank', false);
panelHost.swap('streaming', false);
panelHost.swap('configured', false);

assert.deepEqual(saves, [['configured', { count: 9, undeclared: true }, { count: 5, addedLater: true }]]);
console.log('panel host check: capability isolation, immutable grants, lifecycle guards, settings ownership, and default merging passed');
