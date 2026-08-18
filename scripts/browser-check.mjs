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
  await waitForApp();

  const panelCheck = await command('Runtime.evaluate', {
    expression: `(async () => {
      const api = window.__tapeReadingPanels;
      const picker = document.querySelector('#analyticsPanelPicker');
      const slot = document.querySelector('#rollingPanel');
      const beforeSocket = api.socket(); const beforeSymbol = api.symbol();
      const beforeRect = slot.getBoundingClientRect().toJSON(); const beforeDebug = api.debug();
      picker.value = 'adr-rth-extension'; picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const adr = {
        active: api.active(), value: document.querySelector('.adr-value')?.textContent,
        percent: document.querySelector('.adr-percent')?.textContent,
        history: document.querySelector('.adr-history')?.textContent,
        state: document.querySelector('.adr-state:not([hidden]) strong')?.textContent,
        rect: slot.getBoundingClientRect().toJSON(), debug: api.debug()
      };
      picker.value = 'blank'; picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const blank = { active: api.active(), text: document.querySelector('#analyticsPanelRoot')?.textContent.trim(), debug: api.debug() };
      picker.value = 'tape-pressure'; picker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        options: [...picker.options].map((option) => option.value), beforeRect, beforeDebug, adr, blank,
        restored: api.active(), rows: document.querySelectorAll('#rollingPanel .rolling-row').length,
        sameSocket: beforeSocket === api.socket(), sameSymbol: beforeSymbol === api.symbol(), afterDebug: api.debug()
      };
    })()`, awaitPromise: true, returnByValue: true
  }, 10000);
  const panels = panelCheck.result.value;
  if (JSON.stringify(panels.options) !== JSON.stringify(['tape-pressure', 'adr-rth-extension', 'blank']) ||
      panels.adr.active !== 'adr-rth-extension' || !/^\d+\.\d{2} ADR$/.test(panels.adr.value || '') ||
      panels.adr.history !== '20 / 20' || panels.blank.active !== 'blank' || !/NO ANALYTICS PANEL/.test(panels.blank.text || '') ||
      panels.restored !== 'tape-pressure' || panels.rows !== 3 || !panels.sameSocket || !panels.sameSymbol ||
      Math.abs(panels.beforeRect.x - panels.adr.rect.x) > .01 || Math.abs(panels.beforeRect.y - panels.adr.rect.y) > .01 ||
      Math.abs(panels.beforeRect.width - panels.adr.rect.width) > .01 || Math.abs(panels.beforeRect.height - panels.adr.rect.height) > .01 ||
      panels.afterDebug.unmountCount < panels.beforeDebug.unmountCount + 3) {
    throw new Error(`analytics panel hot swap failed: ${JSON.stringify(panels)}`);
  }
  await command('Runtime.evaluate', { expression: `window.__tapeReadingPanels.swap('adr-rth-extension')` });
  await sleep(150);
  await command('Page.reload', { ignoreCache: true });
  await waitForApp();
  const persistedCheck = await command('Runtime.evaluate', {
    expression: `(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const api = window.__tapeReadingPanels;
      const persisted = { active: api.active(), value: document.querySelector('.adr-value')?.textContent };
      api.injectError();
      const errored = { active: api.active(), title: document.querySelector('.panel-error strong')?.textContent, socket: api.socket()?.readyState };
      document.querySelector('.panel-error button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const recovered = { active: api.active(), value: document.querySelector('.adr-value')?.textContent };
      api.swap('tape-pressure');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { persisted, errored, recovered, restored: api.active() };
    })()`, awaitPromise: true, returnByValue: true
  }, 10000);
  const persisted = persistedCheck.result.value;
  if (persisted.persisted.active !== 'adr-rth-extension' || !/^\d+\.\d{2} ADR$/.test(persisted.persisted.value || '') ||
      !/STOPPED$/.test(persisted.errored.title || '') || persisted.errored.socket !== WebSocket.OPEN ||
      persisted.recovered.active !== 'adr-rth-extension' || !/^\d+\.\d{2} ADR$/.test(persisted.recovered.value || '') || persisted.restored !== 'tape-pressure') {
    throw new Error(`panel persistence/error recovery failed: ${JSON.stringify(persisted)}`);
  }
  await command('Runtime.evaluate', {
    expression: `(() => { const key = 'tape-reading-tool.settings.v1'; const saved = JSON.parse(localStorage.getItem(key)); saved.panels.slots.primaryAnalytics.activePanelId = 'unknown-panel'; localStorage.setItem(key, JSON.stringify(saved)); })()`
  });
  await command('Page.reload', { ignoreCache: true }); await waitForApp();
  const fallback = (await command('Runtime.evaluate', { expression: `window.__tapeReadingPanels.active()`, returnByValue: true })).result.value;
  if (fallback !== 'tape-pressure') throw new Error(`unknown panel did not fall back to Tape Pressure: ${fallback}`);
  await command('Runtime.evaluate', { expression: `window.__tapeReadingPanels.swap('tape-pressure')` });

  const results = [];
  const replayToolbarCheck = await command('Runtime.evaluate', {
    expression: `(async () => {
      const api = window.__tapeReadingReplayToolbar;
      const play = document.querySelector('#replayPlayButton');
      const pause = document.querySelector('#replayPauseButton');
      const replay = document.querySelector('#replayButton');
      const controls = document.querySelector('#controlsButton');
      const initialMode = api.mode();
      const states = {};
      api.setMode('replay');
      for (const replayState of ['ready', 'paused', 'replaying', 'stopped']) {
        api.update({ state: replayState, position_us: 123456789 });
        states[replayState] = { playDisabled: play.disabled, pauseDisabled: pause.disabled };
      }
      const order = [replay, play, pause, controls].map((element) => element.id);
      const modes = {};
      for (const mode of ['live', 'demo', 'render', 'massive', 'replay']) {
        api.setMode(mode);
        modes[mode] = { replay: replay.hidden, play: play.hidden, pause: pause.hidden };
      }

      api.setMode('replay');
      api.update({ state: 'paused', position_us: 123456789 });
      const originalFetch = window.fetch;
      const requests = [];
      window.fetch = async (url, options = {}) => {
        if (url === '/api/replay') {
          requests.push(JSON.parse(options.body));
          return new Response(JSON.stringify({ state: 'replaying', position_us: 123456789 }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          });
        }
        if (url === '/api/external-replay/status') {
          return new Response(JSON.stringify({ enabled: true, control: { attached: false, state: 'detached' } }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          });
        }
        return originalFetch(url, options);
      };
      play.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.fetch = originalFetch;
      const result = {
        states, order, modes, requests,
        positionUS: 123456789,
        dialogStart: document.querySelector('#replayStart').value,
        playLabel: play.textContent,
        pauseLabel: pause.textContent
      };
      api.setMode(initialMode);
      return result;
    })()`, awaitPromise: true, returnByValue: true
  });
  const replayToolbar = replayToolbarCheck.result.value;
  if (JSON.stringify(replayToolbar.order) !== JSON.stringify(['replayButton', 'replayPlayButton', 'replayPauseButton', 'controlsButton']) ||
      !replayToolbar.states.ready.playDisabled || !replayToolbar.states.ready.pauseDisabled ||
      replayToolbar.states.paused.playDisabled || !replayToolbar.states.paused.pauseDisabled ||
      !replayToolbar.states.replaying.playDisabled || replayToolbar.states.replaying.pauseDisabled ||
      !replayToolbar.states.stopped.playDisabled || !replayToolbar.states.stopped.pauseDisabled) {
    throw new Error(`replay toolbar state mapping failed: ${JSON.stringify(replayToolbar)}`);
  }
  for (const mode of ['live', 'demo', 'render', 'massive']) {
    if (!replayToolbar.modes[mode].replay || !replayToolbar.modes[mode].play || !replayToolbar.modes[mode].pause) {
      throw new Error(`replay toolbar must be absent in ${mode} mode: ${JSON.stringify(replayToolbar.modes)}`);
    }
  }
  if (replayToolbar.modes.replay.replay || replayToolbar.modes.replay.play || replayToolbar.modes.replay.pause) {
    throw new Error(`replay toolbar must be visible in replay mode: ${JSON.stringify(replayToolbar.modes.replay)}`);
  }
  if (replayToolbar.requests.length !== 1 || replayToolbar.requests[0].action !== 'resume' ||
      Object.keys(replayToolbar.requests[0]).length !== 1 || replayToolbar.positionUS !== 123456789) {
    throw new Error(`toolbar PLAY restarted instead of resuming the cued position: ${JSON.stringify(replayToolbar)}`);
  }
  const scaleCheck = await command('Runtime.evaluate', {
    expression: `(() => {
      const update = window.__tapeReadingScale;
      const initial = update(null, 99, 101, 0);
      const expanded = update(initial, 94, 101, 10);
      const candidate = update(expanded, 99, 101, 20);
      const delayed = update(candidate, 99, 101, 1000);
      const direct = update(candidate, 99, 101, 2720);
      const splitA = update(candidate, 99, 101, 1520);
      const splitB = update(splitA, 99, 101, 2720);
      const eligiblePrices = [100, 100.01, 100.02];
      return { expanded, delayed, direct, splitB,
        targetMinimum: Math.min(...eligiblePrices), excludedMinimum: Math.min(...eligiblePrices, 95) };
    })()`, returnByValue: true
  });
  const scale = scaleCheck.result.value;
  if (scale.expanded.minimum !== 94 || scale.delayed.minimum !== 94 ||
      Math.abs(scale.direct.minimum - scale.splitB.minimum) > 1e-9 ||
      scale.targetMinimum !== 100 || scale.excludedMinimum !== 95) {
    throw new Error(`price-scale hysteresis failed: ${JSON.stringify(scale)}`);
  }
  const xtraCheck = await command('Runtime.evaluate', {
    expression: `(() => {
      const bar = (iso, open, high, low, close) => ({ timeUS: Date.parse(iso) * 1000, open, high, low, close });
      return window.__tapeReadingXtraLevels([
        bar('2026-07-21T09:30:00-04:00', 100, 103, 99, 101),
        bar('2026-07-21T15:59:00-04:00', 101, 102, 98, 102),
        bar('2026-07-22T04:00:00-04:00', 103, 105, 97, 104),
        bar('2026-07-22T09:30:00-04:00', 106, 107, 104, 105)
      ], 0, false).map(({ key, price }) => [key, price]);
    })()`, returnByValue: true
  });
  const xtra = Object.fromEntries(xtraCheck.result.value);
  const expectedXtra = { PDC: 102, PDH: 103, PMH: 105, OPEN: 106, RTHH: 107, PDL: 98, RTHL: 104, PML: 97 };
  if (Object.entries(expectedXtra).some(([key, value]) => xtra[key] !== value)) {
    throw new Error(`xtra reference levels failed: ${JSON.stringify(xtra)}`);
  }
  const dayMapCheck = await command('Runtime.evaluate', {
    expression: `(() => {
      const map = document.querySelector('#dayContext');
      const corners = [map.dataset.corner];
      for (let index = 0; index < 4; index++) {
        map.click();
        corners.push(map.dataset.corner);
      }
      return corners;
    })()`, returnByValue: true
  });
  const dayMapCorners = dayMapCheck.result.value;
  const expectedDayMapCorners = ['upper-left', 'lower-left', 'lower-right', 'upper-right', 'upper-left'];
  if (JSON.stringify(dayMapCorners) !== JSON.stringify(expectedDayMapCorners)) {
    throw new Error(`day-map corner cycle failed: ${JSON.stringify(dayMapCorners)}`);
  }
  // Generic external replay badge. The controlling application is never named,
  // the tape may not look current while fast-follow suppression is active, and
  // a browser that has not unlocked audio may not read as FOLLOWING.
  const externalBadgeCheck = await command('Runtime.evaluate', {
    expression: `(() => {
      const badge = window.__tapeReadingExternalBadge;
      const base = { attached: true, symbol: 'AAPL', target_us: Date.UTC(2026, 6, 2, 13, 35, 42) * 1000 };
      return {
        idle: badge({ attached: false, state: '' }, true, true, 'AAPL'),
        following: badge({ ...base, state: 'following' }, true, true, 'AAPL'),
        cueing: badge({ ...base, state: 'cueing' }, true, true, 'AAPL'),
        paused: badge({ ...base, state: 'paused' }, true, true, 'AAPL'),
        fast: badge({ ...base, state: 'fast_follow', fast_follow: true }, true, true, 'AAPL'),
        incomplete: badge({ ...base, state: 'data_incomplete' }, true, true, 'AAPL'),
        locked: badge({ ...base, state: 'following' }, false, true, 'AAPL'),
        mutedLock: badge({ ...base, state: 'following' }, false, false, 'AAPL'),
        failed: badge({ ...base, state: 'error', error: 'cue superseded' }, true, true, 'AAPL'),
        detached: badge({ attached: false, state: 'detached' }, true, true, 'AAPL'),
        // A first cue that is refused never attaches. The operator still has to
        // be told, or a rejected cue is indistinguishable from no cue at all.
        refusedFirstCue: badge({ ...base, attached: false, state: 'data_incomplete' }, true, true, 'AAPL'),
        failedFirstCue: badge({ ...base, attached: false, state: 'error', error: 'no such symbol' }, true, true, 'AAPL'),
        idleUnattached: badge({ attached: false, state: '' }, true, true, 'AAPL')
      };
    })()`, returnByValue: true
  });
  const externalBadge = externalBadgeCheck.result.value;
  const expectedBadgeLabels = {
    following: 'FOLLOWING', cueing: 'CUEING', paused: 'PAUSED', fast: 'FAST FOLLOW',
    incomplete: 'DATA INCOMPLETE', locked: 'AUDIO LOCKED', mutedLock: 'FOLLOWING', detached: 'DETACHED'
  };
  for (const [key, label] of Object.entries(expectedBadgeLabels)) {
    if (externalBadge[key]?.label !== label || externalBadge[key]?.visible !== true) {
      throw new Error(`external badge ${key} failed: ${JSON.stringify(externalBadge)}`);
    }
  }
  if (externalBadge.idle.visible || externalBadge.idleUnattached.visible) {
    throw new Error(`the external badge must stay hidden without a controller: ${JSON.stringify(externalBadge.idle)}`);
  }
  if (!externalBadge.refusedFirstCue.visible || externalBadge.refusedFirstCue.label !== 'DATA INCOMPLETE') {
    throw new Error(`a refused first cue must still be reported: ${JSON.stringify(externalBadge.refusedFirstCue)}`);
  }
  if (!externalBadge.failedFirstCue.visible || !externalBadge.failedFirstCue.label.startsWith('ERROR')) {
    throw new Error(`a failed first cue must still be reported: ${JSON.stringify(externalBadge.failedFirstCue)}`);
  }
  if (!externalBadge.failed.label.startsWith('ERROR')) {
    throw new Error(`external badge error state failed: ${JSON.stringify(externalBadge.failed)}`);
  }
  // Suppression is on exactly when fast follow is, so the tape can never be
  // presented as current at a speed the detailed renderer cannot keep.
  if (!externalBadge.fast.suppressed || externalBadge.following.suppressed || externalBadge.paused.suppressed) {
    throw new Error(`fast-follow suppression failed: ${JSON.stringify(externalBadge)}`);
  }
  if (!externalBadge.following.text.startsWith('EXTERNAL REPLAY · AAPL · ') ||
      !/ · \d{2}:\d{2}:\d{2} · FOLLOWING$/.test(externalBadge.following.text)) {
    throw new Error(`external badge text failed: ${JSON.stringify(externalBadge.following)}`);
  }
  const suppressionStyle = await command('Runtime.evaluate', {
    expression: `(() => {
      const panel = document.querySelector('#tapePanel');
      panel.classList.add('fast-follow');
      const overlay = getComputedStyle(panel, '::after');
      const opacity = parseFloat(getComputedStyle(panel).opacity);
      const label = overlay.content;
      panel.classList.remove('fast-follow');
      return { opacity, label, restored: parseFloat(getComputedStyle(panel).opacity) };
    })()`, returnByValue: true
  });
  const suppression = suppressionStyle.result.value;
  if (suppression.opacity >= 1 || !/FAST FOLLOW/.test(suppression.label) || suppression.restored < 1) {
    throw new Error(`fast-follow tape suppression styling failed: ${JSON.stringify(suppression)}`);
  }
  const candleVolumeCheck = await command('Runtime.evaluate', {
    expression: `[999, 1300, 100100, 1120000].map(window.__tapeReadingCandleVolume)`, returnByValue: true
  });
  const candleVolumes = candleVolumeCheck.result.value;
  const expectedCandleVolumes = ['999', '1.3K', '100.1K', '1.12M'];
  if (JSON.stringify(candleVolumes) !== JSON.stringify(expectedCandleVolumes)) {
    throw new Error(`candle-volume formatting failed: ${JSON.stringify(candleVolumes)}`);
  }
  const addedReadoutsCheck = await command('Runtime.evaluate', {
    expression: `({
      dollars: [-1250000, 0, 12345].map(window.__tapeReadingSignedDollars),
      dayVolume: window.__tapeReadingVolumeSinceFourAM([
        {timeUS: Date.parse('2026-08-07T10:00:00-04:00') * 1000, volume: 999},
        {timeUS: Date.parse('2026-08-10T03:59:00-04:00') * 1000, volume: 100},
        {timeUS: Date.parse('2026-08-10T04:00:00-04:00') * 1000, volume: 200},
        {timeUS: Date.parse('2026-08-10T09:31:00-04:00') * 1000, volume: 300}
      ]),
      dayVolumeFirstBarAtOpen: window.__tapeReadingVolumeSinceFourAM([
        {timeUS: Date.parse('2026-08-10T04:00:00-04:00') * 1000, volume: 700}
      ]),
      dayVolumeAllBeforeOpen: window.__tapeReadingVolumeSinceFourAM([
        {timeUS: Date.parse('2026-08-10T03:58:00-04:00') * 1000, volume: 100},
        {timeUS: Date.parse('2026-08-10T03:59:00-04:00') * 1000, volume: 200}
      ]),
      maxDollarNode: Boolean(document.querySelector('#maxDeltaDollars')),
      minDollarNode: Boolean(document.querySelector('#minDeltaDollars'))
    })`, returnByValue: true
  });
  const addedReadouts = addedReadoutsCheck.result.value;
  if (JSON.stringify(addedReadouts.dollars) !== JSON.stringify(['-$1.25M', '$0', '+$12.3K']) ||
      addedReadouts.dayVolume !== 500 || addedReadouts.dayVolumeFirstBarAtOpen !== 700 ||
      addedReadouts.dayVolumeAllBeforeOpen !== 0 || !addedReadouts.maxDollarNode || !addedReadouts.minDollarNode) {
    throw new Error(`day-volume/delta-notional readouts failed: ${JSON.stringify(addedReadouts)}`);
  }
  // Live Rewind. The pane must never move, resize, or cover the live tick
  // chart, the live rolling horizons, or live time and sales, and it must not
  // force the live canvas to redraw.
  await command('Emulation.setDeviceMetricsOverride', { width: 1372, height: 1080, deviceScaleFactor: 1, mobile: false });
  await waitForApp();
  const rewindAvailable = (await command('Runtime.evaluate', {
    expression: `Boolean(window.__tapeReadingRewind?.state().available)`, returnByValue: true
  })).result.value;
  if (rewindAvailable) {
    // The buffer starts empty on every snapshot, so wait until it holds more
    // than the depth being tested; otherwise the seek correctly clamps to the
    // floor and the pane has a single bar to show.
    for (let attempt = 0; attempt < 60; attempt++) {
      const retained = (await command('Runtime.evaluate', {
        expression: `window.__tapeReadingRewind.state().retainedSeconds`, returnByValue: true
      })).result.value;
      if (retained >= 8) break;
      await sleep(500);
    }
    const rewindReport = await command('Runtime.evaluate', {
      expression: `(async () => {
        const api = window.__tapeReadingRewind;
        const rects = () => ({
          chart: document.querySelector('#chartPanel').getBoundingClientRect().toJSON(),
          rolling: document.querySelector('#rollingPanel').getBoundingClientRect().toJSON(),
          tape: document.querySelector('#tapePanel').getBoundingClientRect().toJSON()
        });
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // The rolling panel is positioned by the live pane's draw, so a viewport
        // override leaves it at its previous geometry until the next frame. Wait
        // for two agreeing samples, or the baseline races that first redraw.
        const settle = async () => {
          let previous = JSON.stringify(rects());
          for (let attempt = 0; attempt < 40; attempt++) {
            await sleep(120);
            const current = JSON.stringify(rects());
            if (current === previous) return;
            previous = current;
          }
        };
        await settle();
        // Count live-canvas paints to compare live-only against rewound.
        const context = document.querySelector('#chartCanvas').getContext('2d');
        let paints = 0;
        const original = context.fillRect.bind(context);
        context.fillRect = (...args) => { paints++; return original(...args); };
        const before = rects();
        const slotBefore = document.querySelector('#replayMarketPanel').getBoundingClientRect().width;
        // A settings change re-applies the workspace layout. The reserved pane has
        // to survive it: rebuilding the class list used to drop the two-column
        // grid, collapsing the slot and letting the live chart expand into it.
        const volume = document.querySelector('#tapeRateVolume');
        const originalVolume = volume.value;
        volume.value = '0.21';
        volume.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(400);
        const afterSettingsChange = { ...rects(), slot: document.querySelector('#replayMarketPanel').getBoundingClientRect().width, workspace: document.querySelector('#workspace').className };
        volume.value = originalVolume;
        volume.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(300);
        paints = 0; await sleep(1500); const liveOnlyPaints = paints;

        // A shortcut owns a fixed segment: it starts immediately at 0.25x and a
        // normal completion jumps back to the current live view.
        await api.enter(0.5);
        await sleep(120);
        const autoStarted = {
          ...api.state(),
          button: document.querySelector('#rewindPlay').textContent,
          selectedSpeed: document.querySelector('#rewindSpeed').value
        };
        await sleep(2200);
        const autoFinished = api.state();

        // A manual pause latches the pane. Resuming and completing the segment
        // must leave it held, further rewind shortcuts must still work, and an
        // actual LIVE-button click is the only normal dismissal.
        await api.enter(0.5);
        await sleep(120);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        const manuallyPaused = api.state();
        const speed = document.querySelector('#rewindSpeed');
        speed.value = '2';
        speed.dispatchEvent(new Event('change'));
        document.querySelector('#rewindPlay').click();
        await sleep(600);
        const heldComplete = api.state();
        const heldEndpoint = heldComplete.targetUS;
        await api.enter(0.25);
        await sleep(120);
        const additionalReplay = api.state();
        document.querySelector('#rewindExit').click();
        await sleep(200);
        const afterLiveClick = api.state();
        const playbackLifecycle = {
          autoStarted, autoFinished, manuallyPaused, heldComplete,
          heldEndpoint, additionalReplay, afterLiveClick
        };

        const retainedBefore = api.state().retainedSeconds;
        await api.enter(5);
        await sleep(600);
        const during = rects();
        const rewound = api.state();
        const fine = rewound.bars;
        // With the pane and live on the same tick size, the pane's bars must sit
        // on live bar boundaries rather than an offset back from the target.
        document.querySelector('#tickSelect').value = '10';
        document.querySelector('#tickSelect').dispatchEvent(new Event('change'));
        document.querySelector('#rewindTicks').value = '10';
        document.querySelector('#rewindTicks').dispatchEvent(new Event('change'));
        await sleep(700);
        const matched = api.state();
        document.querySelector('#tickSelect').value = '1';
        document.querySelector('#tickSelect').dispatchEvent(new Event('change'));
        document.querySelector('#rewindTicks').value = '1';
        document.querySelector('#rewindTicks').dispatchEvent(new Event('change'));
        await sleep(500);
        document.querySelector('#rewindTicks').value = '100';
        document.querySelector('#rewindTicks').dispatchEvent(new Event('change'));
        await sleep(400);
        const coarse = api.state();
        const steppedFrom = api.state().targetSeq;
        api.step(-1); api.step(-1); const back = api.state().targetSeq;
        api.step(1); const forward = api.state().targetSeq;
        api.toggle(); await sleep(500); const playing = api.state();
        api.toggle();
        paints = 0; await sleep(1500); const rewoundPaints = paints;
        const chrome = getComputedStyle(document.querySelector('#rewindChrome'));
        const badge = document.querySelector('#rewindBadge').textContent;
        const rewindRows = [...document.querySelectorAll('#rewindRollingPanel .rolling-row')].length;
        const covered = document.querySelector('#rewindPanel').getBoundingClientRect().toJSON();
        api.exit();
        await sleep(300);
        return {
          before, during, after: rects(), covered, slotBefore, afterSettingsChange,
          playbackLifecycle,
          matchedTick: { live: matched.liveTickSize, pane: matched.tickSize, firstBarSeq: matched.firstBarSeq, phaseAnchored: matched.phaseAnchored, bars: matched.bars },
          paneHiddenAfterExit: document.querySelector('#rewindPanel').hidden,
          activeAfterExit: api.state().active,
          badge, rewindRows, fineBars: fine, coarseBars: coarse.bars, retainedBefore,
          fineTick: rewound.tickSize, coarseTick: coarse.tickSize, liveTick: document.querySelector('#tickSelect').value,
          steppedFrom, back, forward, playedPast: playing.targetSeq, playing: playing.playing,
          behindSeconds: rewound.behindSeconds, buffered: rewound.buffered, bufferBytes: rewound.bufferBytes,
          frameStyle: chrome.borderStyle, frameColor: chrome.borderColor,
          liveOnlyPaints, rewoundPaints
        };
      })()`, returnByValue: true, awaitPromise: true
    }, 30000);
    const rewind = rewindReport.result.value;
    console.error('rewind check:', JSON.stringify(rewind));
    for (const pane of ['chart', 'rolling', 'tape']) {
      for (const edge of ['x', 'y', 'width', 'height']) {
        if (Math.abs(rewind.before[pane][edge] - rewind.during[pane][edge]) > 0.01 ||
            Math.abs(rewind.before[pane][edge] - rewind.after[pane][edge]) > 0.01 ||
            Math.abs(rewind.before[pane][edge] - rewind.afterSettingsChange[pane][edge]) > 0.01) {
          throw new Error(`the live ${pane} pane moved: ${JSON.stringify(rewind)}`);
        }
      }
    }
    // The reserved slot must keep its width through a settings change, and the
    // workspace must keep the two-column layout class that provides it.
    if (Math.abs(rewind.slotBefore - rewind.afterSettingsChange.slot) > 0.01 ||
        !/market-chart-mode/.test(rewind.afterSettingsChange.workspace)) {
      throw new Error(`a settings change collapsed the reserved rewind pane: ${JSON.stringify(rewind)}`);
    }
    const lifecycle = rewind.playbackLifecycle;
    if (!lifecycle.autoStarted.active || !lifecycle.autoStarted.playing ||
        lifecycle.autoStarted.speed !== 0.25 || lifecycle.autoStarted.selectedSpeed !== '0.25' ||
        lifecycle.autoStarted.button !== 'PAUSE' ||
        !(lifecycle.autoStarted.playbackEndUS > lifecycle.autoStarted.targetUS)) {
      throw new Error(`rewind did not auto-play a fixed segment at 0.25x: ${JSON.stringify(lifecycle)}`);
    }
    if (lifecycle.autoFinished.active || lifecycle.autoFinished.playing) {
      throw new Error(`an unpaused replay did not return to live: ${JSON.stringify(lifecycle)}`);
    }
    if (!lifecycle.manuallyPaused.active || lifecycle.manuallyPaused.playing ||
        !lifecycle.manuallyPaused.holdForLiveClick) {
      throw new Error(`manual pause did not latch the rewind pane: ${JSON.stringify(lifecycle)}`);
    }
    if (!lifecycle.heldComplete.active || lifecycle.heldComplete.playing ||
        !lifecycle.heldComplete.holdForLiveClick || !lifecycle.heldComplete.completed) {
      throw new Error(`a latched replay did not wait after completion: ${JSON.stringify(lifecycle)}`);
    }
    if (!lifecycle.additionalReplay.active || !lifecycle.additionalReplay.playing ||
        !lifecycle.additionalReplay.holdForLiveClick || lifecycle.additionalReplay.speed !== 0.25 ||
        !(lifecycle.additionalReplay.targetUS < lifecycle.heldEndpoint)) {
      throw new Error(`a held pane did not allow another rewind replay: ${JSON.stringify(lifecycle)}`);
    }
    if (lifecycle.afterLiveClick.active || lifecycle.afterLiveClick.holdForLiveClick) {
      throw new Error(`the LIVE button did not dismiss the held pane: ${JSON.stringify(lifecycle)}`);
    }
    if (rewind.covered.left < rewind.before.chart.right - 0.01 === false) {
      throw new Error(`the rewind pane overlaps the live tick chart: ${JSON.stringify(rewind)}`);
    }
    if (!/^REWIND −\d+\.\d+s$/.test(rewind.badge) || !(rewind.behindSeconds >= 4.5)) {
      throw new Error(`rewind badge = ${rewind.badge} at ${rewind.behindSeconds}s behind`);
    }
    if (rewind.retainedBefore < 8) throw new Error(`the buffer never filled: ${rewind.retainedBefore}s`);
    if (rewind.rewindRows !== 3) throw new Error(`rewind rolling rows = ${rewind.rewindRows}`);
    if (rewind.frameStyle !== 'dashed' || rewind.frameColor !== 'rgb(255, 192, 46)') {
      throw new Error(`rewind chrome is not the reserved dashed amber: ${rewind.frameStyle} ${rewind.frameColor}`);
    }
    // Bar phase: at a matching tick size the pane must aggregate from a live
    // boundary, so its bars are the bars live showed at that sequence.
    const matched = rewind.matchedTick;
    if (matched.live !== 10 || matched.pane !== 10 || !matched.bars || !matched.phaseAnchored) {
      throw new Error(`rewound bars are not anchored on a live bar boundary: ${JSON.stringify(rewind)}`);
    }
    // Independent granularity: the same window, re-aggregated more coarsely.
    if (rewind.coarseTick !== 100 || rewind.liveTick !== '1' || rewind.coarseBars >= rewind.fineBars) {
      throw new Error(`rewind granularity is not independent of live: ${JSON.stringify(rewind)}`);
    }
    if (rewind.back !== rewind.steppedFrom - 2 || rewind.forward !== rewind.back + 1) {
      throw new Error(`print stepping failed: ${JSON.stringify(rewind)}`);
    }
    if (!(rewind.playedPast > rewind.forward)) throw new Error(`playback did not advance: ${JSON.stringify(rewind)}`);
    if (!rewind.paneHiddenAfterExit || rewind.activeAfterExit) {
      throw new Error(`returning to live left the pane up: ${JSON.stringify(rewind)}`);
    }
    // Rewind must not add live redraws. Both windows are frame-capped, so a
    // rewound window must not paint materially more than a live-only one.
    if (rewind.rewoundPaints > rewind.liveOnlyPaints * 1.15 + 50) {
      throw new Error(`rewind forced extra live redraws: ${rewind.liveOnlyPaints} -> ${rewind.rewoundPaints}`);
    }
  } else {
    // Nothing may be reserved for a feature this session cannot reach.
    const idle = (await command('Runtime.evaluate', {
      expression: `JSON.stringify(window.__tapeReadingRewind.state())`, returnByValue: true
    })).result.value;
    const state = JSON.parse(idle);
    if (state.bufferBytes !== 0 || state.buffered !== 0) {
      throw new Error(`the rewind buffer was allocated without a pane: ${idle}`);
    }
    console.error(`rewind check: skipped, no pane reserved and no buffer allocated (${idle})`);
  }

  for (const width of [384, 634, 902, 1372]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    await waitForApp();
    const replayToolbarLayout = await command('Runtime.evaluate', {
      expression: `(() => {
        const api = window.__tapeReadingReplayToolbar;
        const initialMode = api.mode();
        api.setMode('replay');
        const toolbar = document.querySelector('.toolbar');
        const buttons = ['replayButton', 'replayPlayButton', 'replayPauseButton', 'controlsButton']
          .map((id) => document.querySelector('#' + id).getBoundingClientRect().toJSON());
        const result = {
          scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth,
          oneRow: buttons.every((rect) => Math.abs(rect.top - buttons[0].top) < 1)
        };
        api.setMode(initialMode);
        return result;
      })()`, returnByValue: true
    });
    const toolbarLayout = replayToolbarLayout.result.value;
    if (toolbarLayout.scrollWidth > toolbarLayout.clientWidth || !toolbarLayout.oneRow) {
      throw new Error(`replay toolbar reflowed at ${width}px: ${JSON.stringify(toolbarLayout)}`);
    }
    const adrLayoutCheck = await command('Runtime.evaluate', {
      expression: `(async () => {
        const api = window.__tapeReadingPanels; api.swap('adr-rth-extension');
        await new Promise((resolve) => setTimeout(resolve, 350));
        const root = document.querySelector('#analyticsPanelRoot');
        const ready = document.querySelector('.adr-ready'); const primary = document.querySelector('.adr-primary');
        const rootRect = root.getBoundingClientRect(); const primaryRect = primary?.getBoundingClientRect();
        const result = {
          value: document.querySelector('.adr-value')?.textContent,
          rootOverflow: root.scrollWidth - root.clientWidth,
          primaryOverflow: primaryRect ? Math.max(0, rootRect.left - primaryRect.left, primaryRect.right - rootRect.right) : 999,
          pickerVisible: getComputedStyle(document.querySelector('#analyticsPanelPicker')).display !== 'none'
        };
        api.swap('tape-pressure'); await new Promise((resolve) => setTimeout(resolve, 80)); return result;
      })()`, awaitPromise: true, returnByValue: true
    });
    const adrLayout = adrLayoutCheck.result.value;
    if (!/^\d+\.\d{2} ADR$/.test(adrLayout.value || '') || adrLayout.rootOverflow > 0 || adrLayout.primaryOverflow > .5 || !adrLayout.pickerVisible) {
      throw new Error(`ADR panel does not fit at ${width}px: ${JSON.stringify(adrLayout)}`);
    }
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
          // Both delta readouts carry a share figure and a notional. Measured
          // against the widest strings the formatters can produce, because the
          // live values at screenshot time are usually short enough to fit
          // whatever the layout happens to be.
          deltaFit: ['maxDelta', 'minDelta'].map((id) => {
            const value = document.querySelector('#' + id);
            const dollars = document.querySelector('#' + id + 'Dollars');
            const priorValue = value.textContent;
            const priorDollars = dollars.textContent;
            value.textContent = '-999K';
            dollars.textContent = '-$999.9K';
            const fit = {
              id,
              valueOverflow: value.scrollWidth - value.clientWidth,
              dollarOverflow: dollars.scrollWidth - dollars.clientWidth,
              dollarBelowRow: dollars.getBoundingClientRect().bottom -
                dollars.closest('.metrics-group').getBoundingClientRect().bottom,
              valueFontSize: parseFloat(getComputedStyle(value).fontSize),
              dollarFontSize: parseFloat(getComputedStyle(dollars).fontSize)
            };
            value.textContent = priorValue;
            dollars.textContent = priorDollars;
            return fit;
          }),
          // Live Rewind mirrors the same two readouts. Its pane is hidden until
          // a rewind starts, so it is revealed for the measurement and put back
          // before anything else reads the page.
          rewindReadoutFit: (() => {
            const panel = document.querySelector('#rewindPanel');
            const readout = document.querySelector('.rewind-readout');
            if (!panel || !readout || !window.__tapeReadingRewind.state().available) return null;
            const wasHidden = panel.hidden;
            const ids = ['rewindMaxDelta', 'rewindMinDelta', 'rewindMaxDeltaDollars', 'rewindMinDeltaDollars'];
            const prior = ids.map((id) => [document.getElementById(id), document.getElementById(id).textContent]);
            panel.hidden = false;
            for (const id of ids) {
              document.getElementById(id).textContent = id.endsWith('Dollars') ? '-$999.9K' : '-999K';
            }
            const fit = {
              overflowRight: readout.getBoundingClientRect().right - (panel.getBoundingClientRect().right - 8),
              overflowTop: panel.getBoundingClientRect().top - readout.getBoundingClientRect().top,
              // The rewind clock is drawn in the same corner of the same pane.
              overClock: readout.getBoundingClientRect().bottom -
                document.querySelector('#rewindClock').getBoundingClientRect().top,
              dollarFontSize: parseFloat(getComputedStyle(document.getElementById('rewindMaxDeltaDollars')).fontSize)
            };
            for (const [node, text] of prior) node.textContent = text;
            panel.hidden = wasHidden;
            return fit;
          })(),
          replayRvol: document.querySelector('#relativeVolumeValue')?.textContent,
          replayRvolState: document.querySelector('#relativeVolumeState')?.textContent,
          replayRvolVisible: getComputedStyle(document.querySelector('#relativeVolume')).display !== 'none',
          replayRvolFontSize: parseFloat(getComputedStyle(document.querySelector('#relativeVolumeValue')).fontSize),
          lastPriceFontSize: parseFloat(getComputedStyle(document.querySelector('#lastPrice')).fontSize),
          rollingValueFontSize: parseFloat(getComputedStyle(document.querySelector('#rollingPanel .rolling-row.primary .metric-cell output')).fontSize),
          rollingWindowFontSize: parseFloat(getComputedStyle(document.querySelector('#rollingPanel .rolling-row.primary .window-cell strong')).fontSize),
          marketClock: document.querySelector('#marketClockTime')?.textContent,
          marketClockLabel: document.querySelector('#marketClockLabel')?.textContent,
          marketClockVisible: getComputedStyle(document.querySelector('#marketClock')).display !== 'none',
          marketClockFontSize: parseFloat(getComputedStyle(document.querySelector('#marketClockTime')).fontSize),
          marketClockRect: (() => { const rect = document.querySelector('#marketClock').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })(),
          chartPanelRect: (() => { const rect = document.querySelector('#chartPanel').getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })(),
          rollingPanelBottom: document.querySelector('#rollingPanel').getBoundingClientRect().bottom,
          footerClockPresent: Boolean(document.querySelector('#clockText')),
          visibleTapeRows: rows.length,
          coloredCanvasSamples: colored,
          replayChartVisible: !document.querySelector('#replayMarketPanel')?.hidden,
          // The REPLAY control is shown only in replay mode. The pane slot beside
          // the tape tool is not a proxy for it any more: Live Rewind reserves
          // that slot in live and demo mode too.
          replayMode: !document.querySelector('#replayButton')?.hidden,
          replayChartWidth: replayCanvas?.clientWidth,
          replayChartHeight: replayCanvas?.clientHeight,
          replayColoredCanvasSamples: replayColored,
          socketState: document.querySelector('#connectionState span')?.textContent,
          soundState: document.querySelector('#soundButton')?.textContent,
          tapeRateSound: document.querySelector('#tapeRateEnabled')?.checked,
          tapeRateVolume: document.querySelector('#tapeRateVolume')?.value,
          // Scoped to the live panel: the Live Rewind pane holds its own copy of
          // these rows, earlier in the document.
          horizons: [...document.querySelectorAll('#rollingPanel .rolling-row')].map(row => ({
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
    if (['LIVE', 'PAUSED'].includes(checked.socketState) && !checked.replayRvolVisible) {
      throw new Error(`RVOL is hidden for an active feed at ${width}px: ${JSON.stringify(checked)}`);
    }
    if (checked.deltaFit.some((cell) => cell.valueOverflow > 0 || cell.dollarOverflow > 0 ||
        cell.dollarBelowRow > 0.5 || cell.valueFontSize < checked.lastPriceFontSize ||
        cell.dollarFontSize < cell.valueFontSize)) {
      throw new Error(`delta readouts are clipped or undersized at ${width}px: ${JSON.stringify(checked.deltaFit)}`);
    }
    if (checked.rewindReadoutFit && (checked.rewindReadoutFit.overflowRight > 0.5 ||
        checked.rewindReadoutFit.overflowTop > 0.5 || checked.rewindReadoutFit.overClock > 0.5 ||
        checked.rewindReadoutFit.dollarFontSize < 10)) {
      throw new Error(`rewind readout does not fit its pane at ${width}px: ${JSON.stringify(checked.rewindReadoutFit)}`);
    }
    const expectedRollingFontSize = checked.rollingPanelClientWidth > 430 ? 20 : 15;
    if (checked.rollingValueFontSize < expectedRollingFontSize || checked.rollingWindowFontSize < (checked.rollingPanelClientWidth > 430 ? 21 : 17)) {
      throw new Error(`rolling typography is too small at ${width}px: ${JSON.stringify(checked)}`);
    }
    const expectedClockLabel = checked.replayMode ? 'REPLAY TIME' : 'MARKET TIME';
    if (!checked.marketClockVisible || !/^\d{2}:\d{2}:\d{2}$/.test(checked.marketClock) || checked.marketClockLabel !== expectedClockLabel ||
        checked.marketClockFontSize < checked.lastPriceFontSize || checked.footerClockPresent || Math.abs(checked.marketClockRect.height - 54) > 0.5 ||
        Math.abs(checked.marketClockRect.bottom - checked.chartPanelRect.bottom) > 0.5 || checked.marketClockRect.top <= checked.rollingPanelBottom) {
      throw new Error(`market clock placement failed at ${width}px: ${JSON.stringify(checked)}`);
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
