// Stock-only context, measured as of the supplied market clock. The minute
// exhaustion and daily arithmetic mirror DaiDai; flow uses Tape's receipt clock.
import { marketParts } from './adr-rth-extension-model.js';
import { computeHorizon } from './tape-model.js';

const MINUTE = 6e7;
const positive = n => Number.isFinite(n) && n > 0;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : 0;
};
const validBar = b => [b.open, b.high, b.low, b.close].every(positive) &&
  b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close) &&
  Number.isFinite(b.volume) && b.volume >= 0;

export function calculateMomentum(bars, nowUS, upper = 1.02, lower = .98, price, priceTimeUS) {
  const parts = marketParts(nowUS);
  if (!parts) return { ready: false, side: 0 };
  const end = Math.floor(nowUS / MINUTE) * MINUTE;
  const current = bars.filter(b => {
    if (b.timeUS > end || !positive(b.close)) return false;
    const at = marketParts(b.timeUS);
    return at?.sessionDateET === parts.sessionDateET && at.seconds >= 14400 && at.seconds < 72000;
  });
  // An eligible LAST snapshot can arrive before the first streamed print.
  // Use it as the developing close without fabricating chart OHLC or volume.
  if (positive(price) && priceTimeUS >= end && priceTimeUS <= nowUS) {
    if (current.at(-1)?.timeUS === end) current[current.length - 1] = { ...current.at(-1), close: price };
    else current.push({ timeUS: end, close: price });
  }
  const latest = current.slice(-15);
  if (latest.length < 15 || latest.at(-1).timeUS < end - MINUTE || parts.seconds < 14400 || parts.seconds >= 72000) {
    return { ready: false, side: 0 };
  }
  const average = latest.reduce((sum, b) => sum + b.close / 15, 0);
  const ratio = latest.at(-1).close / average;
  return { ready: true, ratio, average, side: ratio > upper ? 1 : ratio < lower ? -1 : 0,
    forming: latest.at(-1).timeUS === end, price: latest.at(-1).close };
}

export function calculateDailyStretch(history, session, price) {
  const result = { streakReady: false, bbReady: false, days: 0, direction: 0, extension: 0, atLeast: false };
  if (!positive(price)) return result;
  const unique = new Map(history.filter(b => b.sessionDateET && b.sessionDateET < session)
    .map(b => [b.sessionDateET, b.close]));
  const dates = [...unique.keys()].sort();
  if (!dates.length || !positive(unique.get(dates.at(-1)))) return result;
  result.streakReady = true;
  let last = price;
  for (let i = dates.length - 1; i >= 0; i--) {
    const previous = unique.get(dates[i]);
    if (!positive(previous)) break;
    const direction = Math.sign(last - previous);
    if (!direction || result.days > 0 && direction !== result.direction) break;
    result.direction = direction; result.days++; last = previous; result.atLeast = i === 0;
  }
  if (dates.length < 19) return result;
  const closes = [price, ...dates.slice(-19).map(date => unique.get(date))];
  if (!closes.every(positive)) return result;
  result.mean = closes.reduce((sum, close) => sum + close / 20, 0);
  const sd = Math.sqrt(closes.reduce((sum, close) => sum + (close - result.mean) ** 2 / 20, 0));
  result.upper = result.mean + 2 * sd; result.lower = result.mean - 2 * sd;
  if (!positive(result.upper) || !positive(result.lower)) return result;
  result.bbReady = true;
  result.extension = price > result.upper ? (price / result.upper - 1) * 100
    : price < result.lower ? (price / result.lower - 1) * 100 : 0;
  return result;
}

export function volumeProfiles(bars, session) {
  const byDay = new Map();
  for (const b of bars) {
    const at = marketParts(b.timeUS);
    if (!at || at.sessionDateET >= session || at.seconds < 14400 || at.seconds >= 72000 ||
        !Number.isFinite(b.volume) || b.volume < 0) continue;
    if (!byDay.has(at.sessionDateET)) byDay.set(at.sessionDateET, new Map());
    byDay.get(at.sessionDateET).set(Math.floor(at.seconds / 60), b.volume);
  }
  return [...byDay.keys()].sort().reverse().slice(0, 5).map(date => ({ date, volume: byDay.get(date) }));
}

