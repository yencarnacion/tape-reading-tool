// Aggregation shared by every render target. Nothing here touches the DOM, the
// network, or a clock, so the live pane, historical replay, and Live Rewind all
// derive their panels from one implementation: identical arithmetic is what makes
// a rewound instant comparable to the live state at the same sequence.
//
// Every function reads events through the EventSource contract in
// tape-source.js and receives events in the WebSocket wire shape
// (s, r, t, p, z, d, c, b, a), so no adapter can introduce a rounding
// difference between sources.

export const HORIZONS = [5, 15, 60];
export const BALANCE_DEADBAND_PERCENT = 2;
export const RVOL_BASELINE_BARS = 20;
export const RVOL_MIN_BASELINE_BARS = 5;
export const RVOL_EARLY_PRIOR_SECONDS = 5;
export const SCALE_CONTRACTION_DELAY_MS = 1500;
export const SCALE_CONTRACTION_TIME_CONSTANT_MS = 1200;

export function lowerBound(items, target, selector) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (selector(items[middle]) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function upperBound(items, target, selector) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (selector(items[middle]) <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function priceTickSize(price) {
  return Number(price) > 0 && Number(price) < 1 ? 0.0001 : 0.01;
}

// Rolling pressure for one horizon, ending at nowUS on the receipt timeline.
// `truncated` reports that the window reaches past the oldest retained event, so
// a caller can refuse to display an understated number instead of showing one.
export function computeHorizon(source, seconds, nowUS) {
  const durationUS = seconds * 1e6;
  const startUS = nowUS - durationUS;
  const totals = source.totalsBetween(startUS, nowUS);
  const baselineStartUS = startUS - durationUS;
  const baseline = source.totalsBetween(baselineStartUS, startUS, false);
  const oldestReceipt = source.oldestReceiptUS();
  const hasBaseline = oldestReceipt <= baselineStartUS;
  const sharesRate = totals.volume / seconds;
  const baselineRate = baseline.volume / seconds;
  const relativePace = hasBaseline
    ? baselineRate > 0 ? sharesRate / baselineRate : sharesRate > 0 ? Infinity : 1
    : null;
  const delta = totals.buyer - totals.seller;
  const deltaPercent = totals.volume > 0 ? delta / totals.volume * 100 : 0;
  const midTicks = source.midpointTicks(startUS, nowUS);
  return {
    ...totals, delta, deltaPercent, sharesRate, printsRate: totals.prints / seconds,
    midTicks, relativePace, truncated: oldestReceipt > startUS
  };
}

export function computeTapeRate(source, nowUS) {
  return nowUS ? source.totalsBetween(nowUS - 1e6, nowUS).prints : 0;
}

// One tick bar boundary. `firstSeq` is what lets a rewound pane reproduce the
// live pane's bar phase: count-based bars depend on where aggregation started,
// so the rewind view anchors on a live boundary rather than on its buffer floor.
export function appendTickBar(bars, event, tickSize) {
  let bar = bars[bars.length - 1];
  if (!bar || bar.count >= tickSize) {
    bar = {
      count: 0, open: event.p, high: event.p, low: event.p, close: event.p,
      volume: 0, delta: 0, dollarDelta: 0, time: event.t, received: event.r, className: event.c,
      firstSeq: event.s
    };
    bars.push(bar);
  }
  bar.count++;
  bar.high = Math.max(bar.high, event.p);
  bar.low = Math.min(bar.low, event.p);
  bar.close = event.p;
  bar.volume += event.z;
  bar.delta += event.z * event.d;
  bar.dollarDelta += event.p * event.z * event.d;
  bar.time = event.t;
  bar.received = event.r;
  bar.className = event.c;
  return bar;
}

// Where a rewound pane must start aggregating so its bars coincide with the live
// pane's. Count-based bars depend on where aggregation started, so the window has
// to be anchored on an actual live bar boundary: an offset back from the target
// lands mid-bar, and boundaries are not arithmetic in sequence space once a
// LAGGED gap has been recorded. When the pane is re-aggregating at a different
// granularity there is no live phase to match, and the plain offset is used.
export function rewindWindowStart({ liveBars, liveTickSize, tickSize, targetSeq, floorSeq, visibleBars }) {
  const span = Math.max(1, visibleBars * tickSize);
  const desired = Math.max(floorSeq, targetSeq - span + 1);
  if (!Array.isArray(liveBars) || !liveBars.length || liveTickSize !== tickSize) return desired;
  const boundary = (bar) => Number(bar.firstSeq) || 0;
  const index = upperBound(liveBars, desired, boundary) - 1;
  let anchor = boundary(liveBars[index >= 0 ? index : 0]);
  if (anchor < floorSeq) {
    // The anchoring boundary has been evicted from the buffer. Take the oldest
    // boundary the buffer can still serve whole rather than starting mid-bar.
    const retained = liveBars.find((bar) => boundary(bar) >= floorSeq);
    anchor = retained ? boundary(retained) : desired;
  }
  return Math.max(floorSeq, Math.min(anchor, targetSeq));
}

export function aggregateTickBars(source, fromSeq, toSeq, tickSize, maxBars = 0) {
  const bars = [];
  source.each(fromSeq, toSeq, (event) => {
    appendTickBar(bars, event, tickSize);
    if (maxBars && bars.length > maxBars) bars.splice(0, bars.length - maxBars);
  });
  return bars;
}

export function appendMinuteBar(bars, event, limit = 2000) {
  const marketUS = Number(event.t) * 1000;
  const price = Number(event.p);
  const size = Math.max(0, Number(event.z) || 0);
  if (!marketUS || !Number.isFinite(price) || price <= 0) return null;
  const timeUS = Math.floor(marketUS / 6e7) * 6e7;
  // Delivery is ordered by receipt time, but candles use exchange time. A late
  // report can therefore belong to an earlier minute. Appending it at the end
  // creates a duplicate old candle, and the next ordinary print creates a
  // duplicate current candle. Keep the array ordered and merge by minute.
  const index = lowerBound(bars, timeUS, (candidate) => Number(candidate.timeUS));
  let bar = bars[index];
  if (!bar || Number(bar.timeUS) !== timeUS) {
    bar = {
      timeUS, open: price, high: price, low: price, close: price,
      volume: 0, dollarVolume: 0, _openTimeUS: marketUS, _closeTimeUS: marketUS
    };
    bars.splice(index, 0, bar);
    if (bars.length > limit) bars.splice(0, bars.length - limit);
  } else {
    // These timestamps are client-only aggregation metadata. Bars hydrated
    // from an authoritative snapshot do not have them; in that case a prior
    // completed candle keeps its established open/close while still accepting
    // the late print's high, low, and volume.
    if (Number.isFinite(bar._openTimeUS) && marketUS < bar._openTimeUS) {
      bar.open = price;
      bar._openTimeUS = marketUS;
    }
    if ((Number.isFinite(bar._closeTimeUS) && marketUS >= bar._closeTimeUS) ||
        (!Number.isFinite(bar._closeTimeUS) && index === bars.length - 1)) {
      bar.close = price;
      bar._closeTimeUS = marketUS;
    }
  }
  bar.high = Math.max(bar.high, price);
  bar.low = Math.min(bar.low, price);
  bar.volume += size;
  bar.dollarVolume += price * size;
  return bar;
}

// Projected volume for the forming one-minute candle against the median of the
// previous completed candles. The median resists an isolated spike.
export function calculateCandleRVOL(minuteBars, nowUS) {
  if (!Number.isFinite(nowUS) || nowUS <= 0 || minuteBars.length < RVOL_MIN_BASELINE_BARS + 1) return null;
  const current = minuteBars[minuteBars.length - 1];
  const currentStartUS = Number(current?.timeUS);
  const currentVolume = Number(current?.volume);
  if (!Number.isFinite(currentStartUS) || currentStartUS <= 0 || !Number.isFinite(currentVolume) || currentVolume < 0 || nowUS < currentStartUS) return null;

  const baselineStart = Math.max(0, minuteBars.length - 1 - RVOL_BASELINE_BARS);
  const baselineVolumes = minuteBars.slice(baselineStart, -1)
    .filter((bar) => Number(bar.timeUS) < currentStartUS && Number.isFinite(Number(bar.volume)) && Number(bar.volume) >= 0)
    .map((bar) => Number(bar.volume))
    .sort((left, right) => left - right);
  if (baselineVolumes.length < RVOL_MIN_BASELINE_BARS) return null;
  const middle = Math.floor(baselineVolumes.length / 2);
  const baseline = baselineVolumes.length % 2
    ? baselineVolumes[middle]
    : (baselineVolumes[middle - 1] + baselineVolumes[middle]) / 2;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;

  const elapsedSeconds = Math.max(0, Math.min(60, (nowUS - currentStartUS) / 1e6));
  const forming = elapsedSeconds < 60;
  // Five seconds of neutral prior pace dampens the otherwise explosive first
  // few prints, while quickly yielding to observed volume as the candle forms.
  const ratio = forming
    ? (currentVolume / baseline * 60 + RVOL_EARLY_PRIOR_SECONDS) / (elapsedSeconds + RVOL_EARLY_PRIOR_SECONDS)
    : currentVolume / baseline;
  if (!Number.isFinite(ratio) || ratio < 0) return null;
  return { ratio, baseline, baselineBars: baselineVolumes.length, currentVolume, elapsedSeconds, forming };
}

// Expand immediately so real moves are never clipped. Contract only after a
// stable smaller target, using elapsed-time exponential smoothing so the
// result does not depend on display refresh rate.
export function updatePriceScale(previous, targetMinimum, targetMaximum, nowMS) {
  if (!previous || !Number.isFinite(previous.minimum) || !Number.isFinite(previous.maximum)) {
    return { minimum: targetMinimum, maximum: targetMaximum, targetMinimum, targetMaximum, lastMS: nowMS, candidateSince: nowMS, contracting: false };
  }
  let minimum = Math.min(previous.minimum, targetMinimum);
  let maximum = Math.max(previous.maximum, targetMaximum);
  const expanded = targetMinimum < previous.minimum || targetMaximum > previous.maximum;
  const targetChanged = targetMinimum !== previous.targetMinimum || targetMaximum !== previous.targetMaximum;
  let candidateSince = expanded || targetChanged ? nowMS : (previous.candidateSince ?? nowMS);
  const smaller = !expanded && (targetMinimum > previous.minimum || targetMaximum < previous.maximum);
  let contracting = smaller;
  if (smaller && nowMS - candidateSince >= SCALE_CONTRACTION_DELAY_MS) {
    const elapsed = Math.max(0, nowMS - (previous.lastMS ?? nowMS));
    const alpha = 1 - Math.exp(-elapsed / SCALE_CONTRACTION_TIME_CONSTANT_MS);
    minimum = previous.minimum + (targetMinimum - previous.minimum) * alpha;
    maximum = previous.maximum + (targetMaximum - previous.maximum) * alpha;
    // Floating point convergence should not keep the animation alive forever.
    if (Math.abs(minimum - targetMinimum) < 1e-9) minimum = targetMinimum;
    if (Math.abs(maximum - targetMaximum) < 1e-9) maximum = targetMaximum;
    contracting = minimum !== targetMinimum || maximum !== targetMaximum;
  }
  return { minimum, maximum, targetMinimum, targetMaximum, lastMS: nowMS, candidateSince, contracting };
}
