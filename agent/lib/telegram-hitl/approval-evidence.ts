/**
 * Execution-time evidence that a person approved this exact tool call.
 *
 * Export:
 * - `requireToolExecutionApprovalEvidence`: passes only when a consumed, not timed-out approval of
 *   the same session, Telegram user, call id, tool and input hash exists in a live conversation.
 *   Split out of `approval-repository.ts` to keep that module under the size limit.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";

export interface ToolExecutionApprovalInput {
  applicationSessionId: string;
  eveSessionId: string;
  telegramUserId: string;
  toolCallId: string;
  toolInputHash: string;
  toolName: string;
}

export async function requireToolExecutionApprovalEvidence(input: ToolExecutionApprovalInput): Promise<void> {
  const result = await database().query<{ authorized: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM telegram_hitl_approvals AS approval
       JOIN conversation_sessions AS session ON session.id = approval.application_session_id
       WHERE approval.application_session_id = $1
         AND approval.eve_session_id = $2
         AND approval.expected_telegram_user_id = $3
         AND approval.tool_call_id = $4
         AND approval.tool_name = $5
         AND approval.tool_input_hash = $6
         AND approval.consumed_at IS NOT NULL
         AND approval.timed_out_at IS NULL
         AND (approval.selected_option_id IS NULL OR approval.selected_option_id = 'approve')
         AND session.eve_session_id = approval.eve_session_id
         AND session.retired_at IS NULL
     ) AS authorized`,
    [input.applicationSessionId, input.eveSessionId, input.telegramUserId,
      input.toolCallId, input.toolName, input.toolInputHash],
  );
  if (result.rows[0]?.authorized !== true) {
    throw new AppError(
      "AGENT_TOOL_APPROVAL_EVIDENCE_INVALID",
      "Не удалось подтвердить решение пользователя для этого действия. Запросите подтверждение заново",
    );
  }
}
