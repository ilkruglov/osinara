/**
 * Shared model-facing purpose field for approval-gated tools.
 *
 * Export:
 * - `approvalReasonSchema`: optional one-sentence purpose shown as the agent's explanation.
 *
 * Key constructs:
 * - Optional on purpose: a missing purpose must not fail a tool call, it only omits one line.
 * - The value is untrusted display text. It never carries identity, scope or authorization.
 */
import { z } from "zod";

export const approvalReasonSchema = z
  .string()
  .min(1)
  .max(300)
  .describe(
    "Одно предложение для пользователя: зачем это действие нужно прямо сейчас. Показывается в окне подтверждения как пояснение агента. Всегда заполняй его простым языком, без технических деталей и без повтора параметров.",
  )
  .optional();
