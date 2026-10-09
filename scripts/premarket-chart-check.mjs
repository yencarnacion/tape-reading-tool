// End to end: local raw-trade gateway -> production Go server -> browser chart.
// Run: TAPE_BINARY=/tmp/tape-reading-tool CHROME=/path/to/chrome node scripts/premarket-chart-check.mjs
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

assert.ok(process.env.TAPE_BINARY, 'Build the app and set TAPE_BINARY to its path');
const runtime = await mkdtemp(join(tmpdir(), 'tape-premarket-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const priorDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const zone = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', timeZoneName: 'longOffset'})
  .formatToParts(new Date(`${priorDay}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value.replace('GMT', '');
const at = clock => Date.parse(`${priorDay}T${clock}${zone}`);
const seed = {t: at('09:27:00'), o: 117, h: 117.1, l: 116.9, c: 117, v: 1000, vw: 117};
const peers = new Set();
let historyRequests = 0, app, browser, ws, logs = '', childError;
const gateway = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/stream') {
    assert.equal(url.searchParams.get('channels'), 'T,Q');
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    res.write('event: hello\ndata: {"api_version":1,"source":"massive","feed":"realtime"}\n\n');
    peers.add(res);
    req.on('close', () => peers.delete(res));
    return;
  }
  res.writeHead(200, {'Content-Type': 'application/json'});
  if (url.pathname.includes('/aggs/')) {
    historyRequests++;
    res.end(JSON.stringify({results: [seed]}));
  } else if (url.pathname.includes('/snapshot/')) {
    res.end(JSON.stringify({ticker: {prevDay: {c: 117}}}));
  } else res.end('{"results":[]}');
});
const heartbeat = setInterval(() => {
  for (const peer of peers) peer.write('event: heartbeat\ndata: {}\n\n');
}, 1000);

async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) {
    if (childError) throw childError;
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
let next = 1;
const pending = new Map(), errors = [];
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject});
    ws.send(JSON.stringify({id, method, params}));
  });
}
async function evaluate(expression) {
  const value = await command('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
const chart = () => evaluate('window.__tapeReadingChart?.state()');
function trade(clock, p, conditions, size = 100) {
  assert.ok(peers.size, 'gateway stream connected');
  const value = {symbol: 'AAOI', channel: 'T', event_ms: at(clock), data: {p, s: size, c: conditions}};
  for (const peer of peers) peer.write(`event: market\ndata: ${JSON.stringify(value)}\n\n`);
}
function ohlcv(bar) { return ['open', 'high', 'low', 'close', 'volume'].map(k => bar[k]); }
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
try {
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const port = await freePort(), target = `http://127.0.0.1:${port}`;
  const config = join(runtime, 'config.yaml');
  await writeFile(config, 'audio:\n  enabled: false\nstorage:\n  enabled: false\nexternal_replay:\n  enabled: false\n');
  app = spawn(resolve(process.env.TAPE_BINARY), ['live', '-config', config, '-addr', `127.0.0.1:${port}`, '-symbol', 'AAOI', '-chart'], {
    cwd: runtime, env: {PATH: process.env.PATH, MARKET_DATA_PROVIDER: 'massive', MARKET_DATA_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.on('error', e => { childError = e; });
  app.stdout.on('data', b => { logs += b; }); app.stderr.on('data', b => { logs += b; });
  await waitFor(async () => { try { return (await fetch(`${target}/api/health`)).ok && peers.size; } catch { return false; } }, 'app and gateway ready');
  const profile = join(runtime, 'chrome');
  browser = spawn(process.env.CHROME || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-allow-origins=*', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], {stdio: 'ignore'});
  browser.on('error', e => { childError = e; });
  let debug;
  await waitFor(async () => { try { debug = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return Boolean(debug); } catch { return false; } }, 'Chrome ready');
  const page = await (await fetch(`http://127.0.0.1:${debug}/json/new?about:blank`, {method: 'PUT'})).json();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once: true}); ws.addEventListener('error', reject, {once: true}); });
  ws.addEventListener('message', ({data}) => {
    const value = JSON.parse(data);
    if (value.id && pending.has(value.id)) { pending.get(value.id).resolve(value.result); pending.delete(value.id); }
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails);
  });
  await command('Runtime.enable'); await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
  await command('Page.navigate', {url: target});
  await waitFor(async () => (await chart())?.bars.length === 1, 'initial historical candle');
  assert.deepEqual(ohlcv((await chart()).bars[0]), [117, 117.1, 116.9, 117, 1000]);
  assert.ok(historyRequests > 0, 'initial provider history was loaded');

  trade('09:28:00', 117.21, [12]);
  trade('09:28:01', 900, [12, 37], 1);
  trade('09:28:02', 1, [2, 12], 10);
  trade('09:28:03', 117.17, [14, 12, 41]);
  await waitFor(async () => (await chart())?.bars.at(-1)?.close === 117.17, 'first streamed premarket candle after history load');
  assert.deepEqual(ohlcv((await chart()).bars.at(-1)), [117.21, 117.21, 117.17, 117.17, 211]);
  trade('09:29:00', 117.06, [12]);
  trade('09:29:01', 118.81, [14, 12, 41]);
  trade('09:29:02', 117.05, [12]);
  trade('09:29:03', 1, [13], 10);
  trade('09:29:04', 117.30, [12]);
  await waitFor(async () => (await chart())?.bars.at(-1)?.close === 117.30, 'next premarket minute');
  let state = await chart();
  assert.equal(state.bars.length, 3);
  assert.deepEqual(ohlcv(state.bars.at(-1)), [117.06, 118.81, 117.05, 117.30, 410]);
  if (process.env.TAPE_PREMARKET_SCREENSHOT) {
    await waitFor(async () => (await chart())?.scale?.maximum >= 118.81, 'updated candle rendered');
    const screenshot = await command('Page.captureScreenshot', {format: 'png'});
    await writeFile(process.env.TAPE_PREMARKET_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  trade('09:30:00', 999, [12], 10);
  trade('09:30:01', 117.4, [0, 14, 41]);
  trade('09:30:02', 900, [37], 1);
  trade('09:30:03', 117.6, []);
  await waitFor(async () => (await chart())?.bars.at(-1)?.close === 117.6, 'RTH candle');
  state = await chart();
  assert.equal(state.bars.length, 4);
  assert.deepEqual(ohlcv(state.bars.at(-1)), [117.4, 117.6, 117.4, 117.6, 211]);
  trade('16:01:00', 118, [12]);
  trade('16:01:01', 118.1, [14, 12, 41]);
  await waitFor(async () => (await chart())?.bars.at(-1)?.close === 118.1, 'after-hours candle');
  assert.equal((await chart()).bars.length, 5);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('Passed: real gateway/server/browser history load, two new premarket candles, special-report filtering, RTH transition, and after-hours updates.');
} finally {
  ws?.close();
  await stopChild(browser);
  await stopChild(app);
  clearInterval(heartbeat);
  for (const peer of peers) peer.destroy();
  gateway.closeAllConnections();
  await new Promise(r => gateway.close(r));
  await rm(runtime, {recursive: true, force: true});
}
