/**
 * DeepSeek's peak hours, when its API costs twice as much.
 *
 * Export:
 * - `isDeepSeekPeakHour`: weekdays 01:00–04:00 and 06:00–10:00 UTC (api-docs.deepseek.com,
 *   quick_start/pricing, 23 November 2026). Background work (person card builds, silent memory
 *   review) takes nothing new then; Chinese public holidays, off-peak all day, are not known here
 *   and only wait as a weekday does (owner, 23 November 2026).
 */
const PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [
  [1, 4],
  [6, 10],
];

export function isDeepSeekPeakHour(now: Date): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return PEAK_WINDOWS_UTC.some(([from, to]) => hour >= from && hour < to);
}
