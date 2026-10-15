/**
 * Migration 135: the Ft86 logistician gets his username next to «Илья-логист».
 *
 * Constructs covered:
 * - The first «Илья-логист» in any case form gets «(Ilya_Demchenko)» in the text and in the
 *   normalized form, which then equals what the normalizer would produce; the edited visible
 *   record is queued for reindexing.
 * - A record that already carries the username, and the same words in another group, stay as
 *   they are; a second run changes nothing.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { normalizeMemoryClaimContent } from "./memory-record.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const MIGRATION = "migrations/135_memory_ft86_logist_username.sql";

describeWithDatabase("135 Ft86 logistician username", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("adds the username after the first «Илья-логист» of a Ft86 record and reindexes it", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const groups = await database().query<{ id: string; telegram_chat_id: string }>(
      `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
       VALUES ($1, '-1001787011433', 'Ft86 скуф', 'external', 'addressed_only'),
              ($1, '-100999', 'Другая группа', 'external', 'addressed_only')
       RETURNING id, telegram_chat_id`,
      [fixture.familyId],
    );
    const ft86 = groups.rows.find((row) => row.telegram_chat_id === "-1001787011433")!.id;
    const other = groups.rows.find((row) => row.telegram_chat_id === "-100999")!.id;
    const insert = async (groupId: string, content: string) => {
      const row = await database().query<{ id: string }>(
        `INSERT INTO memory_items_all
           (family_id, scope, group_id, kind, content, content_normalized, source, author_user_id, author_telegram_user_id,
            confirmation, sensitivity, operation_key, attribute, embedding_status)
         VALUES ($1, 'group', $2, 'fact', $3, $4, 'test:135', $5, '151894754', 'model_high', 'normal', $6, 'мем про логиста', 'indexed')
         RETURNING id`,
        [fixture.familyId, groupId, content, normalizeMemoryClaimContent(content), fixture.userId, randomUUID()],
      );
      return row.rows[0]!.id;
    };
    const nominative = await insert(ft86, "10 сентября 2026 Илья-логист требовал убрать анекдоты, Илья-логист настаивал.");
    const genitive = await insert(ft86, "По словам Ильи-логиста 10 сентября 2026, шутки про логистов надоели.");
    const named = await insert(ft86, "Илья-логист (Ilya_Demchenko) просил убрать анекдоты совсем.");
    const elsewhere = await insert(other, "Илья-логист требовал убрать анекдоты.");
    // Another person's similar username is not his (Codex review).
    const lookalike = await insert(ft86, "Илья-логист спорил с @Ilya_Demchenko2 о шутках.");
    // «Илья, логист» normalizes to the same «илья логист» as the hyphenated name: the username would
    // land in a different place in the two forms, so such a record is left alone (Codex review).
    const punctuated = await insert(ft86, "Илья, логист тут ни при чём: это Илья-логист пошутил.");

    await database().query(await readFile(MIGRATION, "utf8"));

    const rows = await database().query<{ content: string; content_normalized: string; embedding_status: string; id: string }>(
      "SELECT id, content, content_normalized, embedding_status FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[nominative, genitive, named, elsewhere, lookalike, punctuated]],
    );
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
    const fixedNominative = "10 сентября 2026 Илья-логист (Ilya_Demchenko) требовал убрать анекдоты, Илья-логист настаивал.";
    expect(byId[nominative]).toMatchObject({
      content: fixedNominative,
      content_normalized: normalizeMemoryClaimContent(fixedNominative),
      embedding_status: "pending",
    });
    const fixedGenitive = "По словам Ильи-логиста (Ilya_Demchenko) 10 сентября 2026, шутки про логистов надоели.";
    expect(byId[genitive]).toMatchObject({
      content: fixedGenitive,
      content_normalized: normalizeMemoryClaimContent(fixedGenitive),
      embedding_status: "pending",
    });
    expect(byId[named]).toMatchObject({ content: "Илья-логист (Ilya_Demchenko) просил убрать анекдоты совсем.", embedding_status: "indexed" });
    expect(byId[elsewhere]).toMatchObject({ content: "Илья-логист требовал убрать анекдоты.", embedding_status: "indexed" });
    const fixedLookalike = "Илья-логист (Ilya_Demchenko) спорил с @Ilya_Demchenko2 о шутках.";
    expect(byId[lookalike]).toMatchObject({
      content: fixedLookalike,
      content_normalized: normalizeMemoryClaimContent(fixedLookalike),
      embedding_status: "pending",
    });
    expect(byId[punctuated]).toMatchObject({ content: "Илья, логист тут ни при чём: это Илья-логист пошутил.", embedding_status: "indexed" });
    const jobs = await database().query<{ memory_item_id: string }>(
      "SELECT memory_item_id FROM memory_embedding_jobs WHERE memory_item_id = ANY($1::uuid[])",
      [[nominative, genitive, named, elsewhere, lookalike, punctuated]],
    );
    expect(jobs.rows.map((row) => row.memory_item_id).sort()).toEqual([nominative, genitive, lookalike].sort());

    // Idempotent: the username is there now, nothing left to match.
    await database().query("UPDATE memory_items_all SET embedding_status = 'indexed' WHERE id = ANY($1::uuid[])", [[nominative, genitive]]);
    await database().query(await readFile(MIGRATION, "utf8"));
    const again = await database().query<{ content: string; embedding_status: string }>(
      "SELECT content, embedding_status FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[nominative, genitive]],
    );
    expect(again.rows.every((row) => row.embedding_status === "indexed" && !row.content.includes("(Ilya_Demchenko) (Ilya_Demchenko)"))).toBe(true);
  });
});
