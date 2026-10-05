/**
 * Failed scheduled scenarios for the owner's daily health digest.
 *
 * Exports:
 * - `ScheduleRunFailureRow`: one (schedule, code) group of failed runs as the repository reads it.
 * - `ScheduleRunFailures` / `NO_SCHEDULE_RUN_FAILURES`: the bounded summary the digest prints.
 * - `summarizeScheduleRunFailures`: groups rows per schedule, keeps three schedules and three codes.
 * - `formatScheduleRunFailures`: one digest line, or null on a day without failed runs.
 *
 * Key constructs:
 * - A scheduled scenario that failed is a result the family did not get, and nobody else sees it:
 *   the run fails after the turn, with no message in any chat (upstream nyxandro/osinara #307).
 * - Privacy: another member's personal schedule reaches this module without a title (the SQL
 *   never selects it) and is printed as a bare count, without codes, like the personal schedules
 *   the family group cannot see (`agentScheduleVisibleInChat`).
 * - `AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING` is a failure here, not routine silence: a
 *   scheduled run has no silence directive and is told to always answer with a ready message, so
 *   a turn that ends without delivery is a scenario the family did not receive.
 */

export interface ScheduleRunFailureRow {
  code: string | null;
  count: number;
  scheduleId: string;
  /** Null when the owner may not see the schedule: another member's personal one. */
  title: string | null;
}

export interface ScheduleRunFailures {
  count: number;
  hiddenPersonal: number;
  otherSchedules: { count: number; schedules: number };
  schedules: { codes: { code: string; count: number }[]; count: number; otherCodes: number; title: string }[];
}

export const NO_SCHEDULE_RUN_FAILURES: ScheduleRunFailures = {
  count: 0,
  hiddenPersonal: 0,
  otherSchedules: { count: 0, schedules: 0 },
  schedules: [],
};

const NAMED_SCHEDULES = 3;
const NAMED_CODES = 3;

function byCountThen<T extends { count: number }>(key: (entry: T) => string) {
  return (left: T, right: T) => right.count - left.count || key(left).localeCompare(key(right));
}

export function summarizeScheduleRunFailures(rows: readonly ScheduleRunFailureRow[]): ScheduleRunFailures {
  let hiddenPersonal = 0;
  const visible = new Map<string, { codes: { code: string; count: number }[]; count: number; title: string }>();
  for (const row of rows) {
    if (row.title === null) {
      hiddenPersonal += row.count;
      continue;
    }
    const schedule = visible.get(row.scheduleId) ?? { codes: [], count: 0, title: row.title };
    schedule.codes.push({ code: row.code ?? "unknown", count: row.count });
    schedule.count += row.count;
    visible.set(row.scheduleId, schedule);
  }
  const ordered = [...visible.values()].sort(byCountThen((schedule) => schedule.title));
  const named = ordered.slice(0, NAMED_SCHEDULES).map((schedule) => {
    const codes = [...schedule.codes].sort(byCountThen((entry) => entry.code));
    const shown = codes.slice(0, NAMED_CODES);
    return {
      codes: shown,
      count: schedule.count,
      otherCodes: schedule.count - shown.reduce((sum, entry) => sum + entry.count, 0),
      title: schedule.title,
    };
  });
  const rest = ordered.slice(NAMED_SCHEDULES);
  return {
    count: rows.reduce((sum, row) => sum + row.count, 0),
    hiddenPersonal,
    otherSchedules: { count: rest.reduce((sum, schedule) => sum + schedule.count, 0), schedules: rest.length },
    schedules: named,
  };
}

export function formatScheduleRunFailures(failures: ScheduleRunFailures): string | null {
  if (failures.count === 0) return null;
  const parts = failures.schedules.map((schedule) => {
    const codes = schedule.codes.map((entry) => `${entry.code} ×${entry.count}`);
    if (schedule.otherCodes > 0) codes.push(`другие ×${schedule.otherCodes}`);
    // A title is the owner's own text; one schedule must stay one line of the digest.
    return `«${schedule.title.replace(/\s+/gu, " ").trim()}» ×${schedule.count} (${codes.join(", ")})`;
  });
  if (failures.otherSchedules.schedules > 0) {
    parts.push(`ещё ${failures.otherSchedules.schedules} сценариев ×${failures.otherSchedules.count}`);
  }
  if (failures.hiddenPersonal > 0) parts.push(`личные сценарии других участников ×${failures.hiddenPersonal}`);
  return `Сценарии по расписанию: ${failures.count} сбоев: ${parts.join("; ")}.`;
}
