/**
 * The turn quality line of the owner's digest.
 *
 * Export:
 * - `formatTurnQuality`: one line with the three levels (outcome, process, satisfaction) and the
 *   versions of the day; `warning` when a threshold is crossed, so the line joins the failures.
 *
 * Thresholds are starting points for the first weeks of measurement, not calibrated limits.
 */
import type { TurnQualitySummary } from "../turn-quality/turn-evaluation-repository.js";

/** Share of failed turns, or of corrected answers, that makes the day a failure line. */
export const TURN_QUALITY_FAILED_SHARE = 0.1;
export const TURN_QUALITY_CORRECTION_SHARE = 0.2;
/** Any of these in a day is worth a look: the loop guard and the mode surface should prevent them. */
export const TURN_QUALITY_PROCESS_ALERT = 3;

const percent = (part: number, whole: number) => whole === 0 ? "0 %" : `${Math.round((part / whole) * 100)} %`;

export function formatTurnQuality(summary: TurnQualitySummary): { text: string; warning: boolean } {
  if (summary.turns === 0) return { text: "Ходы: за сутки ни одного.", warning: false };
  const process = summary.loops + summary.repeatAfterError + summary.forbiddenTool;
  const warning = summary.failed > summary.turns * TURN_QUALITY_FAILED_SHARE ||
    process >= TURN_QUALITY_PROCESS_ALERT ||
    (summary.delivered > 0 && summary.followUps.corrections > summary.delivered * TURN_QUALITY_CORRECTION_SHARE);
  const parts = [
    `Ходы: ${summary.turns}, сбоев ${summary.failed} (${percent(summary.failed, summary.turns)}), с упавшим инструментом ${summary.failedToolTurns}, тяжёлых ${summary.heavy}`,
    `процесс: циклов ${summary.loops}, повторов после ошибки ${summary.repeatAfterError}, запрещённых инструментов ${summary.forbiddenTool}`,
    `отклик: реакций +${summary.reactions.positive} −${summary.reactions.negative} ~${summary.reactions.other}, ответов Мие ${summary.followUps.repliesToMia}, поправок ${summary.followUps.corrections} из ${summary.delivered} доставленных`,
  ];
  if (summary.versions.length > 1) {
    parts.push(`версии: ${summary.versions.map((version) => `${version.softwareVersion} ${version.turns}/${version.failed}`).join(", ")}`);
  }
  return { text: `${parts.join("; ")}.`, warning };
}
