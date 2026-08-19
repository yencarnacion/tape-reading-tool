import assert from 'node:assert/strict';
import { PanelHost } from '../internal/server/web/panel-host.js';
import { mergePanelSettings, validatePanelManifest } from '../internal/server/web/panel-api.js';

globalThis.window = {};
globalThis.document = { createElement: () => ({ value: '', textContent: '', append() {}, addEventListener() {} }) };

const root = { className: '', textContent: '', replaceChildren() {}, append() {} };
const picker = { value: '', replaceChildren() {}, addEventListener() {} };
const settings = { slots: { primaryAnalytics: { activePanelId: 'blank' } }, settings: { configured: { count: 7, display: { precision: 3 }, undeclared: true } } };
const saves = [];
const capabilities = {
  currentSnapshot: () => ({ symbol: 'AAPL' }),
  streamSource: () => 'stream', formatters: () => 'formatters',
  getCompletedDailyBars: () => 'bars', getRTHSessionContext: () => 'context',
  savePanelSettings: (...args) => saves.push(args),
  generation: 'must not leak', arbitraryNetwork: () => 'must not leak'
};

// Factories record what they were handed instead of asserting on it. The host
// wraps every lifecycle callback, so an assertion thrown inside a factory is
// caught by the panel error boundary: the check would print "passed" and exit 0
// while proving nothing. Everything is asserted from the script body below, and
// each swap is confirmed to have mounted so a swallowed exception cannot hide.
const mounts = new Map();

function manifest(id, requestedCapabilities, defaultSettings) {
  return {
    id, name: id, version: '1.0.0', panelApiVersion: 1, dataSchemaVersion: 1,
    description: '', supportedModes: ['demo'], requestedCapabilities, defaultSettings,
    minimumWidth: 0, factory: ({ host, settings: mountedSettings }) => {
      mounts.set(id, { host, settings: mountedSettings });
      return {};
    }
  };
}

// A panel is handed its own manifest and the host rereads the declared grants on
// every mount, so those declarations must be immutable through that reference.
const sourceDefaults = { count: 1, display: { precision: 2 }, bands: [1, 2] };
const declared = validatePanelManifest(manifest('immutable', ['clock'], sourceDefaults));
assert.throws(() => declared.requestedCapabilities.push('rth-session-context'), TypeError);
assert.throws(() => declared.supportedModes.push('live'), TypeError);
assert.throws(() => { declared.defaultSettings.smuggled = true; }, TypeError);
assert.throws(() => { declared.defaultSettings.display.precision = 8; }, TypeError);
assert.throws(() => { declared.defaultSettings.bands.push(3); }, TypeError);
assert.deepEqual(declared.requestedCapabilities, ['clock']);
assert.deepEqual(declared.defaultSettings, { count: 1, display: { precision: 2 }, bands: [1, 2] });
sourceDefaults.display.precision = 9;
assert.equal(declared.defaultSettings.display.precision, 2, 'registration must copy, not freeze the caller in place');

// Settings are shaped by the manifest at every depth, in both directions: a field
// added in a later panel version still arrives, a stored field the manifest never
// declared does not, arrays replace rather than accumulate, and an override of the
// wrong shape falls back to the declared value instead of corrupting the panel.
assert.deepEqual(
  mergePanelSettings(
    { count: 5, display: { precision: 2, scale: 'linear' }, bands: [1, 2] },
    { count: 7, display: { precision: 3, smuggled: true }, bands: [9], undeclared: true }
  ),
  { count: 7, display: { precision: 3, scale: 'linear' }, bands: [9] }
);
assert.deepEqual(mergePanelSettings({ count: 5 }, undefined), { count: 5 });
assert.deepEqual(mergePanelSettings({ display: { precision: 2 } }, { display: 'corrupt' }), { display: { precision: 2 } });
assert.deepEqual(mergePanelSettings({}, { anything: true }), {});

assert.throws(() => new PanelHost({
  root, picker,
  registry: [manifest('unknown-capability', ['arbitrary-network'], {})],
  capabilities, settings, saveSettings() {}
}), /unknown capability/);

const registry = [
  manifest('blank', [], {}),
  manifest('streaming', ['stream', 'formatters'], {}),
  manifest('configured', ['clock', 'formatters', 'completed-daily-rth-bars', 'settings'],
    { count: 5, addedLater: true, display: { precision: 2, scale: 'linear' } })
];
const panelHost = new PanelHost({ root, picker, registry, capabilities, settings, saveSettings() {} });
for (const id of ['blank', 'streaming', 'configured']) {
  panelHost.swap(id, false);
  assert.equal(panelHost.active?.id, id, `${id} did not mount; the error boundary caught something`);
  assert.equal(root.className, 'analytics-panel-root', `${id} left the slot in an error state`);
  assert.ok(mounts.has(id), `${id} factory never ran`);
}

// An unrequested capability, and an application capability outside the vocabulary,
// must be absent from the frozen host rather than merely undocumented.
const blank = mounts.get('blank').host;
assert.equal(blank.currentSnapshot, undefined);
assert.equal(blank.getCompletedDailyBars, undefined);
assert.equal(blank.savePanelSettings, undefined);
assert.equal(blank.arbitraryNetwork, undefined);
assert.equal(typeof blank.generation, 'number', 'a capability must not shadow the core generation guard');

const streaming = mounts.get('streaming').host;
assert.equal(streaming.streamSource(), 'stream');
assert.equal(streaming.formatters(), 'formatters');
assert.equal(streaming.currentSnapshot, undefined);
assert.equal(streaming.getRTHSessionContext, undefined);

// `scale` is a field this panel version added after the stored settings were
// written, and `undeclared` is stored but absent from the manifest.
const configured = mounts.get('configured');
assert.deepEqual(configured.settings, { count: 7, addedLater: true, display: { precision: 3, scale: 'linear' } });
assert.throws(() => { configured.settings.display.precision = 8; }, TypeError);
assert.deepEqual(configured.host.currentSnapshot(), { symbol: 'AAPL' });
assert.equal(configured.host.formatters(), 'formatters');
assert.equal(configured.host.getCompletedDailyBars(), 'bars');
assert.equal(configured.host.getRTHSessionContext, undefined);
assert.equal(configured.host.arbitraryNetwork, undefined);

configured.host.savePanelSettings({ count: 9, undeclared: true });
assert.deepEqual(saves, [['configured', { count: 9, undeclared: true }, { count: 5, addedLater: true, display: { precision: 2, scale: 'linear' } }]]);

console.log('panel host check: capability isolation, immutable grants, lifecycle guards, settings ownership, and nested default merging passed');
