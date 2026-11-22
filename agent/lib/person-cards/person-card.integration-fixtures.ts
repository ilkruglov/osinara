/**
 * Database fixtures for person card integration tests.
 *
 * Exports:
 * - `PersonCardFixture`, `createPersonCardFixture`: one family with an owner, a family group and two
 *   external groups; Юра (yura_k) in both external groups, Лёша (alex_x) in group A, two
 *   participants of group A sharing the username `twin_name`.
 * - `insertPersonCardRecord`: one evidenced memory record with optional primary evidence.
 * - `resetPersonCardTables`: empties every table the fixtures write.
 */
import type { PoolClient } from "pg";

import { conversationRepository } from "../conversation-repository.js";
import { database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import type { MemoryKind } from "../memory-record.js";

export const OWNER_TELEGRAM_ID = "9401";
export const YURA_TELEGRAM_ID = "9402";
export const ALEX_TELEGRAM_ID = "9403";

export interface PersonCardFixture {
  familyConversationId: string;
  familyId: string;
  groupA: { conversationId: string; id: string };
  groupB: { conversationId: string; id: string };
  ownerAuth: MemoryAuthorization;
  ownerId: string;
  participants: {
    alexInA: string;
    ownerInA: string;
    ownerInFamily: string;
    yuraInA: string;
    yuraInB: string;
  };
  personalConversationId: string;
}

export async function resetPersonCardTables(): Promise<void> {
  await database().query(
    `TRUNCATE person_card_uses, person_card_cleanups, person_card_sources, person_card_builds,
       person_cards, deploy_turn_pause, claim_conflicts, claim_evidence, memory_items_all,
       telegram_group_messages, telegram_groups, family_memberships, users, families CASCADE`,
  );
}

async function participant(input: {
  conversationId: string;
  displayName: string;
  linkedUserId?: string;
  telegramUserId: string;
  username: string | null;
}): Promise<string> {
  const result = await database().query<{ id: string }>(
    `INSERT INTO conversation_participants
       (conversation_id, family_id, scope, scope_partition_key, telegram_user_id, linked_user_id,
        display_name_snapshot, username_snapshot, first_observed_at, last_observed_at)
     SELECT id, family_id, scope, scope_partition_key, $2, $3, $4, $5, now(), now()
     FROM application_conversations WHERE id = $1
     RETURNING id`,
    [
      input.conversationId,
      input.telegramUserId,
      input.linkedUserId ?? null,
      input.displayName,
      input.username,
    ],
  );
  return result.rows[0]!.id;
}

export async function createPersonCardFixture(): Promise<PersonCardFixture> {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Карточки') RETURNING id",
  );
  const familyId = family.rows[0]!.id;
  const owner = await database().query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name, telegram_username)
     VALUES ($1, 'Илья', 'ilya_k') RETURNING id`,
    [OWNER_TELEGRAM_ID],
  );
  const ownerId = owner.rows[0]!.id;
  await database().query(
    "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
    [familyId, ownerId],
  );
  const groups = await database().query<{ id: string; telegram_chat_id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-1009401', 'Семья', 'family_private', 'addressed_only'),
            ($1, '-1009402', 'Группа A', 'external', 'addressed_only'),
            ($1, '-1009403', 'Группа B', 'external', 'addressed_only')
     RETURNING id, telegram_chat_id`,
    [familyId],
  );
  const groupId = (chat: string) => groups.rows.find((row) => row.telegram_chat_id === chat)!.id;
  const personal = await conversationRepository.getByChatId(OWNER_TELEGRAM_ID);
  const familyConversation = await conversationRepository.getByGroupId(groupId("-1009401"));
  const groupA = await conversationRepository.getByGroupId(groupId("-1009402"));
  const groupB = await conversationRepository.getByGroupId(groupId("-1009403"));
  const ownerInFamily = await participant({
    conversationId: familyConversation.id,
    displayName: "Илья",
    linkedUserId: ownerId,
    telegramUserId: OWNER_TELEGRAM_ID,
    username: "ilya_k",
  });
  const ownerInA = await participant({
    conversationId: groupA.id,
    displayName: "Илья",
    linkedUserId: ownerId,
    telegramUserId: OWNER_TELEGRAM_ID,
    username: "ilya_k",
  });
  const yuraInA = await participant({
    conversationId: groupA.id,
    displayName: "Юра",
    telegramUserId: YURA_TELEGRAM_ID,
    username: "yura_k",
  });
  const yuraInB = await participant({
    conversationId: groupB.id,
    displayName: "Юра",
    telegramUserId: YURA_TELEGRAM_ID,
    username: "yura_k",
  });
  const alexInA = await participant({
    conversationId: groupA.id,
    displayName: "Лёша",
    telegramUserId: ALEX_TELEGRAM_ID,
    username: "alex_x",
  });
  for (const telegramUserId of ["9405", "9406"]) {
    await participant({
      conversationId: groupA.id,
      displayName: "Близнец",
      telegramUserId,
      username: "twin_name",
    });
  }
  return {
    familyConversationId: familyConversation.id,
    familyId,
    groupA: { conversationId: groupA.id, id: groupId("-1009402") },
    groupB: { conversationId: groupB.id, id: groupId("-1009403") },
    ownerAuth: {
      familyId,
      groupId: null,
      role: "owner",
      scopes: ["personal", "family"],
      telegramActorId: OWNER_TELEGRAM_ID,
      telegramActorKind: "telegram_user",
      telegramUserId: OWNER_TELEGRAM_ID,
      userId: ownerId,
    },
    ownerId,
    participants: { alexInA, ownerInA, ownerInFamily, yuraInA, yuraInB },
    personalConversationId: personal.id,
  };
}

