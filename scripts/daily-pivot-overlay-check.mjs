import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pivotSource = await readFile(new URL('../internal/server/web/daily-pivots.js', import.meta.url), 'utf8');
const pivotURL = `data:text/javascript;base64,${Buffer.from(pivotSource).toString('base64')}`;
let overlaySource = await readFile(new URL('../internal/server/web/daily-pivot-overlay.js', import.meta.url), 'utf8');
overlaySource = overlaySource.replace("from './daily-pivots.js';", `from '${pivotURL}';`);
const overlayURL = `data:text/javascript;base64,${Buffer.from(overlaySource).toString('base64')}`;

const elements = new Map([
  ['tickerInput', { value: 'AAPL' }],
  ['lastPrice', { textContent: '100.01' }]
]);
const calls = [];
const listeners = new Map();

function jsonResponse(payload, ok = true) {
  return {
    ok,
    async json() { return structuredClone(payload); },
    async text() { return ok ? JSON.stringify(payload) : 'request failed'; },
    clone() { return jsonResponse(payload, ok); }
  };
}

function priorWeekday(before) {
  const date = new Date(`${before}T12:00:00Z`);
  do { date.setUTCDate(date.getUTCDate() - 1); } while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}

async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url, 'http://localhost/');
  calls.push({ path: url.pathname, search: url.search, init });
  if (url.pathname === '/api/panel-data/daily-bars') {
    const before = url.searchParams.get('before');
    return jsonResponse({
      status: 'ready', beforeSessionDateET: before,
      bars: [{ complete: true, sessionDateET: priorWeekday(before), high: 110, low: 90, close: 100 }]
    });
  }
  if (url.pathname === '/api/replay') {
    return jsonResponse({ chart_end_us: Date.UTC(2024, 5, 14, 14, 0, 0) * 1000 });
  }
  if (url.pathname === '/api/ticker') return jsonResponse({ symbol: elements.get('tickerInput').value });
  throw new Error(`unexpected request ${url}`);
}

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.operations = [];
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.font = '';
  }
  save() { this.operations.push(['save']); }
  restore() { this.operations.push(['restore']); }
  setTransform(...args) { this.operations.push(['transform', ...args]); }
  setLineDash(value) { this.operations.push(['dash', ...value]); }
  beginPath() { this.operations.push(['begin']); }
  moveTo(...args) { this.operations.push(['move', ...args]); }
  lineTo(...args) { this.operations.push(['line', ...args]); }
  stroke() { this.operations.push(['stroke', this.strokeStyle, this.globalAlpha]); }
  fillRect(...args) { this.operations.push(['rect', this.fillStyle, this.globalAlpha, ...args]); }
  fillText(text, x, y) { this.operations.push(['text', String(text), x, y, this.fillStyle]); }
  measureText(text) { return { width: String(text).length * 6 }; }
}

globalThis.CanvasRenderingContext2D = FakeCanvasContext;
globalThis.document = { getElementById: (id) => elements.get(id) || null };
globalThis.location = { href: 'http://localhost/' };
globalThis.window = {
  fetch: mockFetch,
  devicePixelRatio: 1,
  setInterval: () => 1,
  addEventListener: (type, callback) => listeners.set(type, callback)
};

await import(overlayURL);

