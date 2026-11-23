/**
 * Telegram group journal against memory evidence integration tests.
 *
 * Constructs covered:
 * - A group past the old cap of 10 000 entries keeps accepting messages and keeps the source
 *   message of soft-deleted memory live (upstream nyxandro/osinara #306 was pruning blocked by such
 *   sources; the cap is gone since 22 November 2026).
 * - The same for a source message whose author was linked to a user after the evidence was saved.
 * - Removing the group, which now cascades every entry, clears such evidence instead of failing
 *   on its author link (migration 127; journal pruning used to exercise that path).
 * - Deleting the source entry of soft-deleted memory clears its evidence link instead of failing
 *   on the claim's provenance (migration 127's other branch; group removal cannot reach it yet,
 *   since it fails earlier on soft-deleted memory for a reason of its own).
 * - `claim_evidence` still rejects evidence inserted for or moved to deleted memory, and authors
 *   that differ from their participant's user link.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { memoryRepository } from "./memory-repository.js";
import { telegramGroupAdministrationRepository } from "./telegram-group-administration-repository.js";
import {
  createThreadRepositoryFixture,
  type ThreadRepositoryFixture,
} from "./memory-thread-repository.integration-fixtures.js";
import { recordVerifiedHumanTelegramMessage } from "./telegram-group-journal.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

function groupMessage(id: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-100-thread-repository", title: "Family", type: "supergroup" },
    from: { firstName: "Owner", id: "thread-owner", isBot: false },
    messageId: id,
    raw: { date: 1_700_000_000 },
    text: "новое сообщение",
  };
}

/** The per-chat cap the journal had until 22 November 2026. */
const OLD_CAP = 10_000;

// The fixture's evidence source is sequence 1; the seed fills the journal to the old cap after it.
async function fillJournalToOldCap(groupId: string): Promise<void> {
  await database().query(
    `INSERT INTO telegram_group_messages
       (group_id, sequence_id, actor_kind, actor_id, telegram_message_id,
        telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text, sent_at)
     SELECT $1, value, 'user', 'telegram:thread-owner', 100000 + value, 'thread-owner', 'Owner',
            false, 'text', 'seed', now()
     FROM generate_series(2, $2) AS value`,
    [groupId, OLD_CAP],
  );
}

async function deleteClaim(fixture: ThreadRepositoryFixture, claimId: string): Promise<void> {
  const ref = await database().query<{ memory_ref: string }>(
    "SELECT memory_ref FROM memory_item_refs WHERE memory_item_id = $1",
    [claimId],
  );
  await memoryRepository.deleteByRef(fixture.auth, ref.rows[0]!.memory_ref, `delete-${claimId}`);
}

async function insertUnsourcedClaim(fixture: ThreadRepositoryFixture): Promise<string> {
  const claim = await database().query<{ id: string }>(
    `INSERT INTO memory_items
       (family_id, author_user_id, scope, kind, content, source, confirmation, sensitivity,
        operation_key, provenance_state, origin_conversation_id, save_approved,
        content_normalized, profile_eligible)
     VALUES ($1, $2, 'family', 'fact', 'Другое заявление без источника', 'extraction',
             'model_high', 'normal', 'unsourced-claim', 'evidenced', $3, true,
             'другое заявление без источника', false) RETURNING id`,
    [fixture.familyId, fixture.userId, fixture.conversationId],
  );
  return claim.rows[0]!.id;
}

async function expectJournalKeptWhole(groupId: string): Promise<void> {
  const journal = await database().query<{ count: string; minimum: string }>(
    `SELECT count(*)::text AS count, min(sequence_id)::text AS minimum
     FROM telegram_group_messages WHERE group_id = $1`,
    [groupId],
  );
  expect(journal.rows[0]).toEqual({ count: String(OLD_CAP + 1), minimum: "1" });
}

async function evidenceOf(claimId: string) {
  const evidence = await database().query<{
    author_user_id: string | null;
    source_message_id: string;
    timeline_entry_id: string | null;
    timeline_sequence: string;
  }>(
    `SELECT author_user_id, source_message_id::text, timeline_entry_id,
            timeline_sequence::text
     FROM claim_evidence WHERE claim_id = $1`,
    [claimId],
  );
  return evidence.rows;
}

