// State is computed once on the server from recorded/live ticks. Drawing never
// discovers events from finished candles, and rewind cannot reveal later states.
export function absorptionZonesAt(snapshot, nowUS) {
  if (!snapshot || !(nowUS > 0)) return [];
  return (snapshot.zones || []).filter(z => z.detected_us <= nowUS && z.expires_us > nowUS &&
    z.low > 0 && z.high >= z.low && ['buy', 'sell'].includes(z.side)).map(z => ({ ...z,
    state: z.broken_us > 0 && z.broken_us <= nowUS ? 'BROKEN'
      : z.held_us > 0 && z.held_us <= nowUS ? 'HELD' : 'TESTING'
  }));
}
export function absorptionDescription(z) {
  return `${z.side === 'buy' ? 'Buyer' : 'Seller'} absorption · ${z.state.toLowerCase()} · ${z.low.toFixed(2)}–${z.high.toFixed(2)} · ${Math.round(z.volume).toLocaleString()} shares in ${z.prints} prints · ${z.relative_volume.toFixed(1)}× usual same-side volume per price band · prior 5-second range ${z.expected_range.toFixed(2)}. Inferred from Level 1; not a confirmed iceberg or a probability.`;
}
export function drawAbsorptionZones(ctx, snapshot, g) {
  const { nowUS, left, right, top, bottom, priceY, timeX } = g;
  const zones = absorptionZonesAt(snapshot, nowUS).filter(z => priceY(z.high) < bottom && priceY(z.low) > top)
    .sort((a,b) => Number(a.state === 'BROKEN')-Number(b.state === 'BROKEN') || b.detected_us-a.detected_us)
    .slice(0, 8).sort((a,b) => a.detected_us-b.detected_us);
  const hits = [], occupied = [];
  ctx.save(); ctx.beginPath(); ctx.rect(left, top, right-left, bottom-top); ctx.clip();
  ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const z of zones) {
    const x = Math.max(left, timeX(z.detected_us));
    const end = z.state === 'BROKEN' ? Math.min(right, timeX(z.broken_us)) : right;
    if (!Number.isFinite(x) || end <= x) continue;
    const y1 = Math.max(top, priceY(z.high)), y2 = Math.min(bottom, priceY(z.low));
    const y = (y1+y2)/2, color = z.side === 'buy' ? '#57d6a0' : '#f28b97';
    const intensity = Math.min(.19, .06 + Math.log2(Math.max(1,z.relative_volume))*.025);
    ctx.fillStyle = color;
    ctx.globalAlpha = z.state === 'BROKEN' ? .04 : intensity;
    ctx.fillRect(x, y1, end-x, Math.max(1,y2-y1));
    ctx.globalAlpha = z.state === 'BROKEN' ? .28 : .8;
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.setLineDash(z.state === 'TESTING' ? [3,3] : z.state === 'BROKEN' ? [1,4] : []);
    ctx.beginPath(); ctx.moveTo(x,y1); ctx.lineTo(end,y1); ctx.moveTo(x,y2); ctx.lineTo(end,y2); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    hits.push({ zone:z, left:x, right:end, top:Math.max(top,y1-5), bottom:Math.min(bottom,y2+5) });
    // Keep labels on their actual price; omit colliding labels rather than move
    // them to a misleading price. All bands remain inspectable on hover.
    if (z.state === 'BROKEN' || occupied.some(p => Math.abs(p-y)<16) || y<top+9 || y>bottom-9) continue;
    const text = `${z.side === 'buy' ? 'BUY' : 'SELL'} ABS ${z.relative_volume.toFixed(1)}× · ${z.state}`;
    const w = ctx.measureText(text).width+10;
    if (right-left<w+10) continue;
    const labelX = Math.max(left+2, right-w-5);
    ctx.fillStyle = '#0c0f13'; ctx.globalAlpha = .92; ctx.fillRect(labelX,y-8,w,16); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.fillText(text,labelX+5,y);
    hits.push({zone:z,left:labelX,right:labelX+w,top:y-8,bottom:y+8}); occupied.push(y);
  }
  ctx.restore(); return hits;
}
export function absorptionHit(hits,x,y) {
  return hits?.findLast(h => x>=h.left && x<=h.right && y>=h.top && y<=h.bottom)?.zone;
}
// Map timestamps to the real candle spacing, including gaps and sub-minute
// detections. A new zone starts at detection time, never at the window's start.
export function absorptionTimeX(bars, xAt, timeOf, intervalUS = 0) {
  return us => {
    let lo=0,hi=bars.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(timeOf(bars[mid])<=us)lo=mid+1;else hi=mid;}
    if (!bars.length) return NaN;
    const i=Math.max(0,lo-1), start=timeOf(bars[i]);
    const next=i+1<bars.length?timeOf(bars[i+1]):start+intervalUS;
    const fraction=next>start?Math.max(0,Math.min(1,(us-start)/(next-start))):0;
    return xAt(i)+fraction*(xAt(i+1)-xAt(i));
  };
}
