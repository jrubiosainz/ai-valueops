export const number = (value) => Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : 'Unavailable';
export const money = (value) => Number.isFinite(value) ? `$${value.toFixed(7)}` : 'Unavailable';
export const rate = (result) => result && Number.isFinite(result.passed) && Number.isFinite(result.total) ?
  `${number(result.passed)}/${number(result.total)}` : 'Unavailable';
export const duration = (value) => Number.isFinite(value) ? `${number(value)} ms` : 'Unavailable';
export const date = (value) => Number.isFinite(Date.parse(value)) ?
  new Date(value).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Unavailable';
export function reduction(value) {
  return Number.isFinite(value) ? `${Math.abs(value).toFixed(1)}% ${value >= 0 ? 'lower' : 'higher'}` : 'Unavailable';
}
export function latencyChange(baseline, candidate) {
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(candidate)) return 'Latency comparison unavailable';
  const change = (candidate / baseline - 1) * 100;
  return change === 0 ? 'No median change' : `${Math.abs(change).toFixed(1)}% ${change > 0 ? 'slower' : 'faster'} median`;
}