describeWithDatabase("Telegram group journal against memory evidence", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE memory_items_all, telegram_group_messages, telegram_groups,
         family_memberships, users, families CASCADE`,
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("keeps accepting group messages past the old cap with a source of deleted memory", async () => {
    const fixture = await createThreadRepositoryFixture();
    await deleteClaim(fixture, fixture.claimId);
    await fillJournalToOldCap(fixture.groupId);

    await expect(
      recordVerifiedHumanTelegramMessage(fixture.groupId, groupMessage("900001")),
    ).resolves.toMatchObject({ status: "inserted" });

    await expectJournalKeptWhole(fixture.groupId);
    // Deleted memory stays recoverable, and its evidence keeps the live link to its message.
    expect(await evidenceOf(fixture.claimId)).toEqual([
      {
        author_user_id: fixture.userId,
        source_message_id: "701",
        timeline_entry_id: expect.any(String),
        timeline_sequence: "1",
      },
    ]);
  });

  it("keeps accepting group messages past the old cap when a source author was linked later", async () => {
    const fixture = await createThreadRepositoryFixture();
    // Evidence was saved while the participant had no application user; the link appeared later,
    // as the participant upsert does once that Telegram user registers.
    await database().query(
      "UPDATE conversation_participants SET linked_user_id = NULL WHERE conversation_id = $1",
      [fixture.conversationId],
    );
    await database().query("UPDATE claim_evidence SET author_user_id = NULL WHERE claim_id = $1", [
      fixture.claimId,
    ]);
    await database().query(
      "UPDATE conversation_participants SET linked_user_id = $2 WHERE conversation_id = $1",
      [fixture.conversationId, fixture.userId],
    );
    await fillJournalToOldCap(fixture.groupId);

    await expect(
      recordVerifiedHumanTelegramMessage(fixture.groupId, groupMessage("900002")),
    ).resolves.toMatchObject({ status: "inserted" });

    await expectJournalKeptWhole(fixture.groupId);
    expect(await evidenceOf(fixture.claimId)).toEqual([
      {
        author_user_id: null,
        source_message_id: "701",
        timeline_entry_id: expect.any(String),
        timeline_sequence: "1",
      },
    ]);
  });

  it("removes a group whose memory source's author was linked after the evidence", async () => {
    const fixture = await createThreadRepositoryFixture();
    await database().query(
      "UPDATE conversation_participants SET linked_user_id = NULL WHERE conversation_id = $1",
      [fixture.conversationId],
    );
    await database().query("UPDATE claim_evidence SET author_user_id = NULL WHERE claim_id = $1", [
      fixture.claimId,
    ]);
    await database().query(
      "UPDATE conversation_participants SET linked_user_id = $2 WHERE conversation_id = $1",
      [fixture.conversationId, fixture.userId],
    );

    await expect(
      telegramGroupAdministrationRepository.removeRegistration({
        familyId: fixture.familyId,
        requestedBy: fixture.userId,
        telegramChatId: "-100-thread-repository",
      }),
    ).resolves.toBeDefined();
    await expect(
      database().query("SELECT 1 FROM telegram_group_messages WHERE group_id = $1", [
        fixture.groupId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("clears the evidence link of soft-deleted memory when its source entry goes", async () => {
    const fixture = await createThreadRepositoryFixture();
    await deleteClaim(fixture, fixture.claimId);
    const [evidence] = await evidenceOf(fixture.claimId);

    // The foreign key's ON DELETE SET NULL is an UPDATE of the evidence row: the trigger checked
    // the claim on every UPDATE before migration 127, and deleted memory failed that check.
    await expect(
      database().query("DELETE FROM telegram_group_messages WHERE id = $1", [
        evidence!.timeline_entry_id,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    expect(await evidenceOf(fixture.claimId)).toEqual([
      {
        author_user_id: fixture.userId,
        source_message_id: "701",
        timeline_entry_id: null,
        timeline_sequence: "1",
      },
    ]);
  });

  it("still rejects attaching evidence to deleted memory", async () => {
    const fixture = await createThreadRepositoryFixture();
    const deletedClaimId = await insertUnsourcedClaim(fixture);
    await deleteClaim(fixture, deletedClaimId);

    await expect(
      database().query("UPDATE claim_evidence SET claim_id = $2 WHERE claim_id = $1", [
        fixture.claimId,
        deletedClaimId,
      ]),
    ).rejects.toThrow("AGENT_CLAIM_EVIDENCE_PROVENANCE_INVALID");

    await deleteClaim(fixture, fixture.claimId);
    await expect(
      database().query(
        `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_user_id, author_label_snapshot, observed_at,
          evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
          source_snapshot)
       SELECT claim_id, family_id, scope, scope_partition_key, 'supporting', evidence_kind,
              origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
              author_participant_id, author_user_id, author_label_snapshot, observed_at,
              evidence_snippet, timeline_entry_id, timeline_sequence, source_message_id,
              source_snapshot
       FROM claim_evidence WHERE claim_id = $1`,
        [fixture.claimId],
      ),
    ).rejects.toThrow("AGENT_CLAIM_EVIDENCE_PROVENANCE_INVALID");
  });

  it("still rejects evidence authors that differ from their participant's user link", async () => {
    const fixture = await createThreadRepositoryFixture();
    const stranger = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('stranger', 'Stranger') RETURNING id",
    );
    const unlinked = await database().query<{ id: string }>(
      `INSERT INTO conversation_participants
         (conversation_id, family_id, scope, scope_partition_key, telegram_user_id,
          linked_user_id, display_name_snapshot, first_observed_at, last_observed_at)
       VALUES ($1, $2, 'family', $2, 'unlinked', NULL, 'Unlinked', now(), now()) RETURNING id`,
      [fixture.conversationId, fixture.familyId],
    );

    await expect(
      database().query("UPDATE claim_evidence SET author_user_id = $2 WHERE claim_id = $1", [
        fixture.claimId,
        stranger.rows[0]!.id,
      ]),
    ).rejects.toThrow("AGENT_CLAIM_EVIDENCE_AUTHOR_LINK_INVALID");
    await expect(
      database().query("UPDATE claim_evidence SET author_participant_id = $2 WHERE claim_id = $1", [
        fixture.claimId,
        unlinked.rows[0]!.id,
      ]),
    ).rejects.toThrow("AGENT_CLAIM_EVIDENCE_AUTHOR_LINK_INVALID");
  });
});
