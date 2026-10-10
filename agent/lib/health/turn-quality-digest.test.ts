/**
 * Turn quality digest line tests.
 *
 * Constructs covered:
 * - A normal day is one information line with the three levels; a day without turns says so.
 * - Failed turns, process signals or corrections above their thresholds make it a warning.
 * - More than one version in the window is named with its turns and failures.
 */
import { describe, expect, it } from "vitest";

import type { TurnQualitySummary } from "../turn-quality/turn-evaluation-repository.js";
import { formatTurnQuality } from "./turn-quality-digest.js";

const quiet: TurnQualitySummary = {
  delivered: 40,
  failed: 1,
  failedToolTurns: 2,
  followUps: { corrections: 3, repliesToMia: 9 },
  forbiddenTool: 0,
  heavy: 4,
  loops: 1,
  reactions: { negative: 1, other: 2, positive: 7 },
  repeatAfterError: 0,
  turns: 50,
  versions: [{ failed: 1, softwareVersion: "1.8.35", turns: 50 }],
};

describe("formatTurnQuality", () => {
  it("describes a normal day as information", () => {
    expect(formatTurnQuality(quiet)).toEqual({
      text: "Ходы: 50, сбоев 1 (2 %), с упавшим инструментом 2, тяжёлых 4; процесс: циклов 1, повторов после ошибки 0, запрещённых инструментов 0; отклик: реакций +7 −1 ~2, ответов Мие 9, поправок 3 из 40 доставленных.",
      warning: false,
    });
    expect(formatTurnQuality({ ...quiet, turns: 0 })).toEqual({ text: "Ходы: за сутки ни одного.", warning: false });
  });

  it("warns on failures, process signals and corrections above the thresholds", () => {
    expect(formatTurnQuality({ ...quiet, failed: 6 }).warning).toBe(true);
    expect(formatTurnQuality({ ...quiet, loops: 2, repeatAfterError: 1 }).warning).toBe(true);
    expect(formatTurnQuality({ ...quiet, followUps: { corrections: 9, repliesToMia: 9 } }).warning).toBe(true);
  });

  it("names the versions when the window spans a release", () => {
    const text = formatTurnQuality({ ...quiet, versions: [{ failed: 1, softwareVersion: "1.8.34", turns: 20 }, { failed: 0, softwareVersion: "1.8.35", turns: 30 }] }).text;
    expect(text).toContain("версии: 1.8.34 20/1, 1.8.35 30/0.");
  });
});
