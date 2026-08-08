/**
 * Current-authority validation for an approved sensitive extraction candidate.
 *
 * Exports:
 * - `PreparedSensitiveApproval`: actor and replay metadata consumed by the single writer.
 * - `prepareSensitiveApproval`: locks the notice and rechecks source-user/family-owner authority.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { CreateMemoryInput } from "./memory-record.js";

export interface PreparedSensitiveApproval {
  actorTelegramUserId: string;
  actorUserId: string | null;
  inputHash: string;
  operationKey: string;
  ref: string;
}

export async function prepareSensitiveApproval(
  client: PoolClient,
  input: CreateMemoryInput,
  candidate: {
    candidate_row_id: string;
    family_id: string;
    scope: "family" | "group" | "personal";
  },
  primary: { author_telegram_user_id: string; author_user_id: string | null },
  approvalActor: MemoryAuthorization | undefined,
): Promise<PreparedSensitiveApproval | null> {
  const ref = input.evidence?.approvalRef;
  const operationKey = input.evidence?.approvalOperationKey;
  const inputHash = input.evidence?.approvalInputHash;
  if (ref === undefined && operationKey === undefined && inputHash === undefined) return null;
  if (!ref || !operationKey || !inputHash || !approvalActor || approvalActor.familyId !== candidate.family_id) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_CONTEXT_INVALID",
      "Не удалось подтвердить полномочия для сохранения чувствительной записи",
    );
  }
  if (input.sensitivity !== "sensitive" || input.confirmation !== "user_confirmed") {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_CANDIDATE_INVALID",
      "Подтверждение применяется только к чувствительной записи с явным решением пользователя",
    );
  }
  const notice = await client.query<{ status: string }>(
    `SELECT status FROM memory_extraction_approval_notices
     WHERE approval_ref = $1 AND family_id = $2 AND candidate_row_id = $3 FOR UPDATE`,
    [ref, candidate.family_id, candidate.candidate_row_id],
  );
  if (notice.rows[0]?.status !== "pending") {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_ALREADY_RESOLVED",
      "Это подтверждение памяти уже обработано",
    );
  }

  // Personal approval belongs only to the source user. Family/external candidates additionally
  // accept the currently verified family owner, never a stale role from extraction time.
  const owner = approvalActor.userId
    ? await client.query(
        `SELECT 1 FROM family_memberships
         WHERE family_id = $1 AND user_id = $2 AND role = 'owner' FOR SHARE`,
        [candidate.family_id, approvalActor.userId],
      )
    : { rowCount: 0 };
  const sourceUser = candidate.scope === "group"
    ? approvalActor.telegramUserId === primary.author_telegram_user_id
    : approvalActor.userId !== null && approvalActor.userId === primary.author_user_id;
  const sourceStillAuthorized = candidate.scope !== "family" || !sourceUser
    ? sourceUser
    : Boolean((await client.query(
        "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2 FOR SHARE",
        [candidate.family_id, approvalActor.userId],
      )).rowCount);
  const allowed = candidate.scope === "personal"
    ? sourceStillAuthorized
    : sourceStillAuthorized || Boolean(owner.rowCount);
  if (!allowed) {
    throw new AppError(
      "AGENT_MEMORY_APPROVAL_DENIED",
      "Подтвердить эту запись может только автор источника или владелец семьи",
    );
  }
  return {
    actorTelegramUserId: approvalActor.telegramUserId,
    actorUserId: approvalActor.userId,
    inputHash,
    operationKey,
    ref,
  };
}
