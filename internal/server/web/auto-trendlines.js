// Independent, bounded implementation inspired by TradingView's public
// Auto Trendlines description. This is NOT TradingView's proprietary source.
// All indexes are candle indexes (not elapsed time), including across gaps.
export const TRENDLINE_LIMITS = Object.freeze({ bars: 5000, pivotsPerSide: 24, lines: 12, perGroup: 3 });
export const MINUTE_US = 60e6;
const STRIDE = 4; // timestamp (microseconds), high, low, close

// The newest candle is deliberately held out until the next candle arrives.
// No wall clock is used: a paused/accelerated replay cannot inspect the future.
export function packClosedBars(bars) {
  const end = Math.max(0, bars.length - 1);
  const start = Math.max(0, end - TRENDLINE_LIMITS.bars);
  const packed = new Float64Array((end - start) * STRIDE);
  for (let i = start, j = 0; i < end; i++, j += STRIDE) {
    const b = bars[i];
    packed[j] = b.timeUS; packed[j + 1] = b.high;
    packed[j + 2] = b.low; packed[j + 3] = b.close;
  }
  return packed;
}

export function wilderATR(data, period = 14) {
  const n = data.length / STRIDE;
  const atr = new Float64Array(n);
  atr.fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const high = data[i * STRIDE + 1], low = data[i * STRIDE + 2];
    const previous = i ? data[(i - 1) * STRIDE + 3] : data[i * STRIDE + 3];
    const tr = Math.max(high - low, Math.abs(high - previous), Math.abs(low - previous));
    if (i < period) sum += tr;
    if (i === period - 1) atr[i] = sum / period;
    else if (i >= period) atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}

// Nearest stronger neighbours in linear time. Equal-price plateaus choose the
// rightmost extremum; flat markets therefore cannot generate thousands of pivots.
export function pivotStrengths(data, highSide) {
  const n = data.length / STRIDE, field = highSide ? 1 : 2;
  const result = new Uint16Array(n), stack = new Int32Array(n);
  const value = (i) => data[i * STRIDE + field] * (highSide ? 1 : -1);
  let size = 0;
  for (let i = 0; i < n; i++) {
    while (size && value(stack[size - 1]) <= value(i)) size--;
    result[i] = size ? i - stack[size - 1] - 1 : i;
    stack[size++] = i;
  }
  size = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (size && value(stack[size - 1]) < value(i)) size--;
    result[i] = Math.min(result[i], size ? stack[size - 1] - i - 1 : n - 1 - i);
    stack[size++] = i;
  }
  return result;
}

export function zigZag(data, atr, highs, lows, span, multiplier) {
  const points = [];
  const n = data.length / STRIDE;
  for (let i = Math.max(13, span); i + span < n; i++) {
    const high = highs[i] >= span, low = lows[i] >= span;
    if (!high && !low) continue;
    const last = points.at(-1);
    // An outside bar can be both extrema; OHLC does not reveal their order.
    // Prefer the opposite swing if known, and skip an ambiguous first anchor.
    if (high && low && !last) continue;
    const side = high && low ? -last.side : high ? -1 : 1;
    const price = data[i * STRIDE + (side === 1 ? 2 : 1)];
    const point = { index: i, price, side, strength: side === 1 ? lows[i] : highs[i] };
    if (!last) { points.push(point); continue; }
    if (side === last.side) {
      if ((price - last.price) * side <= 0) points[points.length - 1] = point;
    } else if ((price - last.price) * last.side > multiplier * atr[last.index]) {
      points.push(point);
    }
  }
  return points;
}

export function evaluateTrendline(data, atr, strengths, a, b, size, breakoutBars = 3) {
  const n = data.length / STRIDE, side = a.side;
  const base = b.index - a.index;
  if (base <= 0 || b.index + (size === 'large' ? 25 : 5) >= n) return null;
  const slope = (b.price - a.price) / base;
  const zone = (atr[a.index] + atr[b.index]) / 4;
  if (!Number.isFinite(zone) || zone <= 0) return null;
  const epsilon = Math.max(1e-10, Math.abs(a.price) * 1e-12);
  const at = (i) => a.price + slope * (i - a.index);
  let run = 0, breakIndex = -1, touches = 0;
  for (let i = a.index; i < n; i++) {
    const linePrice = at(i);
    if (i > a.index && i !== b.index) {
      const behind = (data[i * STRIDE + 3] - linePrice) * side < -epsilon;
      run = behind ? run + 1 : 0;
      if (run >= breakoutBars) {
        if (i < b.index) return null; // A base may not span an already broken line.
        breakIndex = i;
      }
    } else run = 0;
    if (strengths[i] >= 3) {
      const gap = (data[i * STRIDE + (side === 1 ? 2 : 1)] - linePrice) * side;
      if (i > a.index && i < b.index) {
        if (gap < -zone - epsilon) return null;
        // Conservative interpretation of the documented strong-interior-pivot
        // filter: do not draw through an equally strong (or stronger) touch.
        if (strengths[i] >= b.strength && Math.abs(gap) <= zone + epsilon) return null;
      }
      if (Math.abs(gap) <= zone + epsilon) touches++;
    }
    if (breakIndex >= 0) break;
  }
  const end = breakIndex >= 0 ? breakIndex : n - 1;
  const extend = end - b.index <= 2 * base;
  const displayEnd = extend ? end : b.index;
  return {
    side: side === 1 ? 'support' : 'resistance', size,
    a: a.index, b: b.index, end: displayEnd,
    aTimeUS: data[a.index * STRIDE], bTimeUS: data[b.index * STRIDE],
    endTimeUS: data[displayEnd * STRIDE], aPrice: a.price, bPrice: b.price,
    slope, zone, touches, strength: b.strength, length: end - a.index,
    normalizedSlope: Math.abs(slope) / (zone * 2),
    confirmedAtUS: data[(b.index + (size === 'large' ? 25 : 5)) * STRIDE],
    broken: breakIndex >= 0, extend,
    breakTimeUS: breakIndex >= 0 ? data[breakIndex * STRIDE] : null
  };
}

