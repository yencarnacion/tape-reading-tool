// Drives the analytics panel against a real historical replay. Every other check
// on this branch either simulates the replay position or injects panel events
// directly, which is why the no-look-ahead defects on it were all found by
// reading rather than by a test. This one generates a recording, starts the
// application in replay mode against it, and drives the real replay lifecycle.
//
//   node scripts/replay-panel-check.mjs
//
// It manages its own server and recording; nothing needs to be running first.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.CHROME || 'google-chrome';
const httpPort = Number(process.env.REPLAY_CHECK_PORT || 8098);
const devtoolsPort = 9338;
const target = `http://127.0.0.1:${httpPort}`;
const workspace = mkdtempSync(join(tmpdir(), 'tape-reading-tool-replay-'));
const databasePath = join(workspace, 'fixture.db');
const profile = join(workspace, 'chrome');

// Reads whichever of the two exclusive ADR faces is shown, plus the lowest price
// the browser's own tape holds. The running low is expected to sit below it: the
// core owns the session context, and a seek leaves the browser tape starting at
// the seek point.
const READING = `({
  state: document.querySelector('.adr-state:not([hidden]) strong')?.textContent || '',
  value: document.querySelector('.adr-ready:not([hidden]) .adr-value')?.textContent || '',
  percent: document.querySelector('.adr-ready:not([hidden]) .adr-percent')?.textContent || '',
  low: document.querySelector('.adr-ready:not([hidden]) .adr-low')?.textContent || '',
  last: document.querySelector('.adr-ready:not([hidden]) .adr-last')?.textContent || '',
  baseline: document.querySelector('.adr-ready:not([hidden]) .adr-baseline')?.textContent || '',
  history: document.querySelector('.adr-ready:not([hidden]) .adr-history')?.textContent || '',
  clock: document.querySelector('#marketClockTime')?.textContent || '',
  tapeLow: window.__tapeReadingReplayProbe?.tapeLow() ?? null,
  mounts: window.__tapeReadingPanels?.debug()?.mountCount ?? null
})`;


const step = (message) => process.stderr.write(`  replay panel check: ${message}\n`);

let browser;
let server;
let socket;
let nextID = 1;
const pending = new Map();

