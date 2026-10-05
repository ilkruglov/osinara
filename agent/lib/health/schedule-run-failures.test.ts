/**
 * Scheduled scenario failures in the owner's digest.
 *
 * Constructs covered:
 * - Runs are grouped per schedule with their stable codes, the most failing schedule first.
 * - A schedule the owner may not see (another member's personal one) arrives without a title and
 *   is only counted, never named and never given codes.
 * - Schedules beyond the first three and codes beyond the first three per schedule are counted.
 * - The line collapses whitespace in a title so one schedule stays on one line.
 */
import { describe, expect, it } from "vitest";

import {
  formatScheduleRunFailures,
  NO_SCHEDULE_RUN_FAILURES,
  summarizeScheduleRunFailures,
} from "./schedule-run-failures.js";

describe("summarizeScheduleRunFailures", () => {
  it("is empty without failed runs", () => {
    expect(summarizeScheduleRunFailures([])).toEqual(NO_SCHEDULE_RUN_FAILURES);
    expect(formatScheduleRunFailures(NO_SCHEDULE_RUN_FAILURES)).toBeNull();
  });

  it("groups visible runs by schedule and counts hidden personal ones without their title or codes", () => {
    const summary = summarizeScheduleRunFailures([
      { code: "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", count: 2, scheduleId: "news", title: "Новости" },
      { code: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", count: 1, scheduleId: "news", title: "Новости" },
      { code: null, count: 1, scheduleId: "rate", title: "Курс" },
      { code: "AGENT_SCHEDULE_DESTINATION_REVOKED", count: 3, scheduleId: "member-secret", title: null },
    ]);
    expect(summary).toEqual({
      count: 7,
      hiddenPersonal: 3,
      otherSchedules: { count: 0, schedules: 0 },
      schedules: [
        {
          codes: [
            { code: "AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING", count: 2 },
            { code: "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS", count: 1 },
          ],
          count: 3,
          otherCodes: 0,
          title: "Новости",
        },
        { codes: [{ code: "unknown", count: 1 }], count: 1, otherCodes: 0, title: "Курс" },
      ],
    });
    const text = formatScheduleRunFailures(summary);
    expect(text).toBe(
      "Сценарии по расписанию: 7 сбоев: «Новости» ×3 (AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING ×2, " +
      "AGENT_SCHEDULE_DELIVERY_AMBIGUOUS ×1); «Курс» ×1 (unknown ×1); " +
      "личные сценарии других участников ×3.",
    );
    expect(text).not.toContain("DESTINATION_REVOKED");
  });

  it("names three schedules and three codes each, and counts the rest", () => {
    const rows = [
      ...["A", "B", "C", "D"].map((code, index) => ({ code: `CODE_${code}`, count: 4 - index, scheduleId: "s1", title: "Первый" })),
      { code: "CODE_X", count: 3, scheduleId: "s2", title: "Второй\n  сценарий" },
      { code: "CODE_X", count: 2, scheduleId: "s3", title: "Третий" },
      { code: "CODE_X", count: 1, scheduleId: "s4", title: "Четвёртый" },
      { code: "CODE_Y", count: 1, scheduleId: "s5", title: "Пятый" },
    ];
    const summary = summarizeScheduleRunFailures(rows);
    expect(summary.schedules.map((schedule) => schedule.title)).toEqual(["Первый", "Второй\n  сценарий", "Третий"]);
    expect(summary.schedules[0]).toEqual({
      codes: [{ code: "CODE_A", count: 4 }, { code: "CODE_B", count: 3 }, { code: "CODE_C", count: 2 }],
      count: 10,
      otherCodes: 1,
      title: "Первый",
    });
    expect(summary.otherSchedules).toEqual({ count: 2, schedules: 2 });
    expect(formatScheduleRunFailures(summary)).toBe(
      "Сценарии по расписанию: 17 сбоев: «Первый» ×10 (CODE_A ×4, CODE_B ×3, CODE_C ×2, другие ×1); " +
      "«Второй сценарий» ×3 (CODE_X ×3); «Третий» ×2 (CODE_X ×2); ещё 2 сценариев ×2.",
    );
  });
});
