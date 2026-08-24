/**
 * Shared removal of the forward-looking consequence from a settled approval prompt.
 *
 * Export:
 * - `settledPromptText`: the stored prompt without its "будет выполнено" sentence.
 *
 * Key constructs:
 * - An approved, cancelled or expired prompt must not keep promising a future execution next to the
 *   line that says it will not happen. Only an exact known sentence is removed, so a prompt composed
 *   by an older release is left intact rather than truncated.
 */
import {
  DEFAULT_CONSEQUENCE,
  stripApprovalConsequence,
} from "./approval-message.js";
import {
  GOOGLE_WORKSPACE_CONSEQUENCE,
  scheduleConsequences,
} from "./approval-presentation.js";

export function settledPromptText(prompt: string): string {
  return stripApprovalConsequence(prompt, [
    DEFAULT_CONSEQUENCE,
    GOOGLE_WORKSPACE_CONSEQUENCE,
    ...scheduleConsequences(),
  ]);
}
