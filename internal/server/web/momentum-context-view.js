const arrow = direction => direction > 0 ? '↑' : direction < 0 ? '↓' : '';
const times = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const multiple = n => n > 99 ? '>99×' : `${n.toFixed(1)}×`;
const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
const sideTone = direction => direction > 0 ? 'up' : direction < 0 ? 'down' : 'neutral';

// Direction colors describe measured movement/flow. Amber marks caution;
// violet is volume magnitude and never a price-direction signal.
export function momentumCues({ momentum: m, tape: t, flow: f }) {
  const momentum = { text: !m.ready ? '—' : `${m.side ? `${arrow(m.side)} ${m.side > 0 ? 'UP' : 'DN'} ` : '↔ '}${m.ratio.toFixed(3)}`, tone: sideTone(m.side) };
  let flow = { text: 'FLOW WAIT', tone: 'neutral', caution: false };
  if (f.state === 'PUSH' && f.direction) flow = { text: `${arrow(f.direction)} ${f.direction > 0 ? 'BUY' : 'SELL'} PUSH`, tone: sideTone(f.direction), caution: false };
  else if (f.state === 'EASE' && f.direction) flow = { text: `${arrow(f.direction)} ${f.direction > 0 ? 'BUY' : 'SELL'} EASE`, tone: 'caution', caution: true };
  else if (f.state === 'PULL' && f.direction) flow = { text: `${arrow(f.direction)} PULLBACK`, tone: sideTone(f.direction), caution: true };
  else if (f.state === 'FLIP' && f.direction) flow = { text: `${arrow(f.direction)} FLOW FLIP`, tone: sideTone(f.direction), caution: true };
  else if (f.state === 'MIXED') flow.text = '↔ MIXED FLOW';
  else if (f.state === 'QUIET') flow.text = 'FLOW QUIET';

  let setup = { text: 'SETUP WAIT', tone: 'neutral', caution: false };
  if (t.turnDirection) setup = { text: `${arrow(t.turnDirection)} TURN`, tone: sideTone(t.turnDirection), caution: false };
  else if (t.ready && t.exhaustion >= 25) setup = { text: `⚠ ${t.exhaustion >= 60 ? 'CLIMAX' : 'TIRED'}${t.direction ? ` ${arrow(t.direction)}` : ''}`, tone: 'caution', caution: true };
  else if (t.ready) setup.text = '○ NO CLIMAX';

  const volume = { text: t.relativeVolumeReady ? `3m VOL ${t.relativeVolume >= 1 ? '↑' : '↓'}${multiple(t.relativeVolume)}` : '3m VOL —',
    tone: !t.relativeVolumeReady ? 'neutral' : t.relativeVolume >= 2 ? 'volume-high' : t.relativeVolume < .75 ? 'volume-low' : 'volume' };
  return { momentum, flow, setup, volume };
}

function cue(element, reading) {
  text(element, reading.text); element.dataset.tone = reading.tone;
  element.dataset.caution = reading.caution ? 'yes' : 'no';
}

