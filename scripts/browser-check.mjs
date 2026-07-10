import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const chrome = process.env.CHROME || 'google-chrome';
const target = process.argv[2] || 'http://127.0.0.1:8097';
const port = 9337;
const profile = `/tmp/tape-reading-tool-chrome-${process.pid}`;
mkdirSync(profile, { recursive: true });

const browser = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  '--remote-allow-origins=*', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore'] });

let socket;
let nextID = 1;
const pending = new Map();

try {
  const page = await createPage();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), rejectAfter(5000, 'Chrome DevTools WebSocket did not open')]);
  socket.addEventListener('message', async (event) => {
    try {
      let raw = event.data;
      if (raw instanceof Blob) raw = await raw.text();
      if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
      const message = JSON.parse(raw);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } catch (error) {
      console.error('DevTools message:', error);
    }
  });
  await command('Page.enable');
  await command('Runtime.enable');

  const results = [];
  for (const width of [384, 634]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    await waitForApp();
    if (width === 384) {
      const button = await command('Runtime.evaluate', {
        expression: `(() => { const r = document.querySelector('#soundButton').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        returnByValue: true
      });
      const point = button.result.value;
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await sleep(700);
    }
    const inspection = await command('Runtime.evaluate', {
      expression: `(() => {
        const canvas = document.querySelector('#chartCanvas');
        const rows = [...document.querySelectorAll('.tape-row')].filter(row => !row.hidden);
        const pixels = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data || [];
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 64) {
          if (pixels[i] > 30 || pixels[i + 1] > 30 || pixels[i + 2] > 30) colored++;
        }
        return {
          href: location.href,
          title: document.title,
          readyState: document.readyState,
          width: innerWidth,
          bodyWidth: document.body.scrollWidth,
          last: document.querySelector('#lastPrice')?.textContent,
          maxDelta: document.querySelector('#maxDelta')?.textContent,
          minDelta: document.querySelector('#minDelta')?.textContent,
          visibleTapeRows: rows.length,
          coloredCanvasSamples: colored,
          socketState: document.querySelector('#connectionState span')?.textContent,
          soundState: document.querySelector('#soundButton')?.textContent
        };
      })()`,
      returnByValue: true
    });
    console.error(`browser check ${width}px:`, JSON.stringify(inspection.result.value));
    await command('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 20000);
    const path = `/tmp/tape-reading-tool-${width}.png`;
    writeFileSync(path, Buffer.from(screenshot.data, 'base64'));
    results.push({ ...inspection.result.value, screenshot: path });
    await command('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 1 });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { socket?.close(); } catch (_) {}
  browser.kill('SIGTERM');
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}

function command(method, params = {}, timeout = 5000) {
  const id = nextID++;
  return Promise.race([new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  }), rejectAfter(timeout, `Chrome DevTools command timed out: ${method}`)]);
}

async function createPage() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
      if (response.ok) return await response.json();
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForApp() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await command('Runtime.evaluate', {
      expression: `Boolean(document.querySelector('#chartCanvas')) && document.querySelectorAll('.tape-row:not([hidden])').length > 0`,
      returnByValue: true
    });
    if (result.result.value) return;
    await sleep(125);
  }
  const result = await command('Runtime.evaluate', {
    expression: `({ href: location.href, title: document.title, state: document.readyState, text: document.body?.innerText?.slice(0, 160) })`,
    returnByValue: true
  });
  throw new Error(`application did not become ready: ${JSON.stringify(result.result.value)}`);
}

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}