try {
  step('generating the recording');
  const fixture = await buildFixture();
  step('starting the replay server');
  server = await startServer();
  browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-allow-origins=*', `--remote-debugging-port=${devtoolsPort}`, `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  step('connecting to Chrome');
  const page = await createPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), rejectAfter(5000, 'Chrome DevTools WebSocket did not open')]);
  socket.addEventListener('message', async (event) => {
    let raw = event.data;
    if (raw instanceof Blob) raw = await raw.text();
    if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
    const message = JSON.parse(raw);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  await command('Page.enable');
  await command('Runtime.enable');
  await waitForApp();
  await installProbe();

  step('seeking to a paused mid-session position');
  await drive(fixture, fixture.steadyUS, true).catch(() => {});
  // Selected once, with the replay already positioned. Every seek after this must
  // reach the same mounted panel: a replay generation boundary reloads a panel's
  // data, it does not replace the panel.
  const steady = await selectADR();
  expect('paused mid-session', steady, fixture, fixture.steady);
  // The seek restarted the browser tape at 09:38, so it holds nothing at or below
  // the 09:32 low - often nothing at all, since a pause lands before prints flow.
  // The panel reports that low anyway, which it can only have got from the core.
  if (steady.tapeLow !== null && steady.tapeLow <= Number(fixture.steady.low)) {
    throw new Error(`the running low must come from the core, not the browser tape: ${JSON.stringify(steady)}`);
  }

  // A paused replay is stopped in time; nothing delivered may move the reading.
  await sleep(1200);
  const frozen = await read();
  expect('after holding the pause', frozen, fixture, fixture.steady);

  // Backward across the running low. The low itself must disappear, and the
  // later low the recording holds at 09:45 must not appear in its place.
  step('seeking backward across the running low');
  const backward = await drive(fixture, fixture.beforeLowUS, true);
  expect('after seeking back before the low', backward, fixture, fixture.beforeLow);
  if (backward.mounts !== steady.mounts) {
    throw new Error(`a seek must not remount the panel: ${steady.mounts} then ${backward.mounts}`);
  }

  step('seeking forward again');
  const forward = await drive(fixture, fixture.steadyUS, true);
  expect('after seeking forward again', forward, fixture, fixture.steady);

  // Reload at a paused position. The browser clock cannot be extrapolated across
  // this: the position must come from the snapshot the server stamps.
  step('reloading while paused');
  await command('Page.reload', { ignoreCache: true });
  await waitForApp();
  await installProbe();
  await selectADR();
  const reloaded = await read();
  expect('after reloading while paused', reloaded, fixture, fixture.steady);
  if (!reloaded.clock.startsWith('09:38:')) {
    throw new Error(`a reload while paused must restore the replay position, not extrapolate: ${JSON.stringify(reloaded)}`);
  }

  // Only once the replay reaches it may the later low change the reading.
  step('advancing past the later low');
  const afterLow = await drive(fixture, fixture.afterLowUS, true);
  if (afterLow.low !== '$95.00' || afterLow.value === fixture.steady.value) {
    throw new Error(`the 09:45 low must appear once the position passes it: ${JSON.stringify(afterLow)}`);
  }

  console.log('replay panel check: real replay seek, pause, reload, and no-look-ahead passed');
} finally {
  socket?.close();
  browser?.kill();
  server?.kill('SIGKILL');
  // Chrome unlinks its profile asynchronously, and a cleanup failure here would
  // otherwise replace whatever the check was actually reporting.
  await sleep(250);
  try { rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
}

function expect(label, reading, fixture, want) {
  const failure = (why) => { throw new Error(`${label}: ${why}: ${JSON.stringify(reading)}`); };
  if (reading.state) failure(`panel is not showing a reading (${reading.state})`);
  if (reading.value !== want.value || reading.percent !== want.percent) failure('wrong extension');
  if (reading.low !== `$${want.low}` || reading.last !== `$${want.last}`) failure('wrong low or last');
  if (reading.baseline !== fixture.baseline || reading.history !== fixture.history) failure('wrong baseline');
}

async function drive(fixture, targetUS, pause) {
  await evaluate(`(async () => {
    const post = (body) => fetch('/api/replay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!window.__tapeReadingReplayStarted) {
      await post({ action: 'start', symbol: ${JSON.stringify(fixture.symbol)}, source: ${JSON.stringify(fixture.source)},
        provider: ${JSON.stringify(fixture.provider)}, start_us: ${fixture.startUS}, end_us: ${fixture.endUS}, speed: 0.25 });
      window.__tapeReadingReplayStarted = true;
    }
    await post({ action: 'seek', target_us: ${targetUS} });
    ${pause ? `await post({ action: 'pause' });` : ''}
  })()`, true);
  return readStable();
}

// A seek leaves the previous reading on screen while the panel reloads, so the
// check waits for the reading to stop changing rather than for anything to be
// displayed. A paused replay settles; if it never does, the last reading is
// reported instead of a bare timeout.
async function readStable() {
  let previous = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const reading = await read();
    if (previous && reading.value && sameReading(previous, reading)) return reading;
    previous = reading;
    await sleep(250);
  }
  throw new Error(`the panel never settled: ${JSON.stringify(previous)}`);
}

function sameReading(left, right) {
  return ['state', 'value', 'percent', 'low', 'last', 'baseline', 'history']
    .every((field) => left[field] === right[field]);
}

async function selectADR() {
  await evaluate(`window.__tapeReadingPanels.swap('adr-rth-extension')`);
  return readStable();
}

async function read() {
  const result = await command('Runtime.evaluate', { expression: READING, returnByValue: true });
  return result.result.value;
}

// The browser's own retained tape, which a seek restarts at the seek point.
function installProbe() {
  return evaluate(`window.__tapeReadingReplayProbe = { tapeLow: () => {
    const prices = [...document.querySelectorAll('#tapeRows .tape-row:not([hidden]) span:first-child')]
      .map((cell) => Number(cell.textContent)).filter((price) => price > 0);
    return prices.length ? Math.min(...prices) : null;
  } }`);
}

async function evaluate(expression, awaitPromise = false) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, 20000);
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  return result.result.value;
}

function buildFixture() {
  return new Promise((resolve, reject) => {
    const build = spawn('go', ['run', './scripts/replay-fixture', '-db', databasePath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    build.stdout.on('data', (chunk) => { output += chunk; });
    build.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`replay fixture generation failed with code ${code}`));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

// Built rather than `go run`, so killing the child actually stops the server:
// `go run` does not forward a kill to the binary it spawned, and the port would
// stay held for the next run.
function buildServer() {
  return new Promise((resolve, reject) => {
    const binary = join(workspace, 'tape-reading-tool');
    const build = spawn('go', ['build', '-buildvcs=false', '-o', binary, './cmd/tape-reading-tool'], { stdio: ['ignore', 'ignore', 'inherit'] });
    build.on('exit', (code) => code === 0 ? resolve(binary) : reject(new Error(`server build failed with code ${code}`)));
  });
}

async function startServer() {
  const binary = await buildServer();
  const process_ = spawn(binary, ['replay',
    '-db', databasePath, '-addr', `127.0.0.1:${httpPort}`,
    '-symbol', 'AAPL', '-source', 'historical', '-provider', 'massive'], { stdio: ['ignore', 'ignore', 'inherit'] });
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(500) });
      if (response.ok) return process_;
    } catch (_) {}
    await sleep(250);
  }
  process_.kill('SIGKILL');
  throw new Error('the replay server did not start');
}

function command(method, params = {}, timeout = 10000) {
  const id = nextID++;
  return Promise.race([new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  }), rejectAfter(timeout, `Chrome DevTools command timed out: ${method}`)]);
}

async function createPage() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
      if (response.ok) return await response.json();
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function waitForApp() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await command('Runtime.evaluate', {
      expression: `Boolean(document.querySelector('#chartCanvas')) && Boolean(window.__tapeReadingPanels)`,
      returnByValue: true
    });
    if (result.result.value) return;
    await sleep(125);
  }
  throw new Error('the application did not become ready');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}