export class MomentumContextView {
  constructor(root, dialog) {
    this.root = root; this.dialog = dialog; this.reading = null;
    this.button = root.querySelector('button');
    this.button.addEventListener('click', () => { this.renderDetails(); dialog.showModal(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  }
  render(reading, symbol, alert) {
    this.reading = reading; this.symbol = symbol; this.alert = alert;
    const { momentum: m, tape: t, daily: d, flow: f } = reading;
    const cues = momentumCues(reading);
    cue(this.root.querySelector('[data-momentum]'), cues.momentum);
    cue(this.root.querySelector('[data-state]'), cues.flow);
    cue(this.root.querySelector('[data-setup]'), cues.setup);
    this.root.dataset.turn = t.turnDirection ? 'yes' : 'no';
    cue(this.root.querySelector('[data-rvol]'), cues.volume);
    this.button.title = `C / AVGC15: ${m.ready ? `${m.ratio.toFixed(4)}; ${m.side > 0 ? 'UP' : m.side < 0 ? 'DOWN' : 'inside thresholds'}` : 'waiting for 15 same-session minute closes'}. Open momentum context details.`;
    this.root.querySelector('[data-state]').title = 'BUY/SELL PUSH: pressure and price agree. EASE: prior side is slowing. PULLBACK: price opposes the leg. FLOW FLIP: opposite 15s and 5s pressure. These are early flow readings, not completed turns.';
    this.root.querySelector('[data-setup]').title = t.turnDirection ? 'TURN: a completed minute closed through the previous three candles’ range after a measured leg.' : 'TIRED: exhaustion 25–59. CLIMAX: 60+. NO CLIMAX: no qualifying accelerating climax in the observed leg; it does not establish continuation.';
    this.root.querySelector('[data-rvol]').title = `Last three completed minutes versus the median of the same clock window in ${t.baselineSessions || 0} prior sessions; at least three required. ↑ means above normal volume, ↓ below normal. Violet denotes volume, not price direction. Separate from RVOL PACE and 5D cumulative RVOL.`;
    const second = Math.floor(reading.nowUS / 1e6);
    if (this.dialog.open && this.detailsSecond !== second) { this.detailsSecond = second; this.renderDetails(); }
  }
  renderDetails() {
    if (!this.reading) return;
    const { momentum: m, tape: t, daily: d, flow: f, nowUS } = this.reading;
    const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(nowUS / 1000));
    text(this.dialog.querySelector('[data-context-title]'), `${this.symbol} · ${clock} ET`);
    const rows = [
      ['Momentum', m.ready ? `C / AVGC15 ${m.ratio.toFixed(4)} · ${m.side > 0 ? 'UP > 1.02' : m.side < 0 ? 'DOWN < 0.98' : 'inside 0.98–1.02'} · ${m.forming ? 'developing minute' : 'last completed minute'}` : 'Waiting for 15 same-session closes and a current candle.'],
      ['Stock setup', t.ready ? `${t.exhaustion >= 60 ? 'CLIMAX' : t.exhaustion >= 25 ? 'WATCH' : 'CALM'} ${t.exhaustion}/100${t.relativeVolumeReady ? '' : ' · volume baseline incomplete'} · ${arrow(t.direction)} leg · setup ${times(t.setupClock)} ET` : 'Waiting for seven consecutive completed minutes.'],
      ['Acceleration', t.ready ? `${t.acceleration > 0 ? multiple(t.acceleration) : 'no qualifying acceleration'} · ${Math.round(t.efficiency * 100)}% direct travel · ${t.legs} push${t.legs === 1 ? '' : 'es'}` : '—'],
      ['Fast flow', `${momentumCues(this.reading).flow.text} · 15-second pressure and price progress; 5-second flow checks a flip. Slowdown and opposing flow are early warnings.`],
      ['Completed turn', t.turnDirection ? `${arrow(t.turnDirection)} close through ${t.breakPrice.toFixed(2)} · ${times(t.clock)} ET candle` : 'No measured close through the preceding three candles’ lows/highs.'],
      ['Daily stretch', `${d.streakReady ? `${d.days}${d.atLeast ? '+' : ''} daily move${d.days === 1 ? '' : 's'} ${arrow(d.direction)}, including today` : 'Daily run unavailable'}; ${d.bbReady ? d.extension ? `${Math.abs(d.extension).toFixed(2)}% beyond the ${d.extension > 0 ? 'upper' : 'lower'} band` : 'inside the daily bands' : 'daily bands unavailable'}. Bands use 19 completed closes plus current price, 20 periods, 2 population standard deviations.`],
      ['Same-clock RVOL', t.relativeVolumeReady ? `${multiple(t.relativeVolume)} · 3 completed minutes / same clock window across ${t.baselineSessions} prior sessions` : `Unavailable · ${t.baselineSessions || 0}/3 prior same-clock windows; missing history is unknown.`],
      ['RVOL PACE', 'The existing readout projects the current minute against recent completed candles. It measures a different baseline.']
    ];
    if (this.alert) {
      const a = this.alert;
      const before = a.as_of_us > nowUS;
      rows.push(['DaiDai alert snapshot', before ? 'Hidden: alert snapshot is later than the tape clock.' : `${arrow(a.direction)} · CONT ${a.continuation ?? '—'} · MR ${a.reversion ?? '—'}${arrow(a.reversion_direction)}${a.incomplete ? ' · incomplete context' : ''} · ${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(a.as_of_us / 1000))} ${a.clock || ''} ET${a.industry ? ` · ${a.industry}` : ''}. Scores belong to the alert timestamp; the tape readings above are current.`]);
    }
    const list = this.dialog.querySelector('dl'); list.replaceChildren();
    for (const [label, value] of rows) {
      const term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label; description.textContent = value; list.append(term, description);
    }
  }
}
