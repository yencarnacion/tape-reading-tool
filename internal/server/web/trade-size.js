// Keep the narrow tape legible; hover/accessible text retains the six-decimal
// provider quantity. Sub-share executions must never round to a zero-size print.
export function formatTradeSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '—';
  if (size < 1) return '<1';
  if (size >= 1e9) return `${(size / 1e9).toFixed(size >= 1e10 ? 0 : 1)}B`;
  if (size >= 1e6) return `${(size / 1e6).toFixed(size >= 1e7 ? 0 : 1)}M`;
  if (size >= 1e3) return `${(size / 1e3).toFixed(size >= 1e4 ? 0 : 1)}K`;
  return size < 100 ? Number(size.toFixed(2)).toString() : Math.round(size).toString();
}

export function tradeSizeLabel(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 'Size unavailable in this record';
  const quantity = Number(size.toFixed(6)).toString();
  return `${quantity} ${size === 1 ? 'share' : 'shares'}`;
}
