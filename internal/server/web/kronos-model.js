// Presentation of model samples, NOT a calibration or execution model.
export const FORECAST_HORIZONS = Object.freeze([1, 3, 5, 10]);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const timeET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const etTime = (ms) => Number.isFinite(ms) ? timeET.format(new Date(ms)) : '—';
export const percent = (p) => finite(p) ? `${Math.round(p * 100)}%` : '—';

export function eventReading(event, { horizon, reference, comparator, paths }) {
  if (!event || event.probability_basis !== 'native_samples' || event.calibrated_probability !== null) throw new Error('Unsupported probability basis');
  const { count_true: yes, count_false: no, count_unknown: unknown, denominator: n, definition: d } = event;
  if (![yes, no, unknown, n].every(Number.isInteger) || Math.min(yes, no, unknown) < 0 || n !== paths || yes + no + unknown !== n) throw new Error('Invalid sample counts');
  if (d?.event !== 'terminal_close' || d.horizon_bars !== horizon || d.reference_price !== reference || d.barrier_price !== reference || d.comparator !== comparator) throw new Error('Event definition does not match the display');
  const [lo, hi] = event.identified_bounds || [];
  if (!finite(lo) || !finite(hi) || Math.abs(lo - yes / n) > 1e-8 || Math.abs(hi - (yes + unknown) / n) > 1e-8) throw new Error('Invalid unknown-path bounds');
  if (unknown) {
    if (event.probability !== null) throw new Error('Unknown paths cannot have exact odds');
    // Conditional frequency among usable paths is not the all-path probability.
    return { unknown, yes, n, value: null, validValue: n > unknown ? yes / (n-unknown) : null, bounds: [lo, hi], interval: null };
  }
  if (!finite(event.probability) || Math.abs(event.probability - yes / n) > 1e-8) throw new Error('Frequency does not match counts');
  // Compute the interval from the counts, never call it real-world confidence.
  const p = yes / n, z = 1.959963984540054, den = 1 + z*z/n;
  const center = (p + z*z/(2*n))/den, radius = z*Math.sqrt(p*(1-p)/n + z*z/(4*n*n))/den;
  return { unknown: 0, yes, n, value: p, validValue: p, bounds: [lo, hi], interval: [Math.max(0, center-radius), Math.min(1, center+radius)] };
}

export function forecastReading(result, horizon, nowUS) {
  if (!FORECAST_HORIZONS.includes(horizon)) throw new Error('Unsupported horizon');
  const origin = Date.parse(result?.forecast_origin), n = result?.paths_attempted, reference = result?.reference_price;
  if (result?.model_id !== 'kronos-base' || result.schema_version !== '1.0' || result.bar_seconds !== 60 || result.reference_kind !== 'last_closed_close' || !['live', 'replay'].includes(result.mode) || !finite(origin) || !Number.isInteger(n) || n < 1 || !finite(reference) || reference <= 0) throw new Error('Unsupported forecast contract');
  if (!['ok', 'late', 'invalid_output'].includes(result.status)) throw new Error('Unsupported forecast status');
  if (result.calibration?.status !== 'not_fitted' || result.calibration?.artifact_id != null || result.expected_value_usd !== null) throw new Error('This panel supports uncalibrated research results only');
  if (!Number.isInteger(result.unique_decoded_paths) || result.unique_decoded_paths < 2) throw new Error('No decoded path diversity; forecast withheld');
  const close = origin + horizon*60000;
  if (Date.parse(result.horizon_close_times?.[String(horizon)]) !== close) throw new Error('Incorrect horizon close time');
  const h = result.horizons?.[String(horizon)];
  if (h?.horizon_bars !== horizon) throw new Error('Missing horizon');
  const options = { horizon, reference, paths: n };
  const above = eventReading(h.close_above_reference, { ...options, comparator: '>' });
  const below = eventReading(h.close_below_reference, { ...options, comparator: '<' });
  const equal = eventReading(h.close_equal_reference, { ...options, comparator: '==' });
  if (above.unknown !== below.unknown || above.unknown !== equal.unknown || above.yes + below.yes + equal.yes + above.unknown !== n) throw new Error('Direction counts are not exhaustive');
  if (h.paths_price_unknown !== above.unknown || h.paths_price_valid !== n-above.unknown) throw new Error('Inconsistent validity counts');
  const age = Math.max(0, (nowUS/1000-origin)/1000);
  const expired = nowUS/1000 < origin || age >= 60; // old origin never masquerades as the current minute
  let median = null;
  if (!above.unknown && h.terminal_return_bps_distribution?.status === 'available') {
    const value = h.terminal_return_bps_distribution.quantiles?.['0.5'];
    if (finite(value)) median = value;
  }
  return { origin, close, reference, n, above, below, equal, age, expired, median,
    shortContext: Number(result.input_bar_count) < 120,
    late: result.status === 'late' || age > 10,
    qualityWarning: (result.invalid_auxiliary_bars > 0) ? 'Invalid generated volume/amount' : '',
    context: result.input_bar_count };
}

export function describeForecastError(state) {
  return ({ key_required: 'KEY REQUIRED', key_rejected: 'KEY REJECTED', disabled: 'DISABLED', configuration: 'CHECK CONFIG',
    unsupported_mode: 'HISTORY UNAVAILABLE', feed_offline: 'FEED OFFLINE', delayed_feed: 'DELAYED DATA', outside_session: 'SESSION CLOSED',
    waiting_bar: 'NEXT CANDLE', running: 'CALCULATING', busy: 'SERVER BUSY', offline: 'KRONOS OFFLINE', not_ready: 'MODEL LOADING',
    history_unavailable: 'HISTORY UNAVAILABLE', input_unavailable: 'HISTORY NOT READY', late_input: 'HISTORY ARRIVED LATE',
    input_rejected: 'INPUT REJECTED', superseded: 'UPDATING SYMBOL', invalid_response: 'INVALID RESPONSE', service_error: 'SERVICE ERROR'
  })[state] || 'FORECAST UNAVAILABLE';
}
