import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdtempSync, openSync, rmSync, writeSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const options = parseArguments(process.argv.slice(2));
for (const name of ['url', 'symbol', 'source', 'provider', 'start-us', 'end-us', 'fps', 'width', 'height', 'speed', 'codec', 'quality', 'output']) {
  if (!options[name]) throw new Error(`missing --${name}`);
}
if (existsSync(options.output)) throw new Error(`output already exists: ${options.output}`);

const startUS = Number(options['start-us']);
const endUS = Number(options['end-us']);
const fps = Number(options.fps);
const speed = Number(options.speed);
const width = Number(options.width);
const height = Number(options.height);
const durationSeconds = (endUS - startUS) / 1e6 / speed;
const frameCount = Math.max(1, Math.ceil(durationSeconds * fps));
const temporary = options['temp-dir'] || mkdtempSync(join(tmpdir(), 'tape-render-'));
const audioPath = join(temporary, 'audio.s16le');
const chromePort = 10000 + process.pid % 40000;
const chromeProfile = join(temporary, 'chrome');
let browser;
let ffmpeg;
let socket;
let cleanupPromise;

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    console.error(`render: interrupted by ${signal}; cleaning temporary files`);
    void cleanup().finally(() => process.exit(code));
  });
}

try {
  console.log(`render: ${options.symbol} ${formatET(startUS)}–${formatET(endUS)} · ${width}x${height} ${fps} fps`);
  console.log(`render: output timeline ${formatDuration(durationSeconds)} · ${frameCount.toLocaleString()} frames`);
  console.log('render: generating deterministic audio');
  const config = await getJSON(`${options.url}/api/render?kind=config`);
  const audioQuery = new URLSearchParams({
    kind: 'audio', symbol: options.symbol, source: options.source, provider: options.provider,
    start_us: String(startUS - 1e6), end_us: String(endUS)
  });
  const audio = await getJSON(`${options.url}/api/render?${audioQuery}`);
  renderAudio(audioPath, audio.events || [], config.audio || {}, startUS, endUS, speed);

  console.log('render: launching headless Chrome');
  browser = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--font-render-hinting=none', '--force-device-scale-factor=1',
    '--remote-allow-origins=*', `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${chromeProfile}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeError = '';
  browser.stderr.on('data', (chunk) => { chromeError += String(chunk).slice(-4000); });
  const page = await createPage(chromePort, options.url);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    rejectAfter(10000, `Chrome DevTools WebSocket did not open: ${chromeError}`)
  ]);
  const cdp = devTools(socket);
  await cdp.command('Page.enable');
  await cdp.command('Runtime.enable');
  await cdp.command('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  await cdp.command('Page.navigate', { url: `${options.url}/?render=1` });
  await waitFor(async () => {
    const result = await cdp.command('Runtime.evaluate', {
      expression: 'Boolean(window.__tapeReadingRender?.ready())', returnByValue: true
    });
    return result.result.value === true;
  }, 15000, 'render page did not become ready');

  const encoder = encoderFor(options.codec);
  const videoEncoderArguments = encoder === 'libaom-av1'
    ? ['-c:v', encoder, '-cpu-used', '6']
    : ['-c:v', encoder, '-preset', 'medium'];
  ffmpeg = spawn(process.env.FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
    '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', audioPath,
    ...videoEncoderArguments,
    '-crf', String(options.quality), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    '-t', durationSeconds.toFixed(6), options.output
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  const frameStartedAt = Date.now();
  let lastReportedAt = 0;
  let lastReportedPercent = -1;
  for (let frame = 0; frame < frameCount; frame++) {
    const targetUS = Math.min(endUS, Math.round(startUS + frame / fps * speed * 1e6));
    const evaluated = await cdp.command('Runtime.evaluate', {
      expression: `window.__tapeReadingRender.frame(${targetUS})`,
      awaitPromise: true, returnByValue: true
    });
    if (evaluated.exceptionDetails) {
      throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
    }
    const captured = await cdp.command('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true
    });
    if (!ffmpeg.stdin.write(Buffer.from(captured.data, 'base64'))) {
      await new Promise((resolve) => ffmpeg.stdin.once('drain', resolve));
    }
    const percent = Math.floor((frame + 1) * 100 / frameCount);
    const now = Date.now();
    if (lastReportedAt === 0 || now - lastReportedAt >= 10000 ||
        percent >= lastReportedPercent + 2 || frame + 1 === frameCount) {
      lastReportedAt = now;
      lastReportedPercent = percent;
      const elapsedSeconds = Math.max(0.001, (now - frameStartedAt) / 1000);
      const completed = frame + 1;
      const framesPerSecond = completed / elapsedSeconds;
      const etaSeconds = Math.max(0, (frameCount - completed) / framesPerSecond);
      console.log(
        `render: ${String(percent).padStart(3)}% · frame ${completed.toLocaleString()}/${frameCount.toLocaleString()}` +
        ` · ${framesPerSecond.toFixed(1)} frame/s · ETA ${formatDuration(etaSeconds)} · replay ${formatET(targetUS)}`
      );
    }
  }
  console.log('render: frames complete; finalizing MP4');
  ffmpeg.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    ffmpeg.once('error', reject);
    ffmpeg.once('close', resolve);
  });
  if (exitCode !== 0) throw new Error(`FFmpeg exited with status ${exitCode}`);
  console.log(`render: wrote ${options.output}`);
} finally {
  await cleanup();
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    try { socket?.close(); } catch {}
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
    if (browser && browser.exitCode === null) {
      browser.kill('SIGTERM');
      await new Promise((resolve) => {
        browser.once('close', resolve);
        setTimeout(resolve, 1000);
      });
    }
    try { rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch {}
  })();
  return cleanupPromise;
}

function renderAudio(path, events, config, rangeStartUS, rangeEndUS, playbackSpeed) {
  const sampleRate = 48000;
  const duration = (rangeEndUS - rangeStartUS) / 1e6 / playbackSpeed;
  const totalSamples = Math.ceil(duration * sampleRate);
  const file = openSync(path, 'w');
  const master = config.enabled === false ? 0 : number(config.master_volume, 0.45);
  const bedVolume = config.tape_rate_enabled === false ? 0 : number(config.tape_rate_volume, 0.35);
  const minimum = number(config.minimum_gain, 0.65);
  const largeSize = Math.max(1, number(config.large_size, 1000));
  const largeBoost = number(config.large_boost, 1.8);
  const durationMS = number(config.duration_ms, 110);
  const buyPitch = number(config.buy_pitch_hz, 660);
  const sellPitch = number(config.sell_pitch_hz, 490);
  const mapped = events.map((event) => ({
    sample: Math.round((Number(event.time_us) - rangeStartUS) / 1e6 / playbackSpeed * sampleRate),
    side: Math.sign(Number(event.side) || 0), size: Math.max(0, Number(event.size) || 0)
  })).filter((event) => event.sample >= -sampleRate && event.sample < totalSamples);
  const selected = thinCues(mapped, sampleRate, largeSize);
  let cueIndex = 0;
  let eventIndex = 0;
  let rateStart = 0;
  let carrierPhase = 0;
  let pulsePhase = 0;
  let smoothedRate = 0;
  const active = [];
  const blockSamples = sampleRate;
  const startedAt = Date.now();
  let lastReportedAt = startedAt;
  let nextReportedPercent = 10;
  for (let base = 0; base < totalSamples; base += blockSamples) {
    const count = Math.min(blockSamples, totalSamples - base);
    const samples = new Float32Array(count);
    while (cueIndex < selected.length && selected[cueIndex].sample < base + count) {
      const cue = selected[cueIndex++];
      const ratio = cue.size / largeSize;
      const isLarge = ratio >= 1;
      const strength = Math.sqrt(Math.min(1, ratio));
      const boost = isLarge ? largeBoost * (1 + Math.min(1, Math.log2(Math.max(1, ratio)) / 4) * 0.15) : 1;
      const amplitude = Math.min(0.62, (0.055 + minimum * 0.07 + strength * 0.12) * boost) * master;
      const notes = ratio >= 4 ? 4 : isLarge ? 2 : 1;
      active.push({
        start: cue.sample, end: cue.sample + Math.round((durationMS + (notes - 1) * Math.max(55, Math.min(85, durationMS * 0.7))) * sampleRate / 1000),
        frequency: cue.side > 0 ? buyPitch : cue.side < 0 ? sellPitch : Math.sqrt(buyPitch * sellPitch),
        side: cue.side, amplitude, notes
      });
    }
    for (let index = 0; index < count; index++) {
      const absolute = base + index;
      while (eventIndex < mapped.length && mapped[eventIndex].sample <= absolute) eventIndex++;
      while (rateStart < eventIndex && mapped[rateStart].sample <= absolute - sampleRate) rateStart++;
      const targetRate = eventIndex - rateStart;
      smoothedRate += (targetRate - smoothedRate) * (targetRate > smoothedRate ? 0.00026 : 0.00013);
      let mixed = 0;
      for (const voice of active) {
        if (absolute < voice.start || absolute >= voice.end) continue;
        const age = absolute - voice.start;
        const gap = Math.round(Math.max(55, Math.min(85, durationMS * 0.7)) * sampleRate / 1000);
        const note = Math.min(voice.notes - 1, Math.floor(age / gap));
        const noteAge = age - note * gap;
        const intervals = voice.side < 0 ? [1, 0.8, 0.6, 0.5] : [1, 1.25, 1.5, 2];
        const attack = Math.min(1, noteAge / (sampleRate * 0.0025));
        const decay = Math.pow(0.001, noteAge / Math.max(64, durationMS * sampleRate / 1000));
        const phase = noteAge * voice.frequency * intervals[note] / sampleRate;
        const triangle = 1 - 4 * Math.abs((phase - Math.floor(phase)) - 0.5);
        mixed += triangle * attack * decay * voice.amplitude;
      }
      const speedLevel = Math.min(1, Math.sqrt(smoothedRate / 500));
      const bedPitch = 90 * Math.pow(2, 2 * speedLevel);
      const pulseRate = 1.2 + 10.8 * speedLevel;
      carrierPhase = (carrierPhase + bedPitch / sampleRate) % 1;
      pulsePhase = (pulsePhase + pulseRate / sampleRate) % 1;
      const pulse = (1 + Math.sin((pulsePhase + 0.75) * Math.PI * 2)) * 0.5;
      const activity = Math.min(1, smoothedRate / 8);
      const bed = Math.sin(carrierPhase * Math.PI * 2) * (0.16 + 0.84 * pulse ** 3) * activity * 0.32 * bedVolume;
      samples[index] = Math.tanh(mixed) + bed;
    }
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index].end <= base + count) active.splice(index, 1);
    }
    const output = Buffer.allocUnsafe(count * 2);
    for (let index = 0; index < count; index++) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      output.writeInt16LE(Math.round(value * 32767), index * 2);
    }
    writeSync(file, output);
    const completed = Math.min(totalSamples, base + count);
    const percent = Math.floor(completed * 100 / totalSamples);
    const now = Date.now();
    if (percent >= nextReportedPercent || now - lastReportedAt >= 10000 || completed === totalSamples) {
      lastReportedAt = now;
      while (nextReportedPercent <= percent) nextReportedPercent += 10;
      const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
      const samplesPerSecond = completed / elapsedSeconds;
      const etaSeconds = Math.max(0, (totalSamples - completed) / samplesPerSecond);
      console.log(`render: audio ${String(percent).padStart(3)}% · ETA ${formatDuration(etaSeconds)}`);
    }
  }
  closeSync(file);
  console.log(`render: audio ${mapped.length} prints · ${duration.toFixed(1)} seconds`);
}

function thinCues(events, sampleRate, largeSize) {
  const selected = [];
  let tokens = 2;
  let tokenSample = 0;
  let windowStart = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    while (windowStart < index && events[windowStart].sample < event.sample - sampleRate / 4) windowStart++;
    const span = Math.max(sampleRate * 0.05, event.sample - events[windowStart].sample);
    const rate = index === windowStart ? 0 : (index - windowStart) * sampleRate / span;
    if (event.size >= largeSize) {
      selected.push(event);
      continue;
    }
    if (rate <= 60) {
      tokens = 2;
      tokenSample = event.sample;
      selected.push(event);
      continue;
    }
    const target = Math.max(12, 3600 / rate);
    tokens = Math.min(2, tokens + Math.max(0, event.sample - tokenSample) * target / sampleRate);
    tokenSample = event.sample;
    if (tokens >= 1) {
      tokens--;
      selected.push(event);
    }
  }
  return selected;
}

function devTools(ws) {
  let nextID = 1;
  const pending = new Map();
  ws.addEventListener('message', async (event) => {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text());
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    command(method, params = {}) {
      const id = nextID++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function createPage(port, target) {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, 10000, 'Chrome did not expose its debugging endpoint');
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`create Chrome page: HTTP ${response.status}`);
  return response.json();
}

async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error((await response.text()).trim());
  return response.json();
}

async function waitFor(check, timeoutMS, message) {
  const deadline = Date.now() + timeoutMS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}

function encoderFor(value) {
  switch (String(value).toLowerCase()) {
    case 'h264': return 'libx264';
    case 'h265': return 'libx265';
    case 'av1': return 'libaom-av1';
    default: throw new Error('codec must be h264, h265, or av1');
  }
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatET(valueUS) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(valueUS / 1000));
}

function formatDuration(valueSeconds) {
  const seconds = Math.max(0, Math.round(Number(valueSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m${String(remainder).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${String(remainder).padStart(2, '0')}s`;
  return `${remainder}s`;
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith('--') || index + 1 >= args.length) throw new Error(`invalid argument ${key || ''}`);
    parsed[key.slice(2)] = args[index + 1];
  }
  return parsed;
}
