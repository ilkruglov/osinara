/**
 * DeepSeek peak hours.
 *
 * Coverage:
 * - Weekdays 01:00–04:00 and 06:00–10:00 UTC are peak, ends excluded; weekends never are.
 */
import { describe, expect, it } from "vitest";

import { isDeepSeekPeakHour } from "./deepseek-peak-hours.js";

describe("isDeepSeekPeakHour", () => {
  it.each([
    // 24 November 2026 is a Tuesday.
    ["2026-11-24T00:59:59Z", false],
    ["2026-11-24T01:00:00Z", true],
    ["2026-11-24T03:59:59Z", true],
    ["2026-11-24T04:00:00Z", false],
    ["2026-11-24T05:59:59Z", false],
    ["2026-11-24T06:00:00Z", true],
    ["2026-11-24T09:59:59Z", true],
    ["2026-11-24T10:00:00Z", false],
    ["2026-11-24T23:00:00Z", false],
    ["2026-11-27T09:30:00Z", true],
    ["2026-11-28T02:00:00Z", false],
    ["2026-11-29T07:00:00Z", false],
  ])("%s is peak: %s", (at, peak) => {
    expect(isDeepSeekPeakHour(new Date(at))).toBe(peak);
  });
});