function exhaustionWindow(window, session, side, profiles) {
  const last = window.length - 1, at = marketParts(window[last].timeUS), clock = Math.floor(at.seconds / 60);
  const result = { ready: true, direction: side, exhaustion: 0, acceleration: 0, legs: 0,
    efficiency: 0, relativeVolume: 0, relativeVolumeReady: false, baselineSessions: 0,
    turnDirection: 0, breakPrice: 0, clock, setupClock: clock, volumeClimax: 0 };
  const prior = 100 * Math.log(window[last - 3].close / window[last - 6].close) / 3;
  const recent = 100 * Math.log(window[last].close / window[last - 3].close) / 3;
  if (Math.abs(prior) >= .02) result.direction = Math.sign(prior);
  const orientedPrior = prior * result.direction, orientedRecent = recent * result.direction;
  if (orientedPrior >= .02 && orientedRecent >= orientedPrior * 1.5 && orientedRecent - orientedPrior >= .04) {
    result.acceleration = orientedRecent / orientedPrior;
    result.exhaustion = Math.min(40, Math.round((result.acceleration - 1) * 20));
  }
  let travel = 0;
  for (let i = last - 5; i <= last; i++) travel += Math.abs(Math.log(window[i].close / window[i - 1].close));
  if (travel > 0) result.efficiency = Math.abs(Math.log(window[last].close / window[last - 6].close)) / travel;
  const threshold = Math.max(.10, median(window.map(b => 100 * Math.log(b.high / b.low))) * .75);
  let trough = result.direction * 100 * Math.log(window[0].close), peak = trough, inPush = false;
  for (const b of window.slice(1)) {
    const p = result.direction * 100 * Math.log(b.close);
    if (inPush) {
      peak = Math.max(peak, p);
      if (peak - p >= threshold) { inPush = false; trough = p; }
    } else {
      trough = Math.min(trough, p);
      if (p - trough >= threshold) { result.legs++; inPush = true; peak = p; }
    }
  }
  const currentVolume = window.slice(last - 2).reduce((sum, b) => sum + b.volume, 0);
  const priorVolume = window.slice(last - 5, last - 2).reduce((sum, b) => sum + b.volume, 0);
  if (priorVolume > 0) result.volumeClimax = currentVolume / priorVolume;
  const baselines = [], seen = new Set();
  for (const p of profiles) {
    if (p.date >= session || seen.has(p.date)) continue;
    seen.add(p.date);
    const volumes = [clock - 2, clock - 1, clock].map(minute => p.volume.get(minute));
    if (volumes.every(v => Number.isFinite(v) && v >= 0)) {
      const sum = volumes.reduce((a, b) => a + b, 0);
      if (sum > 0) baselines.push(sum);
    }
    if (baselines.length === 5) break;
  }
  result.baselineSessions = baselines.length;
  if (baselines.length >= 3) {
    result.relativeVolumeReady = true; result.relativeVolume = currentVolume / median(baselines);
  }
  result.setupRelativeVolume = result.relativeVolume;
  result.setupRelativeVolumeReady = result.relativeVolumeReady;
  // Volume and a one-way move strengthen actual acceleration; neither can
  // label an orderly trend exhausted on its own.
  if (result.exhaustion > 0) {
    if (result.relativeVolumeReady && result.relativeVolume >= 2 && result.volumeClimax >= 1.5) {
      result.exhaustion += Math.min(30, Math.round(Math.min(result.relativeVolume - 1, result.volumeClimax - 1) * 15));
    }
    if (result.efficiency >= .85) result.exhaustion += 15;
    if (result.legs >= 3) result.exhaustion += 15;
  }
  const previous = window.slice(last - 3, last);
  const low = Math.min(...previous.map(b => b.low)), high = Math.max(...previous.map(b => b.high));
  if (orientedPrior >= .02 && result.direction > 0 && window[last].close < low) {
    result.turnDirection = -1; result.breakPrice = low;
  }
  if (orientedPrior >= .02 && result.direction < 0 && window[last].close > high) {
    result.turnDirection = 1; result.breakPrice = high;
  }
  return result;
}

