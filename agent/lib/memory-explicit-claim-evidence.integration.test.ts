/**
 * Explicit remember provenance integration tests.
 *
 * Constructs covered:
 * - Opaque subject refs resolve only inside the current verified conversation.
 * - A verified author statement about another member is persisted as reported with exact provenance.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryRepository } from "./memory-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true"
  ? describe
  : describe.skip;

describeWithDatabase("explicit claim evidence", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });

  afterAll(closeDatabase);

  it("binds a reported claim to a conversation-local opaque subject ref", async () => {
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Explicit evidence') RETURNING id",
    );
    const users = await database().query<{ id: string; telegram_user_id: string }>(
      `INSERT INTO users (telegram_user_id, display_name)
       VALUES ('explicit-author', 'Анна'), ('explicit-subject', 'Пётр')
       RETURNING id, telegram_user_id`,
    );
    const author = users.rows.find((row) => row.telegram_user_id === "explicit-author")!;
    const subject = users.rows.find((row) => row.telegram_user_id === "explicit-subject")!;
    await database().query(
      `INSERT INTO family_memberships (family_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [family.rows[0]!.id, author.id, subject.id],
    );
    const group = await database().query<{ id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-100-explicit-evidence', 'Семья', 'family_private', 'addressed_only')
       RETURNING id`,
      [family.rows[0]!.id],
    );
    const conversation = await database().query<{ id: string }>(
      "SELECT id FROM application_conversations WHERE telegram_group_id = $1",
      [group.rows[0]!.id],
    );
    await database().query(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'family', $2, 'explicit-author', $3, 'Анна', now(), now()),
              ($1, $2, 'family', $2, 'explicit-subject', $4, 'Пётр', now(), now())`,
      [conversation.rows[0]!.id, family.rows[0]!.id, author.id, subject.id],
    );
    const subjectRef = await database().query<{ subject_ref: string }>(
      `SELECT subject_ref FROM profile_subjects
       WHERE conversation_id = $1 AND subject_user_id = $2`,
      [conversation.rows[0]!.id, subject.id],
    );
    const timeline = await database().query<{ id: string }>(
      `INSERT INTO telegram_group_messages
         (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
          telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
       VALUES ($1, $2, 801, 1, 'user', 'telegram:explicit-author', 'explicit-author',
               'Анна', false, 'text', 'Запомни: Пётр предпочитает улун', now()) RETURNING id`,
      [conversation.rows[0]!.id, group.rows[0]!.id],
    );
    const auth: MemoryAuthorization = {
      familyId: family.rows[0]!.id,
      groupId: group.rows[0]!.id,
      role: "owner",
      scopes: ["family"],
      telegramUserId: "explicit-author",
      userId: author.id,
    };

    const memory = await memoryRepository.create(auth, {
      confirmation: "user_confirmed",
      content: "Пётр предпочитает улун",
      explicitSource: {
        conversationId: conversation.rows[0]!.id,
        subjectRef: subjectRef.rows[0]!.subject_ref,
        timelineEntryId: timeline.rows[0]!.id,
      },
      kind: "preference",
      operationKey: "explicit-reported-claim",
      scope: "family",
      sensitivity: "normal",
      source: "eve:test-explicit",
    });

    await expect(database().query(
      `SELECT item.subject_user_id, item.provenance_state::text, item.profile_eligible,
              evidence.evidence_kind, evidence.author_label_snapshot,
              evidence.timeline_entry_id, evidence.origin_conversation_id
       FROM memory_items AS item
       JOIN claim_evidence AS evidence ON evidence.claim_id = item.id
       WHERE item.id = $1`,
      [memory.id],
    )).resolves.toMatchObject({
      rows: [{
        author_label_snapshot: "Анна",
        evidence_kind: "reported",
        origin_conversation_id: conversation.rows[0]!.id,
        profile_eligible: true,
        provenance_state: "evidenced",
        subject_user_id: subject.id,
        timeline_entry_id: timeline.rows[0]!.id,
      }],
    });
  });
});