export interface PersonCardRecordInput {
  attribute?: string;
  confirmation?: "model_high" | "user_confirmed";
  content: string;
  conversationId: string;
  createdAt?: Date;
  /** Primary evidence; group and family records need a participant author, personal a user. */
  evidence?: {
    authorParticipantId?: string;
    authorUserId?: string;
    kind: "firsthand" | "inferred" | "reported";
  };
  groupId?: string;
  kind?: MemoryKind;
  occurredAt?: Date;
  ownerUserId?: string;
  provenance?: "evidenced" | "legacy_unresolved";
  scope: "family" | "group" | "personal";
  sensitivity?: "normal" | "sensitive";
  subjectLabel?: string;
  subjectParticipantId?: string;
  subjectUserId?: string;
}

let operation = 0;

/** `client` inserts inside the caller's open transaction (a memory write not yet committed). */
export async function insertPersonCardRecord(
  fixture: PersonCardFixture,
  input: PersonCardRecordInput,
  client: Pick<PoolClient, "query"> = database(),
): Promise<{ id: string; memoryRef: string }> {
  operation += 1;
  const provenance = input.provenance ?? "evidenced";
  const sensitivity = input.sensitivity ?? "normal";
  const eligible =
    provenance === "evidenced" &&
    sensitivity === "normal" &&
    (input.subjectUserId !== undefined || input.subjectParticipantId !== undefined);
  const result = await client.query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, owner_user_id, group_id, author_user_id, author_telegram_user_id, scope, kind,
        content, source, confirmation, sensitivity, operation_key, provenance_state,
        origin_conversation_id, subject_user_id, subject_participant_id, subject_conversation_id,
        subject_label, profile_eligible, attribute, occurred_at, created_at, updated_at,
        content_normalized)
     VALUES ($1, $2, $3, $2, $4, $5, $6, $7, 'person-card:test', $8, $9, $10, $11, $12, $13, $14,
             CASE WHEN $14::uuid IS NULL THEN NULL ELSE $12::uuid END, $15, $16, $17, $18,
             COALESCE($19::timestamptz, now()), COALESCE($19::timestamptz, now()), lower($7))
     RETURNING id`,
    [
      fixture.familyId,
      input.ownerUserId ?? null,
      input.groupId ?? null,
      input.scope === "personal" ? null : OWNER_TELEGRAM_ID,
      input.scope,
      input.kind ?? "preference",
      input.content,
      input.confirmation ?? "model_high",
      sensitivity,
      `person-card:${operation}`,
      provenance,
      input.conversationId,
      input.subjectUserId ?? null,
      input.subjectParticipantId ?? null,
      input.subjectLabel ?? null,
      eligible,
      input.attribute ?? null,
      input.occurredAt ?? null,
      input.createdAt ?? null,
    ],
  );
  const id = result.rows[0]!.id;
  if (input.evidence) {
    await client.query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_sequence, source_message_id, source_snapshot, created_at)
       SELECT item.id, item.family_id, item.scope, item.scope_partition_key, 'primary', $2,
              item.origin_conversation_id, 'Источник', conversation.telegram_group_id, $3, $4,
              'Автор', item.created_at, item.content, 1, 1, jsonb_build_object('content', item.content),
              item.created_at
       FROM memory_items AS item
       JOIN application_conversations AS conversation ON conversation.id = item.origin_conversation_id
       WHERE item.id = $1`,
      [
        id,
        input.evidence.kind,
        input.evidence.authorParticipantId ?? null,
        input.evidence.authorUserId ?? null,
      ],
    );
  }
  const reference = await client.query<{ memory_ref: string }>(
    "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
    [id],
  );
  return { id, memoryRef: reference.rows[0]!.memory_ref };
}
