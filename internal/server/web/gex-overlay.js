import { gexMoney } from './gex-model.js';

export const GEX_COLORS = Object.freeze({ positive: '#59d4c8', negative: '#efb06a', zero: '#8d96a2' });
const strikePrice = value => value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

// Pixel geometry only. The caller owns the candle price range; options strikes
// must never expand that range or displace candles, studies, or the price axis.
export function gexOverlayGeometry(strikes, { priceY, left, right, top, bottom, side = 'right' }) {
  const width = Math.min(210, (right - left) * .38);
  const edge = side === 'left' ? left + 8 : right - width - 8;
  const baseline = edge + width / 2;
  const half = Math.max(0, width / 2 - 4);
  const visible = strikes.map(bucket => ({ ...bucket, y: priceY(bucket.strike) }))
    .filter(bucket => Number.isFinite(bucket.y) && bucket.y >= top && bucket.y <= bottom)
    .sort((a, b) => a.y - b.y);
  const scaleMax = visible.reduce((max, bucket) => Math.max(max, Math.abs(bucket.net)), 0);
  const rows = visible.map((bucket, index) => {
    const gap = Math.min(index ? bucket.y - visible[index - 1].y : Infinity,
      index + 1 < visible.length ? visible[index + 1].y - bucket.y : Infinity);
    const height = Math.min(6, Math.max(.5, gap * .6));
    const barWidth = scaleMax ? Math.abs(bucket.net) / scaleMax * half : 0;
    return { ...bucket, x: baseline - (bucket.net < 0 ? barWidth : 0), width: barWidth, height, baseline,
      color: GEX_COLORS[bucket.net > 0 ? 'positive' : bucket.net < 0 ? 'negative' : 'zero'],
      label: `${strikePrice(bucket.strike)}  ${gexMoney(bucket.net)}` };
  });
  return { rows, left, right, top, bottom, scaleMax, baseline, profileLeft: edge, profileRight: edge + width };
}

export function drawGEXOverlay(ctx, strikes, plot) {
  const geometry = gexOverlayGeometry(strikes, plot);
  const { rows, left, right, top, bottom, baseline, profileLeft, profileRight } = geometry;
  if (!rows.length) return geometry;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  ctx.strokeStyle = '#56636f'; ctx.globalAlpha = .5; ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.moveTo(baseline, top); ctx.lineTo(baseline, bottom); ctx.stroke();
  ctx.setLineDash([]);
  for (const row of rows) {
    ctx.fillStyle = row.color; ctx.strokeStyle = row.color;
    ctx.globalAlpha = .38;
    ctx.fillRect(row.x, row.y - row.height / 2, row.width, row.height);
    ctx.globalAlpha = .85; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(row.x, row.y); ctx.lineTo(row.x + row.width, row.y); ctx.stroke();
    // A zero-net strike is still a strike, but never gets a fabricated bar.
    if (row.net === 0) ctx.fillRect(baseline - 1, row.y - 1, 2, 2);
  }
  ctx.restore();
  return geometry;
}

// Labels are painted after candles/indicators so thin chart lines cannot erase
// the strike or signed amount. Bars themselves remain behind the price action.
export function drawGEXOverlayLabels(ctx, geometry) {
  if (!geometry?.rows.length) return;
  const { rows, left, right, top, bottom, profileLeft } = geometry;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  ctx.globalAlpha = 1;
  ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
  // Show every bar. Resolve text collisions in favor of larger concentrations.
  const labels = [];
  for (const row of [...rows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))) {
    if (row.y - 16 < top || labels.some(y => Math.abs(row.y - y) < 18)) continue;
    labels.push(row.y);
    const textWidth = ctx.measureText(row.label).width;
    const x = Math.max(left, Math.min(profileLeft, right - textWidth - 6));
    ctx.fillStyle = 'rgba(12,15,19,.85)'; ctx.fillRect(x, row.y - 16, textWidth + 6, 12);
    ctx.fillStyle = row.color; ctx.fillText(row.label, x + 3, row.y - 4);
    row.labelBox = { x, y: row.y - 16, width: textWidth + 6, height: 12 };
  }
  ctx.restore();
}

export function gexOverlayHit(geometry, x, y) {
  if (!geometry || x < geometry.left || x > geometry.right || y < geometry.top || y > geometry.bottom) return null;
  const candidates = geometry.rows.filter(row => {
    const label = row.labelBox;
    return (x >= geometry.profileLeft && x <= geometry.profileRight && Math.abs(y - row.y) <= 5) ||
      (label && x >= label.x && x <= label.x + label.width && y >= label.y && y <= label.y + label.height);
  });
  return candidates.sort((a, b) => Math.abs(y - a.y) - Math.abs(y - b.y))[0] || null;
}

export function gexOverlayDescription(row, result) {
  const at = new Date(result.asOfMS).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
  return `${result.symbol} strike $${strikePrice(row.strike)} · net ${gexMoney(row.net)} (calls ${gexMoney(row.call)}, puts ${gexMoney(row.put)}) per 1% stock move. 0–${result.maxDTE} days · ${at} ET${result.replay ? ' recorded' : ''}. Calls+/puts− assumed; not actual dealer inventory. Bars scaled to the largest visible net exposure.`;
}
