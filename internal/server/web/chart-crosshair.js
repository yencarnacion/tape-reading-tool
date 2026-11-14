// A pointer-only overlay. It never redraws candles, reads trades, or changes a
// chart scale; each renderer supplies the geometry it actually painted.
const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const tickFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric'
});

export function crosshairReading(geometry, point) {
  if (!geometry || !point) return null;
  const { left, right, top, bottom, priceBottom, minimum, maximum, step, count, timeAt } = geometry;
  if (![point.x, point.y, left, right, top, bottom, priceBottom, minimum, maximum, step].every(Number.isFinite) ||
      step <= 0 || count < 1 || maximum <= minimum || priceBottom <= top ||
      point.x < left || point.x > right || point.y < top || point.y > bottom) return null;
  // Snap the vertical guide to a real candle, including in the right margin.
  // No time or OHLC is invented for an unrecorded/future candle.
  const index = Math.max(0, Math.min(count - 1, Math.floor((point.x - left) / step)));
  const time = timeAt(index);
  if (!Number.isFinite(time)) return null;
  return {
    index, time, x: left + (index + .5) * step, y: point.y,
    price: point.y <= priceBottom ? maximum - (point.y - top) / (priceBottom - top) * (maximum - minimum) : null
  };
}

export function createChartCrosshair(canvas, formatPrice) {
  const overlay = document.createElement('div');
  overlay.className = 'chart-crosshair';
  overlay.dataset.canvas = canvas.id;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.hidden = true;
  const parts = {};
  for (const name of ['vertical', 'horizontal', 'price', 'time']) {
    const part = document.createElement('span');
    part.className = `crosshair-${name}`;
    overlay.append(part);
    parts[name] = part;
  }
  canvas.parentElement.append(overlay);
  canvas.classList.add('has-crosshair');
  let geometry = null, pointer = null, pending = false;
  function hide() { pointer = null; overlay.hidden = true; }
  function paint() {
    pending = false;
    if (!pointer || !geometry || canvas.hidden || !canvas.getClientRects().length) {
      overlay.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const reading = crosshairReading(geometry, { x: pointer.x - rect.left, y: pointer.y - rect.top });
    if (!reading) { overlay.hidden = true; return; }
    const g = geometry;
    overlay.hidden = false;
    parts.vertical.style.cssText = `left:${reading.x}px;top:${g.top}px;height:${g.bottom-g.top}px`;
    parts.horizontal.hidden = parts.price.hidden = reading.price === null;
    if (reading.price !== null) {
      parts.horizontal.style.cssText = `left:${g.left}px;top:${reading.y}px;width:${g.right-g.left}px`;
      parts.price.textContent = formatPrice(reading.price);
      parts.price.style.cssText = `left:${g.right}px;top:${Math.max(g.top, Math.min(g.priceBottom-18, reading.y-9))}px;max-width:${g.width-g.right}px`;
    }
    parts.time.textContent = (g.period === 'daily' ? dayFormat : g.period === 'tick' ? tickFormat : clockFormat).format(new Date(reading.time)) + (g.period === 'daily' ? '' : ' ET');
    const half = parts.time.offsetWidth / 2;
    parts.time.style.left = `${Math.max(half+2, Math.min(g.width-half-2, reading.x))}px`;
    parts.time.style.top = `${Math.min(g.height-18, g.bottom+1)}px`;
  }
  function schedule() {
    if (!pending) { pending = true; requestAnimationFrame(paint); }
  }
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  });
  canvas.addEventListener('pointerleave', hide);
  canvas.addEventListener('pointercancel', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', hide);
  return {
    update(value) { geometry = value; if (!value) hide(); else if (pointer) schedule(); },
    clear() { geometry = null; hide(); }
  };
}
