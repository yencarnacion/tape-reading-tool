const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export function marketParts(timeUS) {
  if (!Number.isFinite(Number(timeUS)) || Number(timeUS) <= 0) return null;
  const values = Object.fromEntries(ET_PARTS.formatToParts(new Date(Number(timeUS) / 1000)).map((part) => [part.type, part.value]));
  return {
    sessionDateET: `${values.year}-${values.month}-${values.day}`,
    seconds: Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second)
  };
}

export function classifyRTH(timeUS) {
  const parts = marketParts(timeUS);
  if (!parts) return { phase: 'unavailable', sessionDateET: '' };
  const open = 9 * 3600 + 30 * 60;
  const close = 16 * 3600;
  return { phase: parts.seconds < open ? 'before-open' : parts.seconds >= close ? 'closed' : 'open', ...parts };
}

export function validCompletedDailyBar(bar, beforeSessionDateET) {
  const numbers = ['open', 'high', 'low', 'close'].map((key) => Number(bar?.[key]));
  return Boolean(bar?.complete) && /^\d{4}-\d{2}-\d{2}$/.test(String(bar?.sessionDateET || ''))
    && (!beforeSessionDateET || bar.sessionDateET < beforeSessionDateET)
    && numbers.every((value) => Number.isFinite(value) && value > 0)
    && Number(bar.high) >= Number(bar.low);
}

export function calculateADR(bars, lookbackSessions, beforeSessionDateET) {
  const lookback = Math.max(5, Math.min(60, Math.round(Number(lookbackSessions) || 20)));
  const valid = (Array.isArray(bars) ? bars : [])
    .filter((bar) => validCompletedDailyBar(bar, beforeSessionDateET))
    .sort((left, right) => String(left.sessionDateET).localeCompare(String(right.sessionDateET)))
    .slice(-lookback);
  if (valid.length !== lookback) return { status: 'insufficient', lookback, completeSessions: valid.length, adr: null, bars: valid };
  const adr = valid.reduce((sum, bar) => sum + Number(bar.high) / Number(bar.low) - 1, 0) / lookback;
  if (!Number.isFinite(adr) || adr <= 0) return { status: 'unavailable', lookback, completeSessions: valid.length, adr: null, bars: valid };
  return { status: 'ready', lookback, completeSessions: valid.length, adr, bars: valid };
}

export function seedRTHContext(payload, { symbol, sessionDateET } = {}) {
  if (!payload || Number(payload.schemaVersion) !== 1 || payload.symbol !== symbol || payload.sessionDateET !== sessionDateET) return { status: 'stale' };
  if (payload.status === 'before-open') return { status: 'before-open', symbol, sessionDateET };
  if (!payload.completeFromRTHOpen) return { status: payload.status === 'unavailable' ? 'unavailable' : 'incomplete', symbol, sessionDateET };
  const open = Number(payload.open), high = Number(payload.high), low = Number(payload.low), last = Number(payload.last);
  if (![open, high, low, last].every((value) => Number.isFinite(value) && value > 0)) return { status: 'building', symbol, sessionDateET };
  return {
    status: payload.status === 'closed' ? 'closed' : 'ready', symbol, sessionDateET,
    open, high, highTimeUS: Number(payload.highTimeUS) || 0, low, lowTimeUS: Number(payload.lowTimeUS) || 0,
    last, lastTimeUS: Number(payload.lastTimeUS) || 0,
    eligibleTradeCount: Math.max(0, Number(payload.eligibleTradeCount) || 0), completeFromRTHOpen: true
  };
}

export function applyEligibleTrades(context, trades, { symbol, sessionDateET } = {}) {
  if (!context || context.symbol !== symbol || context.sessionDateET !== sessionDateET || !context.completeFromRTHOpen) return context;
  const next = { ...context };
  for (const trade of Array.isArray(trades) ? trades : []) {
    const price = Number(trade?.p), marketUS = Number(trade?.t) * 1000;
    const parts = marketParts(marketUS);
    if (!parts || parts.sessionDateET !== sessionDateET || parts.seconds < 34200 || parts.seconds >= 57600 || !Number.isFinite(price) || price <= 0) continue;
    next.last = price; next.lastTimeUS = marketUS; next.eligibleTradeCount++;
    if (!Number.isFinite(next.high) || price > next.high) { next.high = price; next.highTimeUS = marketUS; }
    if (!Number.isFinite(next.low) || price < next.low) { next.low = price; next.lowTimeUS = marketUS; }
  }
  return next;
}

export function calculateExtension(adrResult, context, requestedMode = 'auto') {
  if (adrResult?.status !== 'ready' || !Number.isFinite(adrResult.adr) || adrResult.adr <= 0) return { status: adrResult?.status || 'unavailable' };
  if (!context?.completeFromRTHOpen) return { status: context?.status || 'incomplete' };
  const open = Number(context.open), high = Number(context.high), low = Number(context.low), last = Number(context.last);
  if (![open, high, low, last].every((value) => Number.isFinite(value) && value > 0)) return { status: 'building' };
  const lowPercent = last / low - 1, highPercent = high / last - 1;
  const mode = ['low', 'high'].includes(requestedMode) ? requestedMode : (last >= open ? 'low' : 'high');
  const percent = mode === 'high' ? highPercent : lowPercent;
  return {
    status: context.status === 'closed' ? 'closed' : 'ready', mode, percent, extension: percent / adrResult.adr,
    lowPercent, lowExtension: lowPercent / adrResult.adr, highPercent, highExtension: highPercent / adrResult.adr
  };
}

export function displayNumber(value, digits = 2) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--';
}
