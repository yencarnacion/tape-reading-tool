// Run against demo -chart. Exercises real ticker entry and history navigation,
// then injects WebSocket snapshots to check quiet and active premarket opens.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2] || 'http://127.0.0.1:8107';
const port = 9347;
const profile = mkdtempSync(join(tmpdir(), 'tape-day-map-chrome-'));
const browser = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-allow-origins=*',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
let launchOutput = '';
browser.stderr.on('data', (data) => { launchOutput = (launchOutput + data).slice(-2000); });
let socket, nextID = 1;
const pending = new Map(), errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextID++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const value = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(`Did not settle: ${expression}`);
}
const reading = () => evaluate(`({
  symbol: window.__tapeReadingPanels.symbol(),
  daily: document.querySelector('#dayContextDaily').getAttribute('aria-pressed'),
  intraday: document.querySelector('#dayContextIntraday').getAttribute('aria-pressed'),
  title: document.querySelector('#dayContextTitle').textContent,
  sessions: document.querySelector('#dayContextSession').textContent,
  relation: document.querySelector('#dayContextPosition').textContent,
  description: document.querySelector('#dayContext').getAttribute('aria-label'),
  corner: document.querySelector('#dayContext').dataset.corner,
  labels: window.__dayMapLabels
})`);
async function expectDaily(symbol) {
  await until(`window.__tapeReadingPanels?.symbol() === ${JSON.stringify(symbol)} && document.querySelector('#dayContextSession').textContent === '60 SESSIONS' && document.querySelector('#dayContextPosition').textContent.includes('20D') && document.querySelector('#dayContextPosition').textContent !== '20D SMA --'`);
  const value = await reading();
  assert.equal(value.daily, 'true'); assert.equal(value.intraday, 'false');
  assert.equal(value.title, 'DAILY MAP');
  assert.ok(value.labels.includes('20D SMA'));
}
async function selectIntraday() {
  const before = (await reading()).corner;
  await evaluate(`document.querySelector('#dayContextIntraday').click()`);
  await until(`document.querySelector('#dayContextTitle').textContent === 'DAY MAP'`);
  const value = await reading();
  assert.equal(value.intraday, 'true'); assert.equal(value.daily, 'false');
  assert.equal(value.corner, before, 'toggle must not also move the preview');
}

