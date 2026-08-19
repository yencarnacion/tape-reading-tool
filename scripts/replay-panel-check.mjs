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

  const aapl = fixture.readings.AAPL;
  const nvda = fixture.readings.NVDA;

  step('seeking to a paused mid-session position');
  await position(fixture, fixture.lateSteadyUS);
  // Selected once, with the replay already positioned. Every seek after this must
  // reach the same mounted panel: a replay generation boundary reloads a panel's
  // data, it does not replace the panel.
  const steady = await selectADR();
  expect('paused mid-session', steady, aapl, aapl.late);
  await expectPreviousSessionInBaseline(fixture, 'AAPL');
  // The seek restarted the browser tape at 09:38, so it holds nothing at or below
  // the 09:32 low - often nothing at all, since a pause lands before prints flow.
  // The panel reports that low anyway, which it can only have got from the core.
  if (steady.tapeLow !== null && steady.tapeLow <= Number(aapl.late.low)) {
    throw new Error(`the running low must come from the core, not the browser tape: ${JSON.stringify(steady)}`);
  }

  // A paused replay is stopped in time; nothing delivered may move the reading.
  await sleep(1200);
  const frozen = await read();
  expect('after holding the pause', frozen, aapl, aapl.late);

  // Backward across the running low. The low itself must disappear, and the
  // later low the recording holds at 09:45 must not appear in its place.
  step('seeking backward across the running low');
  const backward = await drive(fixture, fixture.lateBeforeLowUS);
  expect('after seeking back before the low', backward, aapl, {
    ...fixture.beforeLow, low: aapl.late.last, last: aapl.late.last
  });
  if (backward.mounts !== steady.mounts) {
    throw new Error(`a seek must not remount the panel: ${steady.mounts} then ${backward.mounts}`);
  }

  // Backward across a session boundary. The panel derives its session from the
  // clock and the core answers for the replay position's own session, so this is
  // where the two have to agree or the reading is for the wrong day.
  step('seeking backward into the previous session');
  const previousSession = await drive(fixture, fixture.earlySteadyUS);
  expect('after seeking into the previous session', previousSession, aapl, aapl.early);

  step('seeking forward again');
  const forward = await drive(fixture, fixture.lateSteadyUS);
  expect('after seeking forward again', forward, aapl, aapl.late);

  // A ticker change mid-replay is a generation boundary too. The other symbol's
  // baseline and reading are entirely different, so a stale answer is visible.
  step('changing symbol mid-replay');
  const switched = await changeSymbol('NVDA');
  expect('after changing symbol mid-replay', switched, nvda, nvda.late);
  const restored = await changeSymbol('AAPL');
  expect('after changing back', restored, aapl, aapl.late);

  // Reload at a paused position. The browser clock cannot be extrapolated across
  // this: the position must come from the snapshot the server stamps.
  step('reloading while paused');
  await command('Page.reload', { ignoreCache: true });
  await waitForApp();
  await installProbe();
  await selectADR();
  const reloaded = await read();
  expect('after reloading while paused', reloaded, aapl, aapl.late);
  if (!reloaded.clock.startsWith('09:38:')) {
    throw new Error(`a reload while paused must restore the replay position, not extrapolate: ${JSON.stringify(reloaded)}`);
  }

  // Only once the replay reaches it may the later low change the reading.
  step('advancing past the later low');
  const afterLow = await drive(fixture, fixture.lateAfterLowUS);
  expect('after advancing past the later low', afterLow, aapl, aapl.after);

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

function expect(label, reading, instrument, want) {
  const failure = (why) => { throw new Error(`${label}: ${why}: ${JSON.stringify(reading)}`); };
  if (reading.state) failure(`panel is not showing a reading (${reading.state})`);
  if (reading.value !== want.value || reading.percent !== want.percent) failure('wrong extension');
  if (reading.low !== `$${want.low}` || reading.last !== `$${want.last}`) failure('wrong low or last');
  if (reading.baseline !== instrument.baseline || reading.history !== instrument.history) failure('wrong baseline');
}

// The ticker field's own path, so the check exercises what a trader does rather
// than a shortcut the application does not use.
async function changeSymbol(symbol) {
  await evaluate(`fetch('/api/ticker', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: ${JSON.stringify(symbol)} })
  }).then((response) => response.ok || Promise.reject(new Error('ticker change failed')))`, true);
  return readStable();
}

async function drive(fixture, targetUS) {
  await position(fixture, targetUS);
  return readStable();
}

// Starts the replay once, then seeks and pauses. Every response is checked: a
// rejected seek would otherwise look like a panel that simply never updated.
function position(fixture, targetUS) {
  return evaluate(`(async () => {
    const post = async (body) => {
      const response = await fetch('/api/replay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(body.action + ' failed: ' + (await response.text()).trim());
      return response.json();
    };
    const pause = async (atUS) => {
      let lastError;
      for (let attempt = 0; attempt <= 20; attempt++) {
        try {
          const status = await post({ action: 'pause' });
          if (status.state === 'paused') return;
          lastError = new Error('pause returned ' + JSON.stringify(status));
        } catch (error) {
          lastError = error;
          // This endpoint reads Replay.Status directly and does not touch the
          // recording. It distinguishes a transport race from a replay that
          // genuinely completed or failed before it could be paused.
          const response = await fetch('/api/external-replay/status', { cache: 'no-store' });
          if (response.ok) {
            const status = (await response.json()).replay;
            if (status?.state === 'paused') return;
            if (status?.state && status.state !== 'replaying') {
              throw new Error('replay reached ' + status.state + ' while pausing at ' + atUS + ': ' + (status.message || lastError));
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('replay never paused at ' + atUS + ': ' + String(lastError));
    };
    if (!window.__tapeReadingReplayStarted) {
      await post({ action: 'start', symbol: window.__tapeReadingPanels.symbol(), source: ${JSON.stringify(fixture.source)},
        provider: ${JSON.stringify(fixture.provider)}, start_us: ${fixture.startUS}, end_us: ${fixture.endUS}, speed: 0.25 });
      // Stop the initial play loop before launching the seek generation. This
      // avoids overlapping two recording cursors during the first positioning.
      await pause(${targetUS});
      window.__tapeReadingReplayStarted = true;
    }
    await post({ action: 'seek', target_us: ${targetUS} });
    // The replay resumes playing from a seek, so the pause races the play loop.
    // Retry the transport action itself. GET /api/replay is a range-and-chart
    // request, not a lightweight status endpoint; polling it here made transient
    // database errors get parsed as JSON and hid the actual pause result.
    await pause(${targetUS});
  })()`, true);
}

// The fixture promises that the earlier replay session becomes one of the
// later session's completed ADR inputs. Assert the actual API membership rather
// than accepting the same round baseline from the twenty older seed sessions.
async function expectPreviousSessionInBaseline(fixture, symbol) {
  const history = await evaluate(`fetch('/api/panel-data/daily-bars?' + new URLSearchParams({
    symbol: ${JSON.stringify(symbol)}, before: ${JSON.stringify(fixture.lateSessionDateET)}, limit: '20'
  })).then(async (response) => {
    if (!response.ok) throw new Error((await response.text()).trim() || 'daily history request failed');
    return response.json();
  })`, true);
  if (!history.bars?.some((bar) => bar.sessionDateET === fixture.earlySessionDateET)) {
    throw new Error(`the earlier replay session is missing from the later ADR baseline: ${JSON.stringify(history)}`);
  }
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
