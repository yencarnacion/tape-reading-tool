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
  const normalizedThreshold = Math.max(last * 0.002, Math.max(0, Number(priorRange) || 0) * 0.05);
  return {
    ...nearest,
    signedPercent: (last - nearest.level.price) / nearest.level.price * 100,
    pixelDistance,
    near: nearest.distance <= normalizedThreshold || pixelDistance <= 24
  };
}

export function layoutDailyPivotLabels(items, top, bottom, blockedY = [], minimumGap = 14) {
  const lower = Number(top) + 7;
  const upper = Number(bottom) - 7;
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
  const visible = levels.filter((level) => level.price >= minimum && level.price <= maximum);
  if (!visible.length) return;
  const proximity = dailyPivotProximity(levels, currentPrice, priceY, priorRange);

  chartContext.save();
  for (const level of visible) {
    const y = priceY(level.price);
    if (!Number.isFinite(y) || y < top || y > bottom) continue;
    const active = proximity?.near && proximity.level.key === level.key;
    if (active) {
      chartContext.fillStyle = level.color;
      chartContext.globalAlpha = 0.065;
      chartContext.fillRect(left, y - 3, Math.max(0, right - left), 6);
    }
    chartContext.strokeStyle = level.color;
    chartContext.globalAlpha = active ? 0.62 : level.key === 'PP' ? 0.28 : 0.18;
    chartContext.lineWidth = active ? 1.35 : level.width;
    chartContext.setLineDash(level.dash);
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
  const visible = levels.filter((level) => level.price >= minimum && level.price <= maximum);
  if (!visible.length) return;
  const proximity = dailyPivotProximity(levels, currentPrice, priceY, priorRange);
  const items = visible.map((level) => ({ ...level, lineY: priceY(level.price) }));
  const placed = layoutDailyPivotLabels(items, top, bottom, blockedY);

  chartContext.save();
  chartContext.textAlign = 'left';
  chartContext.textBaseline = 'middle';
  for (const level of placed) {
    const active = proximity?.near && proximity.level.key === level.key;
    const atLevel = active && Math.abs(proximity.signedPercent) < 0.005;
    const distance = active
      ? atLevel ? 'AT' : `${proximity.signedPercent > 0 ? '+' : proximity.signedPercent < 0 ? '−' : ''}${Math.abs(proximity.signedPercent).toFixed(2)}%`
      : '';
    const label = active
      ? `${level.key} ${formatPrice(level.price)} · ${distance}`
      : level.key;
    chartContext.font = active
      ? '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      : '800 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const labelWidth = chartContext.measureText(label).width + (active ? 10 : 8);
    const labelHeight = active ? 16 : 13;
    if (Math.abs(level.labelY - level.lineY) > 1) {
      chartContext.strokeStyle = level.color;
      chartContext.globalAlpha = active ? 0.7 : 0.35;
      chartContext.lineWidth = 0.8;
      chartContext.setLineDash([]);
      chartContext.beginPath();
      chartContext.moveTo(left + 2, level.lineY);
      chartContext.lineTo(left + 5, level.labelY);
      chartContext.stroke();
    }
    chartContext.fillStyle = background;
    chartContext.globalAlpha = active ? 0.94 : 0.80;
    chartContext.fillRect(left + 3, level.labelY - labelHeight / 2, labelWidth, labelHeight);
    chartContext.fillStyle = level.color;
    chartContext.globalAlpha = active ? 1 : 0.86;
    chartContext.fillText(label, left + (active ? 8 : 7), level.labelY);
  }
  chartContext.restore();
}

export { DAILY_PIVOT_SPECS };
