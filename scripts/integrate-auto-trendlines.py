"""One-shot, checksum-guarded integration on feature/auto-trendlines only.
This development helper is removed once the integration commit is verified.
"""
from pathlib import Path
import hashlib
import subprocess

EXPECTED = {
    'internal/server/web/app.js': 'f264a20bc08bdfe84b3c85686b963dab13c8eaee',
    'internal/server/web/index.html': 'cb57104789f2b676119ed4f8ae39c3a1c4171b1d',
    'README.md': '39f94c022a5f73492aa3b9b4a88831b32c1ff35f',
}

def source(path):
    data = Path(path).read_bytes()
    sha = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if sha != EXPECTED[path]:
        raise RuntimeError(f'{path}: unexpected base blob {sha}; refusing to overwrite')
    return data.decode()

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one integration anchor: {old[:100]!r}')
    return text.replace(old, new, 1)

app = source('internal/server/web/app.js')
html = source('internal/server/web/index.html')
readme = source('README.md')
app = replace_once(app,
    "import { adrRTHManifest } from './adr-rth-extension-panel.js';",
    "import { adrRTHManifest } from './adr-rth-extension-panel.js';\nimport { AutoTrendlinesController } from './auto-trendlines-controller.js';")
app = replace_once(app,
    '  const liveSource = createStreamSource(state);',
    """  const liveSource = createStreamSource(state);
  const autoTrendlines = new AutoTrendlinesController({
    button: $('trendlinesButton'),
    redraw: () => { state.dirtyReplayChart = true; }
  });
  window.__tapeReadingAutoTrendlines = () => autoTrendlines.debug();""")
app = replace_once(app,
    '  function addTradeToMinuteBars(trade) {\n    appendMinuteBar(state.minuteBars, trade);\n  }',
    """  function addTradeToMinuteBars(trade) {
    const updated = appendMinuteBar(state.minuteBars, trade);
    if (updated && updated !== state.minuteBars[state.minuteBars.length - 1]) autoTrendlines.invalidate();
  }""")
app = replace_once(app,
    "    const daily = state.marketChartView === 'daily';\n    elements.replayChart.hidden = daily;",
    "    const daily = state.marketChartView === 'daily';\n    $('trendlinesButton').hidden = daily;\n    elements.replayChart.hidden = daily;")
app = replace_once(app,
    '      state.settings = structuredClone(state.defaults);\n      audio.enabled = state.settings.audio.enabled;',
    '      state.settings = structuredClone(state.defaults);\n      autoTrendlines.setEnabled(true);\n      audio.enabled = state.settings.audio.enabled;')
start = app.index('  function drawReplayChart() {')
end = app.index('  function calculateXtraLevels(', start)
draw = app[start:end]
draw = replace_once(draw, '  function drawReplayChart() {\n    resizeReplayCanvas();', """  function syncTrendlineVisibility() {
    autoTrendlines.setActive(Boolean(state.settings?.showChart && state.marketChartView === 'minute' &&
      !state.rewind.active && (state.status?.mode === 'replay' || state.marketChartEnabled)));
  }

  function drawReplayChart() {
    syncTrendlineVisibility();
    autoTrendlines.update(state.minuteBars, state.symbol, state.status?.mode || '');
    resizeReplayCanvas();""")
draw = replace_once(draw, '    const bodyWidth = Math.max(1, Math.min(8, step * 0.62));', """    autoTrendlines.draw(replayContext, {
      bars: state.minuteBars, start, xAt, priceY, left, right, top, bottom: priceBottom
    });

    const bodyWidth = Math.max(1, Math.min(8, step * 0.62));""")
app = app[:start] + draw + app[end:]
app = replace_once(app,
    "    if (state.dirtyReplayChart && (state.status?.mode === 'replay' || state.marketChartEnabled) && state.settings?.showChart) drawReplayChart();",
    "    syncTrendlineVisibility();\n    if (state.dirtyReplayChart && (state.status?.mode === 'replay' || state.marketChartEnabled) && state.settings?.showChart) drawReplayChart();")
html = replace_once(html, '  <link rel="stylesheet" href="/styles.css">',
    '  <link rel="stylesheet" href="/styles.css">\n  <link rel="stylesheet" href="/auto-trendlines.css">')
html = replace_once(html,
    '            <button id="dailyChartTab" type="button" aria-pressed="false">90 DAY</button>',
    '            <button id="dailyChartTab" type="button" aria-pressed="false">90 DAY</button>\n            <button id="trendlinesButton" class="active" type="button" aria-label="Automatic trendlines" aria-pressed="true">TRENDLINES ON</button>')
html = replace_once(html, 'aria-label="Market chart timeframe"', 'aria-label="Market chart controls"')
readme += """

## Automatic trendlines

The one-minute market chart includes a **TRENDLINES ON / OFF** button beside the
1 MIN and 90 DAY controls. It defaults to ON and remembers the browser's choice.
Reset Controls restores ON. Small/large support and resistance lines are computed
locally in a bounded worker using already-loaded candles; turning them off also
stops the worker. Tick, daily, and Live Rewind charts are unchanged.

See [Auto Trendlines](docs/AUTO_TRENDLINES.md) for the algorithm, confirmation delay,
performance limits, tests, and deliberate differences from TradingView.
"""
# All assertions above succeed before any existing source file is written.
for path, content in [('internal/server/web/app.js', app), ('internal/server/web/index.html', html), ('README.md', readme)]:
    Path(path).write_text(content)
subprocess.run(['node', '--check', 'internal/server/web/app.js'], check=True)
print('Integrated auto trendlines: app.js, index.html, README.md')
