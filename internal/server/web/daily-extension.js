// Daily close-to-close run and developing BB(20,2). The current session is
// represented once, by the price already shown in LAST. No future daily bars.
export function dailyExtension(history, sessionDate, currentPrice) {
  const valid = value => Number.isFinite(value) && value > 0;
  const dates = new Map();
  for (const bar of history) {
    if (bar.sessionDateET && bar.sessionDateET < sessionDate) dates.set(bar.sessionDateET, Number(bar.close));
  }
  const closes = [...dates].sort(([a], [b]) => a.localeCompare(b)).map(([, close]) => close);
  const result = { streakReady: false, days: 0, direction: 0, atLeast: false, bbReady: false,
    extension: 0, mean: null, upper: null, lower: null };
  if (!valid(currentPrice) || !closes.length || !valid(closes.at(-1))) return result;
  result.streakReady = true;
  let last = currentPrice;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (!valid(closes[i])) break;
    const direction = Math.sign(last - closes[i]);
    if (!direction || result.days && direction !== result.direction) break;
    result.direction = direction;
    result.days++;
    result.atLeast = i === 0;
    last = closes[i];
  }
  if (closes.length < 19) return result;
  const window = [...closes.slice(-19), currentPrice];
  if (!window.every(valid)) return result;
  result.mean = window.reduce((sum, close) => sum + close / 20, 0);
  const sd = Math.sqrt(window.reduce((sum, close) => sum + (close - result.mean) ** 2 / 20, 0));
  result.upper = result.mean + 2 * sd;
  result.lower = result.mean - 2 * sd;
  if (!valid(result.upper) || !valid(result.lower)) return result;
  result.bbReady = true;
  if (currentPrice > result.upper) result.extension = (currentPrice / result.upper - 1) * 100;
  else if (currentPrice < result.lower) result.extension = (currentPrice / result.lower - 1) * 100;
  return result;
}

export function dailyExtensionLabels(value) {
  const arrow = direction => direction > 0 ? '↑' : '↓';
  return {
    run: !value.streakReady ? '—' : !value.days ? 'FLAT' : `${arrow(value.direction)}${value.days}${value.atLeast ? '+' : ''}D*`,
    band: !value.bbReady ? '—' : !value.extension ? 'IN' : `${arrow(value.extension)}${Math.abs(value.extension).toFixed(1)}%`,
    runTitle: !value.streakReady ? 'Daily run unavailable: waiting for current-session price and prior daily closes.' :
      `${value.atLeast ? 'At least ' : ''}${value.days} consecutive ${value.direction < 0 ? 'down' : 'up'} close-to-close days; * includes today at LAST, still developing. An unchanged close breaks the run.`,
    bandTitle: !value.bbReady ? 'Daily BB unavailable: needs 19 completed daily closes and current-session LAST.' :
      `Daily BB(20,2): ${Math.abs(value.extension).toFixed(2)}% ${value.extension > 0 ? 'above upper' : value.extension < 0 ? 'below lower' : 'outside (inside bands)'}. Upper ${value.upper.toFixed(2)}, lower ${value.lower.toFixed(2)}. 19 prior closes + developing LAST; population standard deviation.`,
  };
}
