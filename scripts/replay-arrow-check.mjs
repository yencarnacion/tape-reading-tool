import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const target = process.argv[2] || 'http://127.0.0.1:8097';
const port = 9341;
const profile = `/tmp/tape-replay-arrow-${process.pid}`;
mkdirSync(profile, { recursive: true });

const chrome = spawn(process.env.CHROME || 'google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-allow-origins=*',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: 'ignore' });

let socket;
let nextID = 1;
const pending = new Map();
const errors = [];

try {
  const page = await createPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      errors.push(details.exception?.description || details.text);
    }
    if (!message.id || !pending.has(message.id)) return;
    const operation = pending.get(message.id);
    pending.delete(message.id);
    message.error ? operation.reject(new Error(message.error.message)) : operation.resolve(message.result);
  });
  await command('Runtime.enable');
  await command('Page.enable');
  await sleep(1200);

  await evaluate(`fetch('/api/replay', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      action:'start', symbol:'MRVL', provider:'massive', source:'historical',
      start_us:1784899740000000, end_us:1784923199940321, speed:1
    })
  }).then(async response => {
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  })`, true);
  await sleep(6500);

  const before = await snapshot();
  const transientBlanks = await evaluate(`new Promise(resolve => {
    document.activeElement?.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true}));
    const blanks = [];
    const started = performance.now();
    const timer = setInterval(() => {
      const frame = {
        last: document.querySelector('#lastPrice')?.textContent,
        bid: document.querySelector('#bestBid')?.textContent,
        ask: document.querySelector('#bestAsk')?.textContent,
        maxDelta: document.querySelector('#maxDelta')?.textContent,
        minDelta: document.querySelector('#minDelta')?.textContent
      };
      if (frame.last === '--' || frame.bid === '--' || frame.ask === '--') blanks.push(frame);
      if (performance.now() - started >= 1200) {
        clearInterval(timer);
        resolve(blanks);
      }
    }, 10);
  })`, true);
  await sleep(400);
  const after = await snapshot();

  if (after.positionUS <= before.positionUS) {
    throw new Error(`primary replay stopped advancing during rewind: before=${before.positionUS} after=${after.positionUS}`);
  }
  if (after.state !== 'replaying' || after.bid === '--' || after.ask === '--' || after.tapeRows === 0) {
    throw new Error(`replay did not repopulate after rewind: ${JSON.stringify({ before, after, transientBlanks, errors })}`);
  }
  if (!after.rewind?.active || !after.rewind?.playing || after.rewind?.speed !== 0.25 ||
      after.rewind?.behindSeconds < 4) {
    throw new Error(`independent rewind pane did not play at 0.25x: ${JSON.stringify(after.rewind)}`);
  }
  if (transientBlanks.length) throw new Error(`rewind painted blank metrics: ${JSON.stringify(transientBlanks[0])}`);
  if (errors.length) throw new Error(`browser exceptions: ${errors.join('; ')}`);
  console.log(JSON.stringify({
    before, after, transient_blanks: transientBlanks.length,
    primary_advanced_seconds: (after.positionUS - before.positionUS) / 1e6
  }));
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await sleep(250);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_) {}
}

async function snapshot() {
  return evaluate(`fetch('/api/replay?symbol=MRVL&source=historical&provider=massive')
    .then(response => response.json())
    .then(payload => ({
      state: payload.replay.state,
      positionUS: payload.replay.position_us,
      clock: document.querySelector('#marketClockTime')?.textContent,
      bid: document.querySelector('#bestBid')?.textContent,
      ask: document.querySelector('#bestAsk')?.textContent,
      tapeRows: [...document.querySelectorAll('#tapeRows .tape-row')]
        .filter(row => !row.hidden && row.textContent.trim()).length,
      chartEmpty: document.querySelector('#replayChartEmpty')?.textContent,
      rewind: window.__tapeReadingRewind?.state()
    }))`, true);
}

async function createPage() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
      if (response.ok) return response.json();
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextID++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
