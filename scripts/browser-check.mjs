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
  for (const width of [384, 634, 902, 1372]) {
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
      const independence = await command('Runtime.evaluate', {
        expression: `(() => {
          const toggle = document.querySelector('#tapeRateEnabled');
          const volume = document.querySelector('#tapeRateVolume');
          const soundBefore = document.querySelector('#soundButton').textContent;
          const originalVolume = volume.value;
          toggle.click();
          const savedMuted = JSON.parse(localStorage.getItem('tape-reading-tool.settings.v1')).audio.tapeRateEnabled;
          const soundWhileMuted = document.querySelector('#soundButton').textContent;
          toggle.click();
          volume.value = '0.21';
          volume.dispatchEvent(new Event('input', { bubbles: true }));
          const savedVolume = JSON.parse(localStorage.getItem('tape-reading-tool.settings.v1')).audio.tapeRateVolume;
          volume.value = originalVolume;
          volume.dispatchEvent(new Event('input', { bubbles: true }));
          return { soundBefore, soundWhileMuted, savedMuted, savedVolume, restored: toggle.checked };
        })()`,
        returnByValue: true
      });
      const independent = independence.result.value;
      if (independent.soundBefore !== 'SOUND ON' || independent.soundWhileMuted !== 'SOUND ON' ||
          independent.savedMuted !== false || independent.savedVolume !== 0.21 || independent.restored !== true) {
        throw new Error(`tape-rate controls are not independent: ${JSON.stringify(independent)}`);
      }
    }
    const inspection = await command('Runtime.evaluate', {
      expression: `(() => {
        const canvas = document.querySelector('#chartCanvas');
        const replayCanvas = document.querySelector('#replayChartCanvas');
        const rows = [...document.querySelectorAll('.tape-row')].filter(row => !row.hidden);
        const pixels = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data || [];
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 64) {
          if (pixels[i] > 30 || pixels[i + 1] > 30 || pixels[i + 2] > 30) colored++;
        }
        const replayPixels = replayCanvas?.getContext('2d').getImageData(0, 0, replayCanvas.width, replayCanvas.height).data || [];
        let replayColored = 0;
        for (let i = 0; i < replayPixels.length; i += 64) {
          if (replayPixels[i] > 30 || replayPixels[i + 1] > 30 || replayPixels[i + 2] > 30) replayColored++;
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
          replayRvol: document.querySelector('#replayRvolValue')?.textContent,
          replayRvolState: document.querySelector('#replayRvolState')?.textContent,
          replayRvolVisible: getComputedStyle(document.querySelector('#replayRvol')).display !== 'none',
          replayRvolFontSize: parseFloat(getComputedStyle(document.querySelector('#replayRvolValue')).fontSize),
          lastPriceFontSize: parseFloat(getComputedStyle(document.querySelector('#lastPrice')).fontSize),
          visibleTapeRows: rows.length,
          coloredCanvasSamples: colored,
          replayChartVisible: !document.querySelector('#replayMarketPanel')?.hidden,
          replayChartWidth: replayCanvas?.clientWidth,
          replayChartHeight: replayCanvas?.clientHeight,
          replayColoredCanvasSamples: replayColored,
          socketState: document.querySelector('#connectionState span')?.textContent,
          soundState: document.querySelector('#soundButton')?.textContent,
          tapeRateSound: document.querySelector('#tapeRateEnabled')?.checked,
          tapeRateVolume: document.querySelector('#tapeRateVolume')?.value,
          horizons: [...document.querySelectorAll('.rolling-row')].map(row => ({
            seconds: row.dataset.horizon,
            volume: row.querySelector('.volume')?.textContent,
            buyer: row.querySelector('.buyer-volume')?.textContent,
            seller: row.querySelector('.seller-volume')?.textContent,
            delta: row.querySelector('.signed-delta')?.textContent,
            deltaPercent: row.querySelector('.delta-percent')?.textContent,
            sharesRate: row.querySelector('.shares-rate')?.textContent,
            printsRate: row.querySelector('.prints-rate')?.textContent,
            midChange: row.querySelector('.mid-change')?.textContent,
            pace: row.querySelector('.relative-pace')?.textContent,
            winner: row.querySelector('.winner')?.textContent
          })),
          rollingPanelWidth: document.querySelector('#rollingPanel')?.scrollWidth,
          rollingPanelClientWidth: document.querySelector('#rollingPanel')?.clientWidth
        };
      })()`,
      returnByValue: true
    });
    console.error(`browser check ${width}px:`, JSON.stringify(inspection.result.value));
    const checked = inspection.result.value;
    if (checked.rollingPanelWidth !== checked.rollingPanelClientWidth || checked.horizons?.length !== 3 ||
        checked.horizons.some(row => !row.volume || !row.buyer || !row.seller || !row.delta || !row.deltaPercent ||
          !row.sharesRate || !row.printsRate || !row.midChange || !row.pace || !row.winner)) {
      throw new Error(`rolling horizon panel failed at ${width}px: ${JSON.stringify(checked)}`);
    }
    if (checked.socketState === 'PAUSED' && (!checked.replayChartVisible || checked.replayColoredCanvasSamples < 10)) {
      throw new Error(`replay minute chart failed at ${width}px: ${JSON.stringify(checked)}`);
    }
    if (checked.socketState === 'PAUSED' && (!checked.replayRvolVisible || !/^[0-9]+(?:\.[0-9])?×$/.test(checked.replayRvol) ||
        !['QUIET', 'NORMAL', 'ELEVATED', 'SURGE'].includes(checked.replayRvolState) || checked.replayRvolFontSize < checked.lastPriceFontSize)) {
      throw new Error(`replay RVOL cue failed at ${width}px: ${JSON.stringify(checked)}`);
    }
    const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 20000);
    const path = `/tmp/tape-reading-tool-${width}.png`;
    writeFileSync(path, Buffer.from(screenshot.data, 'base64'));
    results.push({ ...inspection.result.value, screenshot: path });
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
