const DAILY_PIVOT_SPECS = Object.freeze([
  { valueKey: 'r3', key: 'R3', color: '#CC79A7', dash: [2, 4], width: 0.8 },
  { valueKey: 'r2', key: 'R2', color: '#D55E00', dash: [6, 4], width: 0.8 },
  { valueKey: 'r1', key: 'R1', color: '#E69F00', dash: [], width: 0.9 },
  { valueKey: 'pp', key: 'PP', color: '#F0E442', dash: [], width: 1.1 },
  { valueKey: 's1', key: 'S1', color: '#009E73', dash: [], width: 0.9 },
  { valueKey: 's2', key: 'S2', color: '#0072B2', dash: [6, 4], width: 0.8 },
  { valueKey: 's3', key: 'S3', color: '#56B4E9', dash: [2, 4], width: 0.8 }
]);

// Classic floor pivots, matching polygon-charts exactly. The caller supplies
// one completed prior regular-session bar (or equivalent RTH candles reduced to
// high, low, and final close). No current-session value enters this calculation.
export function calculateDailyPivots(session) {
  const high = Number(session?.high);
  const low = Number(session?.low);
  const close = Number(session?.close);
  if (![high, low, close].every(Number.isFinite) || high <= 0 || low <= 0 || close <= 0 || high < low) return null;
  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low,
    s1: 2 * pp - high,
    r2: pp + (high - low),
    s2: pp - (high - low),
    r3: high + 2 * (pp - low),
    s3: low - 2 * (high - pp),
    priorRange: high - low
  };
}

export function dailyPivotLevels(pivots) {
  if (!pivots) return [];
  return DAILY_PIVOT_SPECS
    .map((spec) => ({ ...spec, price: Number(pivots[spec.valueKey]) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0);
}

export function dailyPivotProximity(levels, currentPrice, priceY = null, priorRange = 0) {
  const last = Number(currentPrice);
  if (!Number.isFinite(last) || last <= 0 || !Array.isArray(levels) || !levels.length) return null;
  let nearest = null;
  for (const level of levels) {
    const price = Number(level.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const distance = Math.abs(last - price);
    if (!nearest || distance < nearest.distance) nearest = { level, distance };
  }
  if (!nearest) return null;
  const pixelDistance = typeof priceY === 'function'
    ? Math.abs(Number(priceY(last)) - Number(priceY(nearest.level.price)))
    : Infinity;

  // A dual threshold avoids the two common failures of a fixed-dollar alert:
  // it scales across $1 and $500 stocks, and it respects what is visually close
  // on the trader's current chart. The RTH-range component adapts to volatility
  // but is capped so an extreme prior day cannot make "near" mean several percent.
  const priceFloor = last * 0.0015;
  const priceCeiling = last * 0.004;
  const rangeScaled = Math.max(0, Number(priorRange) || 0) * 0.04;
  const normalizedThreshold = Math.max(priceFloor, Math.min(priceCeiling, rangeScaled || priceFloor));
  return {
    ...nearest,
    signedPercent: (last - nearest.level.price) / nearest.level.price * 100,
    pixelDistance,
    normalizedThreshold,
    near: nearest.distance <= normalizedThreshold || pixelDistance <= 22
  };
}

// Returns the small, decision-useful pivot set for an intraday chart:
// - away from a pivot: nearest pivot above and nearest pivot below price;
// - near/at a pivot: that pivot plus the next pivot above and below it.
// A selected context level is displayed only if it is already in the viewport or
// close enough to deserve a non-scaling edge cue. This keeps distant pivots from
// forcing visual compression or turning the chart into a seven-line ladder.
export function selectDailyPivotContext(
  levels, currentPrice, priceY = null, priorRange = 0, minimum = NaN, maximum = NaN
) {
  const last = Number(currentPrice);
  const ordered = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ ...level, price: Number(level?.price) }))
    .filter((level) => Number.isFinite(level.price) && level.price > 0)
    .sort((left, right) => left.price - right.price);
  if (!Number.isFinite(last) || last <= 0 || !ordered.length) {
    return { near: null, up: null, down: null, selected: [], contextDistanceLimit: 0, proximity: null };
  }

  const proximity = dailyPivotProximity(ordered, last, priceY, priorRange);
  const nearLevel = proximity?.near ? proximity.level : null;
  const anchor = nearLevel ? Number(nearLevel.price) : last;
  const epsilon = Math.max(1e-9, last * 1e-9);
  const upLevel = ordered.find((level) => level.price > anchor + epsilon) || null;
  const downLevel = ordered.slice().reverse().find((level) => level.price < anchor - epsilon) || null;

  const low = Number(minimum);
  const high = Number(maximum);
  const hasViewport = Number.isFinite(low) && Number.isFinite(high) && high > low;
  const viewportSpan = hasViewport ? high - low : 0;
  // Edge cues are useful when a nearby structural level sits just outside a
  // tight chart. The allowance follows the current viewport, has a 0.75% floor,
  // and is capped at 3% of price so a remote pivot is intentionally omitted.
  const contextDistanceLimit = Math.min(
    last * 0.03,
    Math.max(last * 0.0075, viewportSpan * 0.75)
  );

  const decorate = (level, role) => {
    if (!level) return null;
    const price = Number(level.price);
    const distance = Math.abs(price - last);
    const lineY = typeof priceY === 'function' ? Number(priceY(price)) : NaN;
    const inView = hasViewport && price >= low && price <= high;
    const direction = price > high ? 'above' : price < low ? 'below' : '';
    return {
      ...level,
      role,
      distance,
      percentAway: distance / last * 100,
      signedTargetPercent: (price - last) / last * 100,
      lineY,
      inView,
      direction,
      display: role === 'near' || inView || distance <= contextDistanceLimit
    };
  };

  const near = decorate(nearLevel, 'near');
  const up = decorate(upLevel, 'up');
  const down = decorate(downLevel, 'down');
  return {
    near,
    up,
    down,
    selected: [near, up, down].filter((level) => level?.display),
    contextDistanceLimit,
    proximity
  };
}