try {
  const reset = await fetch(`${target}/api/ticker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'AAPL' }) });
  assert.ok(reset.ok, 'demo ticker reset failed');
  let page;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); break; }
    catch { await sleep(100); }
  }
  assert.ok(page, `Chrome did not start: ${launchOutput}`);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id); pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
  });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1372, height: 1080, deviceScaleFactor: 1, mobile: false });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__dayMapLabels = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.id === 'dayContextCanvas' && args[0] === 0 && args[1] === 0) window.__dayMapLabels = [];
      return fillRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === 'dayContextCanvas') window.__dayMapLabels.push(String(args[0]));
      return fillText.apply(this, args);
    };
    const messageProperty = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      ...messageProperty,
      set(callback) {
        messageProperty.set.call(this, function (event) {
          if (window.__freezeDayMapFeed && event.isTrusted) return;
          const payload = JSON.parse(event.data);
          if (payload.type === 'snapshot') window.__dayMapSnapshot = payload;
          callback.call(this, event);
        });
      }
    });
  ` });
  await command('Page.navigate', { url: target });
  await expectDaily('AAPL');
  await selectIntraday();
  await sleep(300);
  assert.equal((await reading()).intraday, 'true', 'price updates preserve the selected timeframe');
  await evaluate(`document.querySelector('#tickerInput').value = 'MSFT'; document.querySelector('#tickerForm').requestSubmit()`);
  await expectDaily('MSFT');
  await selectIntraday();
  await evaluate(`document.querySelector('#historyBack').click()`);
  await expectDaily('AAPL');
  await selectIntraday();
  await evaluate(`document.querySelector('#historyForward').click()`);
  await expectDaily('MSFT');
  await selectIntraday();
  await evaluate(`document.querySelector('#historySelect').value = 'AAPL'; document.querySelector('#historySelect').dispatchEvent(new Event('change'))`);
  await expectDaily('AAPL');
  await selectIntraday();
  await evaluate(`fetch('/api/ticker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({symbol:'NVDA'}) })`);
  await expectDaily('NVDA');

  for (const width of [902, 1372, 1920]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const layout = await evaluate(`(() => {
      const map = document.querySelector('#dayContext');
      const nav = map.querySelector('nav'); const button = nav.querySelector('button');
      return { overflow: map.scrollWidth - map.clientWidth, navBottom: nav.getBoundingClientRect().bottom,
        mapBottom: map.getBoundingClientRect().bottom, buttonBottom: button.getBoundingClientRect().bottom };
    })()`);
    assert.equal(layout.overflow, 0, `preview overflows at ${width}px`);
    assert.ok(layout.buttonBottom <= layout.navBottom + .5 && layout.navBottom <= layout.mapBottom + .5, `toggle fits below the chart: ${JSON.stringify(layout)}`);
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1372, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.__freezeDayMapFeed = true; window.__injectDayMap = (symbol, price, quoteOnly = false) => {
    const snapshot = structuredClone(window.__dayMapSnapshot);
    const timeMS = Date.parse('2026-09-30T08:00:00-04:00');
    snapshot.server_time_ms = timeMS;
    snapshot.symbol = snapshot.snapshot.symbol = symbol;
    snapshot.snapshot.status = {mode:'demo', state:'live', connected:true};
    snapshot.snapshot.quote = {bid:price-.01, ask:price+.01};
    snapshot.snapshot.trades = quoteOnly ? [] : [{s:1, t:timeMS, r:timeMS*1000, p:price, z:100, c:'ask', d:1}];
    window.__tapeReadingPanels.socket().dispatchEvent(new MessageEvent('message', {data:JSON.stringify(snapshot)}));
  }; window.__injectDayMap('AMD', 60);`);
  await expectDaily('AMD');
  await until(`window.__dayMapLabels.includes('PRE 60.00')`);
  assert.equal((await reading()).relation, 'ABOVE 20D');
  await selectIntraday();
  await evaluate(`window.__injectDayMap('AMD', 60)`);
  await sleep(100);
  assert.equal((await reading()).intraday, 'true', 'same-ticker snapshot preserves intraday');
  await evaluate(`document.querySelector('#dayContextDaily').click(); window.__injectDayMap('AMD', 30)`);
  await until(`window.__dayMapLabels.includes('PRE 30.00')`);
  assert.equal((await reading()).relation, 'BELOW 20D');
  await evaluate(`window.__injectDayMap('AMZN', 60, true)`);
  await expectDaily('AMZN');
  await until(`window.__dayMapLabels.includes('PRE MID 60.00')`);
  assert.match((await reading()).description, /premarket bid\/ask midpoint/);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/tape-day-map-preview.png', Buffer.from(screenshot.data, 'base64'));
  const corners = await evaluate(`(() => {
    const map = document.querySelector('#dayContext'); const corners = [map.dataset.corner];
    for (let index=0; index<4; index++) { map.querySelector('canvas').click(); corners.push(map.dataset.corner); }
    return corners;
  })()`);
  assert.deepEqual(corners, ['upper-left', 'lower-left', 'lower-right', 'upper-right', 'upper-left']);
  assert.deepEqual(errors, [], 'browser must remain free of uncaught errors');
  console.log('daily map browser checks passed: all ticker routes, toggles, layout, and premarket price markers');
} finally {
  socket?.close();
  if (browser.exitCode === null && browser.signalCode === null) {
    browser.kill('SIGTERM');
    await new Promise((resolve) => browser.once('exit', resolve));
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