const lineAt = (line, i) => line.aPrice + line.slope * (i - line.a);
const rank = (a, b) => b.touches - a.touches || b.length - a.length ||
  b.strength - a.strength || b.normalizedSlope - a.normalizedSlope || b.b - a.b || b.a - a.a;

export function linesConflict(a, b) {
  if (a.side !== b.side) return false;
  const left = Math.max(a.a, b.a), right = Math.min(a.b, b.b);
  if (right - left <= 0.3 * Math.min(a.b - a.a, b.b - b.a)) return false;
  const d1 = lineAt(a, left) - lineAt(b, left), d2 = lineAt(a, right) - lineAt(b, right);
  return d1 * d2 <= 0 || Math.min(Math.abs(d1), Math.abs(d2)) <= Math.max(a.zone, b.zone);
}

function smallInsideLarge(small, large) {
  return small.side === large.side && small.a >= large.a && small.b <= large.b &&
    Math.abs(lineAt(small, small.a) - lineAt(large, small.a)) <= large.zone &&
    Math.abs(lineAt(small, small.b) - lineAt(large, small.b)) <= large.zone;
}

export function computeAutoTrendlines(input) {
  if (!(input instanceof Float64Array) || input.length % STRIDE) throw new TypeError('Expected packed OHLC trendline input');
  const data = input.subarray(Math.max(0, input.length - TRENDLINE_LIMITS.bars * STRIDE));
  const n = data.length / STRIDE;
  for (let i = 0; i < n; i++) {
    const offset = i * STRIDE;
    const t = data[offset], h = data[offset + 1], l = data[offset + 2], c = data[offset + 3];
    if (!Number.isFinite(t) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || t <= 0 || l <= 0 || h < l || c < l || c > h ||
        (i && t <= data[(i - 1) * STRIDE])) throw new RangeError('Invalid or unordered trendline candles');
  }
  const stats = { bars: n, candidates: 0, accepted: 0, lines: 0 };
  if (n < 24) return { lines: [], stats };
  const atr = wilderATR(data), highs = pivotStrengths(data, true), lows = pivotStrengths(data, false);
  const candidates = [];
  for (const [size, span, multiplier] of [['large', 25, 5], ['small', 5, 2]]) {
    const zigzag = zigZag(data, atr, highs, lows, span, multiplier);
    for (const side of [1, -1]) {
      const points = zigzag.filter((p) => p.side === side).slice(-TRENDLINE_LIMITS.pivotsPerSide);
      for (let j = points.length - 1; j > 0; j--) {
        for (let i = j - 1; i >= 0; i--) {
          stats.candidates++;
          const line = evaluateTrendline(data, atr, side === 1 ? lows : highs, points[i], points[j], size);
          // The existing one-minute canvas displays at most 180 bars. Do not
          // let old, off-screen broken lines crowd current context out of the cap.
          if (line && line.end >= Math.max(0, n - 180)) candidates.push(line);
        }
      }
    }
  }
  stats.accepted = candidates.length;
  // Large-line exclusion is processed first; ranking is lexicographic within
  // each size. Three per side/size keeps both scales represented, at most 12.
  candidates.sort((a, b) => (a.size === b.size ? rank(a, b) : a.size === 'large' ? -1 : 1));
  const lines = [], counts = new Map();
  for (const candidate of candidates) {
    const group = `${candidate.size}:${candidate.side}`;
    if ((counts.get(group) || 0) >= TRENDLINE_LIMITS.perGroup) continue;
    if (lines.some((other) => linesConflict(candidate, other) ||
        (candidate.size === 'small' && other.size === 'large' && smallInsideLarge(candidate, other)))) continue;
    lines.push(candidate);
    counts.set(group, (counts.get(group) || 0) + 1);
    if (lines.length >= TRENDLINE_LIMITS.lines) break;
  }
  stats.lines = lines.length;
  return { lines, stats };
}

function indexAtTime(bars, timeUS) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].timeUS < timeUS) lo = mid + 1; else hi = mid;
  }
  return lo < bars.length && bars[lo].timeUS === timeUS ? lo : -1;
}

// Draw directly into the existing chart with its exact x/y mapping. Never
// touches autoscale, canvas size, candle data, fetch, WebSocket, or prototypes.
export function drawAutoTrendlines(ctx, lines, { bars, start, xAt, priceY, left, right, top, bottom }) {
  if (!lines.length || right <= left || bottom <= top) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  for (const line of lines) {
    const a = indexAtTime(bars, line.aTimeUS), b = indexAtTime(bars, line.bTimeUS);
    const end = indexAtTime(bars, line.endTimeUS);
    if (a < 0 || b <= a || end < start) continue;
    const x1 = xAt(a - start), xb = xAt(b - start);
    const x2 = line.extend && !line.broken ? right : xAt(end - start);
    if (x2 <= left || x1 >= right || xb === x1) continue;
    const y1 = priceY(line.aPrice), yb = priceY(line.bPrice);
    const y2 = y1 + (yb - y1) * (x2 - x1) / (xb - x1);
    if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
    ctx.strokeStyle = line.side === 'support' ? '#39d98a' : '#ffa94d';
    ctx.lineWidth = line.size === 'large' ? 2 : 1.5;
    ctx.globalAlpha = line.broken ? 0.38 : 0.85;
    ctx.setLineDash(line.broken ? [2, 4] : line.size === 'small' ? [6, 4] : []);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.restore();
}