export function layoutDailyPivotLabels(items, top, bottom, blockedY = [], minimumGap = 17) {
  const lower = Number(top) + 8;
  const upper = Number(bottom) - 8;
  if (!Array.isArray(items) || !items.length || !Number.isFinite(lower) || !Number.isFinite(upper) || upper < lower) return [];
  const placed = items
    .map((item) => ({ ...item, labelY: Math.max(lower, Math.min(upper, Number(item.lineY))) }))
    .filter((item) => Number.isFinite(item.labelY))
    .sort((a, b) => a.labelY - b.labelY);
  for (let index = 1; index < placed.length; index++) {
    placed[index].labelY = Math.max(placed[index].labelY, placed[index - 1].labelY + minimumGap);
  }
  const overflow = placed.at(-1).labelY - upper;
  if (overflow > 0) for (const item of placed) item.labelY -= overflow;
  for (let index = placed.length - 2; index >= 0; index--) {
    placed[index].labelY = Math.min(placed[index].labelY, placed[index + 1].labelY - minimumGap);
  }
  const underflow = lower - placed[0].labelY;
  if (underflow > 0) for (const item of placed) item.labelY += underflow;

  const blockers = (Array.isArray(blockedY) ? blockedY : []).map(Number).filter(Number.isFinite);
  for (let index = 0; index < placed.length; index++) {
    const item = placed[index];
    const lowAllowed = index === 0 ? lower : placed[index - 1].labelY + minimumGap;
    const highAllowed = index === placed.length - 1 ? upper : placed[index + 1].labelY - minimumGap;
    for (const blocker of blockers) {
      if (Math.abs(item.labelY - blocker) >= minimumGap) continue;
      const candidates = [blocker - minimumGap, blocker + minimumGap]
        .filter((value) => value >= lowAllowed && value <= highAllowed)
        .sort((a, b) => Math.abs(a - item.labelY) - Math.abs(b - item.labelY));
      if (candidates.length) item.labelY = candidates[0];
    }
  }
  return placed;
}

export function drawDailyPivotLines(chartContext, options = {}) {
  const {
    levels = [], priceY, minimum, maximum, left, right, currentPrice,
    priorRange = 0, top, bottom
  } = options;
  if (!chartContext || typeof priceY !== 'function') return;
  const context = selectDailyPivotContext(levels, currentPrice, priceY, priorRange, minimum, maximum);
  const visible = context.selected.filter((level) => level.inView);
  if (!visible.length) return;

  chartContext.save();
  for (const level of visible) {
    const y = Number(level.lineY);
    if (!Number.isFinite(y) || y < top || y > bottom) continue;
    const active = level.role === 'near';
    if (active) {
      chartContext.fillStyle = level.color;
      chartContext.globalAlpha = 0.07;
      chartContext.fillRect(left, y - 3, Math.max(0, right - left), 6);
    }
    chartContext.strokeStyle = level.color;
    chartContext.globalAlpha = active ? 0.68 : 0.34;
    chartContext.lineWidth = active ? 1.4 : Math.max(0.9, Number(level.width) || 1);
    chartContext.setLineDash(level.dash || []);
    chartContext.beginPath();
    chartContext.moveTo(left, y);
    chartContext.lineTo(right, y);
    chartContext.stroke();
  }
  chartContext.restore();
}

