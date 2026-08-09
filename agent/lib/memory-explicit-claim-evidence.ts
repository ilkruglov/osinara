/**
 * Explicit Telegram-source preparation for the single memory claim writer.
 *
 * Export:
 * - `prepareExplicitClaimEvidence`: resolves current message, author, scope, and optional subject ref.
 */
import type { PoolClient } from "pg";

import { AppError } from "./app-error.js";
import type { PreparedClaimEvidence } from "./claim-evidence-writer.js";
import { MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS } from "./memory-config.js";
import { requireAllowedMemoryContent } from "./memory-content-policy.js";
import type { MemoryAuthorization } from "./memory-context.js";
import type { CreateMemoryInput } from "./memory-record.js";
import { normalizeMemoryClaimContent } from "./memory-record.js";

interface ExplicitTimelineSourceRow {
  author_label: string | null;
  author_participant_id: string;
  author_user_id: string | null;
  content_text: string | null;
  conversation_label: string;
  family_id: string;
  message_thread_id: string | null;
  scope: "family" | "group" | "personal";
  scope_partition_key: string;
  sent_at: Date;
  telegram_group_id: string | null;
  telegram_message_id: string;
  timeline_sequence: string;
}

function evidenceSnippet(content: string): string {
  const bounded = [...content.trim()].slice(0, MEMORY_EVIDENCE_SNIPPET_MAX_CHARACTERS).join("");
  if (!bounded) {
    throw new AppError(
      "AGENT_MEMORY_EVIDENCE_SOURCE_EMPTY",
      "Текущее сообщение не содержит текста для проверяемого источника памяти",
    );
  }
  return bounded;
}

export async function prepareExplicitClaimEvidence(
  client: PoolClient,
  auth: MemoryAuthorization,
  input: CreateMemoryInput,
): Promise<PreparedClaimEvidence> {
  const source = input.explicitSource;
  if (!source || (source.subjectRef !== undefined && source.subjectLabel !== undefined)) {
    throw new AppError(
      "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
      "Явное сохранение требует одного проверенного источника и не более одного субъекта",
    );
  }
  if (source.subjectLabel !== undefined &&
    (!source.subjectLabel.trim() || source.subjectLabel.length > 200)) {
    throw new AppError(
      "AGENT_MEMORY_SUBJECT_LABEL_INVALID",
      "Текстовая метка субъекта памяти должна содержать от 1 до 200 символов",
    );
  }
  const result = await client.query<ExplicitTimelineSourceRow>(
    `SELECT conversation.family_id, conversation.scope, conversation.scope_partition_key,
            conversation.telegram_group_id, conversation.label AS conversation_label,
            message.content_text, message.sent_at, message.sequence_id AS timeline_sequence,
            message.telegram_message_id::text, message.message_thread_id,
            participant.id AS author_participant_id, participant.linked_user_id AS author_user_id,
            participant.display_name_snapshot AS author_label
     FROM telegram_group_messages AS message
     JOIN application_conversations AS conversation ON conversation.id = message.conversation_id
     JOIN conversation_participants AS participant
       ON participant.conversation_id = conversation.id
      AND participant.telegram_user_id = message.telegram_user_id
     WHERE message.id = $1 AND message.conversation_id = $2
       AND message.actor_kind = 'user' AND message.telegram_user_id = $3`,
    [source.timelineEntryId, source.conversationId, auth.telegramUserId],
  );
  const row = result.rows[0];
  const expectedPartition = input.scope === "group"
    ? auth.groupId
    : input.scope === "personal"
      ? auth.userId
      : auth.familyId;
  if (!row || row.family_id !== auth.familyId || row.scope !== input.scope ||
    row.scope_partition_key !== expectedPartition || !row.content_text) {
    throw new AppError(
      "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
      "Текущее проверенное сообщение не относится к выбранной области памяти",
    );
  }
  requireAllowedMemoryContent(row.content_text);

  // Opaque subject refs resolve only inside the verified origin conversation.
  let subjectParticipantId: string | null = null;
  let subjectConversationId: string | null = null;
  let subjectUserId: string | null = null;
  if (source.subjectRef !== undefined) {
    const subjectResult = await client.query<{
      subject_participant_id: string | null;
      subject_user_id: string | null;
    }>(
      `SELECT subject_participant_id, subject_user_id
       FROM profile_subjects
       WHERE subject_ref = $1 AND conversation_id = $2 AND family_id = $3`,
      [source.subjectRef, source.conversationId, auth.familyId],
    );
    const subject = subjectResult.rows[0];
    if (!subject || (input.scope === "group") !== (subject.subject_participant_id !== null)) {
      throw new AppError(
        "AGENT_MEMORY_SUBJECT_REF_INVALID",
        "Субъект памяти недоступен в текущем разговоре",
      );
    }
    subjectParticipantId = subject.subject_participant_id;
    subjectConversationId = subjectParticipantId === null ? null : source.conversationId;
    subjectUserId = subject.subject_user_id;
  }
  const evidenceKind = (subjectParticipantId !== null &&
    subjectParticipantId !== row.author_participant_id) ||
    (subjectUserId !== null && subjectUserId !== row.author_user_id)
    ? "reported"
    : "firsthand";

  return {
    auditActorUserId: auth.userId,
    contentNormalized: normalizeMemoryClaimContent(input.content),
    conversationId: source.conversationId,
    conversationLabelSnapshot: row.conversation_label,
    evidenceKind,
    familyId: auth.familyId,
    primaryAuthorTelegramUserId: auth.telegramUserId,
    primaryAuthorUserId: row.author_user_id,
    scope: input.scope,
    scopePartitionKey: row.scope_partition_key,
    sources: [{
      authorLabelSnapshot: row.author_label,
      authorParticipantId: row.author_participant_id,
      authorTelegramUserId: auth.telegramUserId,
      authorUserId: row.author_user_id,
      evidenceSnippet: evidenceSnippet(row.content_text),
      messageThreadId: row.message_thread_id,
      observedAt: row.sent_at,
      role: "primary",
      sourceMessageId: row.telegram_message_id,
      sourceSnapshot: { content: row.content_text },
      timelineEntryId: source.timelineEntryId,
      timelineSequence: row.timeline_sequence,
    }],
    subjectConversationId,
    subjectLabel: source.subjectLabel ?? null,
    subjectParticipantId,
    subjectUserId,
    telegramGroupId: row.telegram_group_id,
  };
}
