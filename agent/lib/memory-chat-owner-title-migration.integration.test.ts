/**
 * Migration 131: the false «владелец чата» title removed from Ilya Kruglov's records.
 *
 * Constructs covered:
 * - The title next to Kruglov's name goes from the text and from its normalized form, the slot
 *   «оценка владельца чата» becomes «оценка Ильи Круглова», and a visible edited record is queued for
 *   reindexing; a record that only quotes someone talking about «владелец чата», or names another
 *   person's real title, stays as it is.
 * - A second run changes nothing.
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
const MIGRATION = "migrations/131_memory_chat_owner_title.sql";

describeWithDatabase("131 chat owner title", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE users, families CASCADE");
  });
  afterAll(async () => closeDatabase());

  it("drops the title next to Kruglov's name and reindexes the edited records", async () => {
    const fixture = await createMainAgentMemoryFixture();
    const insert = async (content: string, attribute: string | null) => {
      const row = await database().query<{ id: string }>(
        `INSERT INTO memory_items_all
           (family_id, scope, kind, content, content_normalized, source, author_user_id, confirmation,
            sensitivity, operation_key, attribute, embedding_status)
         VALUES ($1, 'family', 'fact', $2, $3, 'test:131', $4, 'model_high', 'normal', $5, $6, 'indexed')
         RETURNING id`,
        [fixture.familyId, content, normalizeMemoryClaimContent(content), fixture.userId, randomUUID(), attribute],
      );
      return row.rows[0]!.id;
    };
    const titled = await insert(
      "По словам владельца чата Ильи Круглова (ilya_kruglov) 18 сентября 2026, Егор — умный.",
      "оценка владельца чата",
    );
    const english = await insert(
      "10 сентября 2026 владелец чата Ilya Kruglov (ilya_kruglov) продолжал заказывать Мие шутки.",
      "общение с Мией",
    );
    // Another person's real title stays: only Kruglov's name is matched (Codex review).
    const other = await insert("Владелец чата Ильдар Иванов утвердил правила.", "оценка владельца чата");
    const quoted = await insert(
      "Serje добивался от Мии, спрашивала ли она владельца чата, прежде чем писать заметки.",
      "общение с Мией",
    );

    await database().query(await readFile(MIGRATION, "utf8"));

    const rows = await database().query<{ attribute: string; content: string; content_normalized: string; embedding_status: string; id: string }>(
      "SELECT id, content, content_normalized, attribute, embedding_status FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[titled, english, quoted, other]],
    );
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
    expect(byId[titled]).toMatchObject({
      attribute: "оценка Ильи Круглова",
      content: "По словам Ильи Круглова (ilya_kruglov) 18 сентября 2026, Егор — умный.",
      content_normalized: normalizeMemoryClaimContent("По словам Ильи Круглова (ilya_kruglov) 18 сентября 2026, Егор — умный."),
      embedding_status: "pending",
    });
    expect(byId[english]).toMatchObject({
      attribute: "общение с Мией",
      content: "10 сентября 2026 Ilya Kruglov (ilya_kruglov) продолжал заказывать Мие шутки.",
      embedding_status: "pending",
    });
    expect(byId[quoted]).toMatchObject({
      content: "Serje добивался от Мии, спрашивала ли она владельца чата, прежде чем писать заметки.",
      embedding_status: "indexed",
    });
    expect(byId[other]).toMatchObject({
      attribute: "оценка владельца чата",
      content: "Владелец чата Ильдар Иванов утвердил правила.",
      embedding_status: "indexed",
    });
    const jobs = await database().query<{ memory_item_id: string }>(
      "SELECT memory_item_id FROM memory_embedding_jobs WHERE memory_item_id = ANY($1::uuid[])",
      [[titled, english, quoted, other]],
    );
    expect(jobs.rows.map((row) => row.memory_item_id).sort()).toEqual([titled, english].sort());

    // Idempotent: nothing left to match on a second run.
    await database().query("UPDATE memory_items_all SET embedding_status = 'indexed' WHERE id = ANY($1::uuid[])", [[titled, english]]);
    await database().query(await readFile(MIGRATION, "utf8"));
    const again = await database().query<{ embedding_status: string }>(
      "SELECT embedding_status FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[titled, english]],
    );
    expect(again.rows.every((row) => row.embedding_status === "indexed")).toBe(true);
  });
});
