// Human-readable byte size using binary units (1 KB = 1024 B), which is what
// matters here: the numbers come from Postgres row sizes, not disk marketing.
// One decimal below 10 of a unit, whole numbers above - "1.4 MB" is useful,
// "847.3 MB" is noise.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