export function drawDailyPivotLabels(chartContext, options = {}) {
  const {
    levels = [], priceY, minimum, maximum, left, currentPrice, priorRange = 0,
    top, bottom, background = '#0c0f13', formatPrice = (value) => String(value), blockedY = []
  } = options;
  if (!chartContext || typeof priceY !== 'function') return;
  const context = selectDailyPivotContext(levels, currentPrice, priceY, priorRange, minimum, maximum);
  if (!context.selected.length) return;
  const visible = context.selected.filter((level) => level.inView);
  const edge = context.selected.filter((level) => !level.inView);
  const placed = layoutDailyPivotLabels(visible, top, bottom, blockedY);

  chartContext.save();
  chartContext.textAlign = 'left';
  chartContext.textBaseline = 'middle';
  for (const level of placed) drawLabel(level, level.labelY, false);

  const occupied = [
    ...placed.map((level) => level.labelY),
    ...(Array.isArray(blockedY) ? blockedY : []).map(Number).filter(Number.isFinite)
  ];
  const above = edge.filter((level) => level.direction === 'above')
    .sort((leftLevel, rightLevel) => leftLevel.price - rightLevel.price);
  const below = edge.filter((level) => level.direction === 'below')
    .sort((leftLevel, rightLevel) => rightLevel.price - leftLevel.price);
  above.forEach((level, index) => drawLabel(level, edgeLabelY('above', index, occupied), true));
  below.forEach((level, index) => drawLabel(level, edgeLabelY('below', index, occupied), true));
  chartContext.restore();

  function labelText(level, edgeLabel) {
    const atLevel = level.role === 'near' && level.percentAway < 0.005;
    const distance = atLevel ? '' : ` · ${level.percentAway.toFixed(2)}%`;
    if (level.role === 'near') {
      const edgeArrow = edgeLabel ? (level.direction === 'above' ? ' ↑' : ' ↓') : '';
      return `${atLevel ? 'AT' : 'NEAR'}${edgeArrow} ${level.key} ${formatPrice(level.price)}${distance}`;
    }
    return `${level.role === 'up' ? '↑' : '↓'} ${level.key} ${formatPrice(level.price)}${distance}`;
  }

  function drawLabel(level, labelY, edgeLabel) {
    const active = level.role === 'near';
    const label = labelText(level, edgeLabel);
    chartContext.font = active
      ? '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      : '700 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const labelWidth = chartContext.measureText(label).width + 10;
    const labelHeight = active ? 17 : 15;
    if (!edgeLabel && Math.abs(labelY - level.lineY) > 1) {
      chartContext.strokeStyle = level.color;
      chartContext.globalAlpha = active ? 0.72 : 0.42;
      chartContext.lineWidth = 0.8;
      chartContext.setLineDash([]);
      chartContext.beginPath();
      chartContext.moveTo(left + 2, level.lineY);
      chartContext.lineTo(left + 5, labelY);
      chartContext.stroke();
    }
    chartContext.fillStyle = background;
    chartContext.globalAlpha = active ? 0.96 : 0.88;
    chartContext.fillRect(left + 3, labelY - labelHeight / 2, labelWidth, labelHeight);
    chartContext.fillStyle = level.color;
    chartContext.globalAlpha = active ? 1 : 0.92;
    chartContext.fillText(label, left + 8, labelY);
  }

  function edgeLabelY(direction, index, occupied) {
    const step = 18;
    const lower = Number(top) + 9;
    const upper = Number(bottom) - 9;
    let y = direction === 'above' ? lower + index * step : upper - index * step;
    const delta = direction === 'above' ? step : -step;
    for (let attempts = 0; attempts < 8 && occupied.some((value) => Math.abs(value - y) < 16); attempts++) y += delta;
    y = Math.max(lower, Math.min(upper, y));
    occupied.push(y);
    return y;
  }
}

export { DAILY_PIVOT_SPECS };