async function until(predicate, message) {
  for (let index = 0; index < 30; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

await until(() => window.__tapeReadingDailyPivots.state().status === 'ready', 'initial pivots did not load');
const initial = window.__tapeReadingDailyPivots.state();
assert.equal(initial.symbol, 'AAPL');
assert.equal(initial.levels.find((level) => level.key === 'PP').price, 100);
assert.deepEqual(initial.targets, ['replayChartCanvas'], 'tick and rewind canvases must not receive pivots');
assert.ok(calls.some((call) => call.path === '/api/panel-data/daily-bars' && call.search.includes('limit=1')));

const tickCanvas = { id: 'chartCanvas', getBoundingClientRect: () => ({ width: 800 }) };
const tickContext = new CanvasRenderingContext2D(tickCanvas);
tickContext.fillStyle = '#8d96a2';
[102, 101, 100, 99, 98].forEach((price, index) => tickContext.fillText(price.toFixed(2), 753, 20 + index * 20));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(tickContext.operations.some((operation) => operation[0] === 'stroke'), false,
  'the tick chart must remain pivot-free');

const regularCanvas = { id: 'replayChartCanvas', getBoundingClientRect: () => ({ width: 800 }) };
const regularContext = new CanvasRenderingContext2D(regularCanvas);
regularContext.fillStyle = '#8d96a2';
[135, 117.5, 100, 82.5, 65].forEach((price, index) => regularContext.fillText(price.toFixed(2), 753, 20 + index * 25));
await new Promise((resolve) => setImmediate(resolve));
const pivotText = regularContext.operations
  .filter((operation) => operation[0] === 'text')
  .map((operation) => operation[1]);
assert.ok(regularContext.operations.some((operation) => operation[0] === 'stroke'), 'regular-chart pivot guides were not drawn');
assert.ok(pivotText.some((text) => text.startsWith('NEAR PP 100.00')),
  'near pivot was not identified');
assert.ok(pivotText.some((text) => text.startsWith('↑ R1 110.00')),
  'next pivot above the near pivot was not identified');
assert.ok(pivotText.some((text) => text.startsWith('↓ S1 90.00')),
  'next pivot below the near pivot was not identified');
assert.ok(pivotText.some((text) => text.startsWith('↑ R2 120.00')),
  'second pivot above price was not identified');
assert.equal(pivotText.some((text) => /^R2|^R3|^S2|^S3/.test(text)), false,
  'non-context pivots should not be labeled');

// The real header is painted above the canvas. Check the full label backing,
// including a wrapped legend and the optional GEX row, in canvas coordinates.
const canvasTop = 120;
const chrome = (top, bottom, hidden = false, width = 450) => ({
  hidden,
  getBoundingClientRect: () => ({ top: canvasTop + top, bottom: canvasTop + bottom,
    width, height: bottom - top })
});
async function labelFrame(controls, maximum = 105, blockedY = null) {
  const canvas = {
    id: 'replayChartCanvas',
    getBoundingClientRect: () => ({ width: 800, top: canvasTop }),
    parentElement: { querySelectorAll: () => controls }
  };
  const context = new CanvasRenderingContext2D(canvas);
  context.fillStyle = '#8d96a2';
  for (let index = 0; index <= 4; index++) {
    context.fillText((maximum - (maximum - 95) * index / 4).toFixed(2), 753, 25 + 375 * index / 4);
  }
  if (blockedY !== null) context.fillText('AVG 100.00', 14, blockedY);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    context,
    labels: context.operations.filter((operation) => operation[0] === 'text' &&
      /^(?:↑|↓|AT |NEAR )/.test(operation[1]))
  };
}
const noChrome = await labelFrame([]);
const lowerBefore = noChrome.labels.find((label) => label[1].startsWith('↓ S1'))[3];
for (const [name, controls, bottom] of [
  ['legend', [chrome(5, 27), chrome(31, 51)], 51],
  ['GEX', [chrome(5, 27), chrome(31, 51), chrome(55, 79)], 79],
  ['wrapped legend and compact GEX', [chrome(5, 27), chrome(31, 68), chrome(72, 96)], 96],
  ['hidden controls', [chrome(5, 27), chrome(31, 51), chrome(55, 200, true)], 51],
  ['zero-size controls', [chrome(5, 27), chrome(31, 51), chrome(55, 200, false, 0)], 51]
]) {
  const { labels } = await labelFrame(controls);
  assert.equal(labels.length, 4, `${name}: keep both upper and both lower context levels`);
  const upper = labels.filter((label) => label[1].startsWith('↑'));
  assert.equal(upper.length, 2);
  assert.ok(upper.every((label) => label[3] - 8.5 >= bottom + 2), `${name}: upper labels clear DOM chrome`);
  assert.equal(labels.find((label) => label[1].startsWith('↓ S1'))[3], lowerBefore,
    `${name}: lower edge placement stays unchanged`);
}
const inView = await labelFrame([chrome(5, 27), chrome(31, 68), chrome(72, 96)], 125);
assert.ok(inView.labels.find((label) => label[1].startsWith('↑ R2'))[3] - 8.5 >= 98,
  'an in-view upper pivot label also clears the header');
assert.ok(inView.context.operations.some((operation) => operation[0] === 'move' &&
  operation[1] === 7 && operation[2] === 87.5), 'the R2 guide keeps its true price coordinate');
const blocked = await labelFrame([chrome(31, 51)], 105, 63);
assert.ok(blocked.labels.every((label) => Math.abs(label[3] - 63) >= 16),
  'position labels still reserve space after adding header clearance');

await window.fetch('/api/replay');
await until(() => window.__tapeReadingDailyPivots.state().sessionDateET === '2024-06-14', 'replay date was not adopted');
assert.ok(calls.some((call) => call.path === '/api/panel-data/daily-bars' && call.search.includes('before=2024-06-14')),
  'replay pivots were not requested relative to the replay session');

elements.get('tickerInput').value = 'MSFT';
window.__tapeReadingDailyPivots.refresh();
await until(() => window.__tapeReadingDailyPivots.state().symbol === 'MSFT' && window.__tapeReadingDailyPivots.state().status === 'ready',
  'ticker switch did not refresh pivots');

listeners.get('pagehide')?.();
console.log('daily pivot overlay checks passed');