export function calculateExhaustion(bars, nowUS, side, profiles = []) {
  const end = Math.floor(nowUS / MINUTE) * MINUTE, session = marketParts(end)?.sessionDateET;
  const byMinute = new Map();
  for (const b of bars) {
    if (b.timeUS < end - 16 * MINUTE || b.timeUS + MINUTE > end || !validBar(b) ||
        marketParts(b.timeUS)?.sessionDateET !== session) continue;
    byMinute.set(Math.floor(b.timeUS / MINUTE), b);
  }
  const window = [];
  for (let time = end - MINUTE; window.length < 16; time -= MINUTE) {
    const bar = byMinute.get(Math.floor(time / MINUTE));
    if (!bar) break;
    window.unshift(bar);
  }
  if (window.length < 7) return { ready: false };
  const result = exhaustionWindow(window, session, side, profiles);
  for (let size = window.length - 1; size >= 7; size--) {
    const candidate = exhaustionWindow(window.slice(0, size), session, side, profiles);
    if (candidate.direction === result.direction && candidate.exhaustion > result.exhaustion) {
      for (const key of ['exhaustion', 'acceleration', 'efficiency', 'legs', 'volumeClimax']) result[key] = candidate[key];
      result.setupClock = candidate.clock; result.setupRelativeVolume = candidate.relativeVolume;
      result.setupRelativeVolumeReady = candidate.relativeVolumeReady;
    }
  }
  return result;
}

export function calculateFlow(source, nowUS, side) {
  if (!nowUS || source.oldestReceiptUS() > nowUS - 30e6 || source.lastReceivedUS() > nowUS ||
      source.lastReceivedUS() < nowUS - 5e6 || source.gaps(source.firstSeq(), source.lastSeq()).length) return { state: 'BUILD' };
  const recent = computeHorizon(source, 15, nowUS), prior = computeHorizon(source, 15, nowUS - 15e6);
  const ignition = computeHorizon(source, 5, nowUS);
  if (recent.prints < 10 || prior.prints < 10 || recent.volume <= 0) return { state: 'QUIET' };
  const flowSide = Math.abs(recent.deltaPercent) >= 15 ? Math.sign(recent.deltaPercent) : 0;
  const direction = side || flowSide;
  if (!direction) return { state: 'MIXED', recent };
  const nowShares = direction > 0 ? recent.buyer : recent.seller;
  const priorShares = direction > 0 ? prior.buyer : prior.seller;
  if (side && flowSide === -side && Math.sign(ignition.deltaPercent) === -side && Math.abs(ignition.deltaPercent) >= 15) {
    return { state: 'FLIP', direction: -side, recent };
  }
  if (recent.midTicks * direction < 0) return { state: 'PULL', direction: -direction, recent };
  if (priorShares > 0 && nowShares < priorShares * .75 || prior.midTicks * direction > 0 && recent.midTicks * direction <= 0) {
    return { state: 'EASE', direction, recent };
  }
  return { state: flowSide === direction && recent.midTicks * direction > 0 ? 'PUSH' : 'MIXED', direction, recent };
}

// Cache the historical profile and completed-minute setup between minute
// boundaries. Tick delivery changes flow/C/AVG without rescanning old sessions.
export class MomentumContextModel {
  constructor() { this.key = ''; this.bars = null; this.tape = { ready: false }; }
  calculate({ bars, dailyBars, nowUS, price, priceTimeUS, source, alert }) {
    const session = marketParts(nowUS)?.sessionDateET || '';
    const momentum = calculateMomentum(bars.slice(-32), nowUS, 1.02, .98, price, priceTimeUS);
    const usableAlert = alert && alert.as_of_us <= nowUS && nowUS - alert.as_of_us <= 30 * MINUTE && marketParts(alert.as_of_us)?.sessionDateET === session;
    const referenceSide = momentum.side || (usableAlert && (alert.direction === 1 || alert.direction === -1) ? alert.direction : 0);
    const key = `${Math.floor(nowUS / MINUTE)}|${bars.length}|${referenceSide}`;
    if (this.key !== key || this.bars !== bars) {
      this.key = key; this.bars = bars;
      if (this.profileBars !== bars || this.profileSession !== session) {
        this.profileBars = bars; this.profileSession = session;
        this.profiles = volumeProfiles(bars, session);
      }
      this.tape = calculateExhaustion(bars.slice(-32), nowUS, referenceSide, this.profiles);
    }
    const daily = calculateDailyStretch(dailyBars, session, price);
    const flow = calculateFlow(source, nowUS, referenceSide || this.tape.direction);
    return { momentum, tape: this.tape, daily, flow, session, nowUS };
  }
}
