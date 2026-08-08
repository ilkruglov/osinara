/**
 * Shared fixtures for unified-timeline extraction integration tests.
 *
 * Exports:
 * - `telegramTestMessage`: constructs a minimal Eve Telegram message.
 * - Family, member, group, and timeline-entry database fixture creators.
 * - `completeExtractionBatch`: completes one leased extraction job with a save/approval decision.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { expect } from "vitest";

import { database } from "./database.js";
import { memoryExtractionRepository } from "./memory-extraction-repository.js";

export function telegramTestMessage(input: {
  chatId: string;
  chatType?: "group" | "private";
  messageId: string;
  text: string;
  userId: string;
  userName: string;
}): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: input.chatId, type: input.chatType ?? "private" },
    from: { firstName: input.userName, id: input.userId, isBot: false },
    messageId: input.messageId,
    raw: { date: 1_786_150_800 },
    text: input.text,
  };
}

export async function createExtractionFamily(name: string): Promise<string> {
  const result = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ($1) RETURNING id",
    [name],
  );
  return result.rows[0]!.id;
}

export async function createExtractionMember(input: {
  familyId: string;
  name: string;
  role: "member" | "owner";
  telegramUserId: string;
}): Promise<string> {
  const user = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, $2) RETURNING id`,
    [input.telegramUserId, input.name],
  );
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, $3)",
    [input.familyId, user.rows[0]!.id, input.role],
  );
  return user.rows[0]!.id;
}

export async function createExtractionGroup(input: {
  familyId: string;
  idSuffix: string;
  type: "external" | "family_private";
}): Promise<string> {
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups
       (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, $2, $3, $4, 'addressed_only') RETURNING id`,
    [input.familyId, `-100${input.idSuffix}`, `Группа ${input.idSuffix}`, input.type],
  );
  return group.rows[0]!.id;
}

export async function insertExtractionEntry(input: {
  content: string;
  groupId: string;
  messageId: number;
  sequence: number;
  telegramUserId: string;
  userName: string;
}): Promise<string> {
  const entry = await database().query<{ id: string }>(
    `INSERT INTO telegram_group_messages
       (group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     VALUES ($1, $2, $3, 'user', $4, $5, $6, false, 'text', $7, now()) RETURNING id`,
    [input.groupId, input.messageId, input.sequence, `telegram:${input.telegramUserId}`,
      input.telegramUserId, input.userName, input.content],
  );
  return entry.rows[0]!.id;
}

export async function completeExtractionBatch(input: {
  action: "needs_approval" | "save";
  batchId: string;
  content: string;
  primarySnapshotEntryId: string;
  sensitivity: "normal" | "sensitive";
  supportingSnapshotEntryIds?: string[];
}): Promise<void> {
  const job = await memoryExtractionRepository.claimPending();
  expect(job?.batchId).toBe(input.batchId);
  await memoryExtractionRepository.markProviderCallStarted(job!.id, job!.leaseToken);
  const decision = input.action === "save"
    ? {
        action: "save" as const,
        content: input.content,
        evidenceKind: "firsthand" as const,
        kind: "fact" as const,
        primarySnapshotEntryId: input.primarySnapshotEntryId,
        sensitivity: "normal" as const,
        supportingSnapshotEntryIds: input.supportingSnapshotEntryIds ?? [],
      }
    : {
        action: "needs_approval" as const,
        content: input.content,
        evidenceKind: "firsthand" as const,
        kind: "fact" as const,
        primarySnapshotEntryId: input.primarySnapshotEntryId,
        sensitivity: "sensitive" as const,
        supportingSnapshotEntryIds: input.supportingSnapshotEntryIds ?? [],
      };
  await memoryExtractionRepository.complete({
    decisions: [decision],
    diagnosticCode: null,
    jobId: job!.id,
    leaseToken: job!.leaseToken,
    partialResults: false,
  });
}
