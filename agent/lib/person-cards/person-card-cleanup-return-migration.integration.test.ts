/**
 * Migration 153: person cards stop hiding memory, and what they hid comes back.
 *
 * Constructs covered:
 * - A repeat whose kept record stands and a refuted record come back active, with an audit event.
 * - A record whose slot another active version took while it was hidden does not come back: a
 *   refuted one stays superseded. A repeat that does not come back, by an open or a closed row, is
 *   deleted: it is the fact of its kept record, and superseded behind another record it came back
 *   when that one was deleted and purged (review of the fixes, 23 November 2026). No card-written
 *   `duplicate` remains.
 * - A repeat outside the journal (consolidation before v0.12.0) is left alone.
 * - No card counts a record of an open journal row as read any more, a refuted record already back
 *   included, unless the card cites it; a read after an undone row stays.
 * - The log names why records stayed hidden, apart from those already back.
 * The journal table is gone from a migrated database (migration 154): the test creates it from
 * migration 147 inside its own transaction and rolls everything back.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import {
  createPersonCardFixture,
  insertPersonCardRecord,
  OWNER_TELEGRAM_ID,
  resetPersonCardTables,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

async function journalTable(): Promise<string> {
  const sql = await readFile(resolve("migrations/147_person_cards.sql"), "utf8");
  const table = /CREATE TABLE person_card_cleanups \([\s\S]*?\n\);/u.exec(sql)?.[0];
  if (table === undefined) throw new Error("migration 147 has no cleanup journal");
  return table;
}

describeWithDatabase("153 person card cleanup returned", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  it("returns hidden records by the undo rules and leaves no repeat behind", async () => {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(await journalTable());
      const record = (content: string, minutesAgo: number, attribute?: string) =>
        insertPersonCardRecord(
          fixture,
          {
            ...(attribute === undefined ? {} : { attribute }),
            content,
            conversationId: fixture.personalConversationId,
            createdAt: new Date(Date.now() - minutesAgo * 60_000),
            ownerUserId: fixture.ownerId,
            scope: "personal",
            subjectUserId: fixture.ownerId,
          },
          client,
        );
      const build = await client.query<{ id: string }>(
        `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id,
           reason, status, attempts, started_at, finished_at)
         VALUES ($1, 'personal', $2, $3, 'new_records', 'succeeded', 1, now(), now())
         RETURNING id`,
        [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
      );
      const card = await client.query<{ id: string }>(
        `INSERT INTO person_cards (family_id, area, area_key, subject_telegram_user_id, subject_label,
           version, sections, rendered_characters, source_count, sources_as_of)
         VALUES ($1, 'personal', $2, $3, 'Илья', 1, '{}'::jsonb, 1, 1, now()) RETURNING id`,
        [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
      );
      const hide = async (
        hidden: { id: string },
        kept: { id: string },
        reason: "duplicate" | "refuted",
        mates: readonly string[],
        changedSince = false,
      ) => {
        await client.query(
          reason === "duplicate"
            ? `UPDATE memory_items_all SET claim_status = 'duplicate', duplicate_of = $2,
                 updated_at = now() WHERE id = $1`
            : `UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2,
                 updated_at = now() WHERE id = $1`,
          [hidden.id, kept.id],
        );
        await client.query(
          `INSERT INTO person_card_cleanups (build_id, family_id, memory_item_id, kept_memory_item_id,
             reason, explanation, cleaned_updated_at, slot_mate_ids)
           SELECT $1, item.family_id, item.id, $3, $4, 'чистка',
                  item.updated_at - CASE WHEN $6 THEN interval '1 minute' ELSE interval '0' END,
                  $5::uuid[]
           FROM memory_items_all AS item WHERE item.id = $2`,
          [build.rows[0]!.id, hidden.id, kept.id, reason, mates, changedSince],
        );
        await client.query(
          "INSERT INTO person_card_reads (card_id, memory_item_id) VALUES ($1, $2)",
          [card.rows[0]!.id, hidden.id],
        );
      };

      // A repeat of a record that stands, and a record refuted by a newer one.
      const kept = await record("Работает в Яндексе", 30);
      const repeat = await record("Работает в Яндексе, программист", 40);
      await hide(repeat, kept, "duplicate", [kept.id]);
      const newer = await record("Переехал в Казань", 10, "город");
      const refuted = await record("Живёт в Москве", 50, "город");
      await hide(refuted, newer, "refuted", [newer.id]);
      // While hidden, another version took a slot: «машина» got a third record nobody cleaned.
      const car = await record("Ездит на E60", 60, "машина");
      const carRepeat = await record("Водит E60", 70, "машина");
      await hide(carRepeat, car, "duplicate", [car.id]);
      const carNow = await record("Купил E90", 5, "машина");
      // An older version of the slot stood behind the repeat before the cards hid it.
      const carOld = await record("Ездит на Жигулях", 200, "машина");
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2 WHERE id = $1`,
        [carOld.id, carRepeat.id],
      );
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2,
           updated_at = now() WHERE id = $1`,
        [car.id, carNow.id],
      );
      const job = await record("Работает в X", 80, "работа");
      const jobRefuted = await record("Работает в W", 90, "работа");
      await hide(jobRefuted, job, "refuted", [job.id]);
      const jobNow = await record("Работает в Z", 3, "работа");
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2,
           updated_at = now() WHERE id = $1`,
        [job.id, jobNow.id],
      );
      // A repeat changed since its cleanup, with nothing else in its place.
      const changed = await record("Любит кофе", 100);
      const changedKept = await record("Любит кофе без сахара", 20);
      await hide(changed, changedKept, "duplicate", [changedKept.id], true);
      // An older record behind that repeat, which has no slot: it goes behind the kept record.
      const changedOld = await record("Пьёт чай", 210);
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2 WHERE id = $1`,
        [changedOld.id, changed.id],
      );
      // A repeat whose kept record a person deleted while it was hidden.
      const forgotten = await record("Хочет собаку", 120);
      const forgottenKept = await record("Хочет собаку породы корги", 25);
      await hide(forgotten, forgottenKept, "duplicate", [forgottenKept.id]);
      await client.query(
        `UPDATE memory_items_all SET deleted_at = now(), claim_status = 'retracted'
         WHERE id = $1`,
        [forgottenKept.id],
      );
      // A repeat from the consolidation before v0.12.0: no journal row.
      const legacyKept = await record("Пьёт эспрессо", 130);
      const legacy = await record("Любит эспрессо", 140);
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'duplicate', duplicate_of = $2 WHERE id = $1`,
        [legacy.id, legacyKept.id],
      );
      // An undone row: the record came back by the command and a later build read it.
      const undone = await record("Ходит в бассейн", 150);
      await client.query(
        `INSERT INTO person_card_cleanups (build_id, family_id, memory_item_id, reason, explanation,
           cleaned_updated_at, undone_at, undo_outcome)
         VALUES ($1, $2, $3, 'refuted', 'чистка', now(), now(), 'restored')`,
        [build.rows[0]!.id, fixture.familyId, undone.id],
      );
      await client.query(
        "INSERT INTO person_card_reads (card_id, memory_item_id) VALUES ($1, $2)",
        [card.rows[0]!.id, undone.id],
      );
      // An undone row the command left hidden: its slot was taken.
      const closedKept = await record("Любит горы", 35);
      const closedRepeat = await record("Любит горы летом", 160);
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'duplicate', duplicate_of = $2 WHERE id = $1`,
        [closedRepeat.id, closedKept.id],
      );
      await client.query(
        `INSERT INTO person_card_cleanups (build_id, family_id, memory_item_id, kept_memory_item_id,
           reason, explanation, cleaned_updated_at, undone_at, undo_outcome)
         VALUES ($1, $2, $3, $4, 'duplicate', 'чистка', now(), now(), 'changed_since')`,
        [build.rows[0]!.id, fixture.familyId, closedRepeat.id, closedKept.id],
      );
      // A refuted record that came back when its successor was purged, still read by the card.
      const back = await record("Играет на гитаре", 110);
      const backKeeper = await record("Бросил гитару", 15);
      await hide(back, backKeeper, "refuted", [backKeeper.id]);
      await client.query(
        `UPDATE memory_items_all SET claim_status = 'active', superseded_by = NULL WHERE id = $1`,
        [back.id],
      );
      // Another card read it since and cites it: that read stays.
      const citing = await client.query<{ id: string }>(
        `INSERT INTO person_cards (family_id, area, area_key, subject_telegram_user_id, subject_label,
           version, sections, rendered_characters, source_count, sources_as_of)
         VALUES ($1, 'personal', $2, '9999', 'Другой', 1, '{}'::jsonb, 1, 1, now()) RETURNING id`,
        [fixture.familyId, fixture.ownerId],
      );
      await client.query(
        "INSERT INTO person_card_reads (card_id, memory_item_id) VALUES ($1, $2)",
        [citing.rows[0]!.id, back.id],
      );
      await client.query(
        `INSERT INTO person_card_sources (card_id, memory_item_id, source_updated_at, link)
         SELECT $1, id, updated_at, 'subject' FROM memory_items_all WHERE id = $2`,
        [citing.rows[0]!.id, back.id],
      );
      // A repeat left hidden keeps an indexing job until it goes.
      await client.query(
        "INSERT INTO memory_embedding_jobs (memory_item_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [carRepeat.id],
      );

      const notices: string[] = [];
      client.on("notice", (notice) => notices.push(notice.message ?? ""));
      await client.query(
        await readFile(resolve("migrations/153_person_card_cleanup_returned.sql"), "utf8"),
      );

      const state = async (id: string) =>
        (
          await client.query<{
            claim_status: string;
            deleted: boolean;
            superseded_by: string | null;
          }>(
            `SELECT claim_status::text, superseded_by, deleted_at IS NOT NULL AS deleted
             FROM memory_items_all WHERE id = $1`,
            [id],
          )
        ).rows[0];
      expect(await state(repeat.id)).toEqual({
        claim_status: "active",
        deleted: false,
        superseded_by: null,
      });
      expect(await state(refuted.id)).toEqual({
        claim_status: "active",
        deleted: false,
        superseded_by: null,
      });
      const gone = { claim_status: "retracted", deleted: true, superseded_by: null };
      for (const deletedRepeat of [carRepeat, changed, forgotten, closedRepeat]) {
        expect(await state(deletedRepeat.id)).toEqual(gone);
      }
      // Behind the active version of its slot now (the kept record may be another slot's): behind
      // the deleted repeat it came back once that was purged.
      expect(await state(carOld.id)).toEqual({
        claim_status: "superseded",
        deleted: false,
        superseded_by: carNow.id,
      });
      expect(await state(changedOld.id)).toEqual({
        claim_status: "superseded",
        deleted: false,
        superseded_by: changedKept.id,
      });
      expect(await state(jobRefuted.id)).toEqual({
        claim_status: "superseded",
        deleted: false,
        superseded_by: job.id,
      });
      expect(await state(legacy.id)).toEqual({
        claim_status: "duplicate",
        deleted: false,
        superseded_by: null,
      });
      expect(
        (
          await client.query("SELECT 1 FROM memory_embedding_jobs WHERE memory_item_id = $1", [
            carRepeat.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(await state(back.id)).toEqual({
        claim_status: "active",
        deleted: false,
        superseded_by: null,
      });
      const repeats = await client.query<{ id: string }>(
        "SELECT id FROM memory_items_all WHERE claim_status = 'duplicate' AND family_id = $1",
        [fixture.familyId],
      );
      expect(repeats.rows.map((row) => row.id)).toEqual([legacy.id]);
      const reads = await client.query<{ card_id: string; memory_item_id: string }>(
        "SELECT card_id, memory_item_id FROM person_card_reads",
      );
      expect(reads.rows).toEqual(
        expect.arrayContaining([
          { card_id: card.rows[0]!.id, memory_item_id: undone.id },
          { card_id: citing.rows[0]!.id, memory_item_id: back.id },
        ]),
      );
      expect(reads.rows).toHaveLength(2);
      const audits = await client.query<{
        event_type: string;
        reason: string;
        subject_id: string;
      }>(
        `SELECT event_type, metadata->>'reason' AS reason, subject_id FROM audit_events
         WHERE event_type IN ('memory.person_card_cleanup_undone', 'memory.deleted')
           AND family_id = $1 ORDER BY event_type, subject_id`,
        [fixture.familyId],
      );
      const events = (type: string, reasons: ReadonlyArray<[string, string]>) =>
        [...reasons]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, reason]) => ({ event_type: type, reason, subject_id: id }));
      expect(audits.rows).toEqual([
        ...events(
          "memory.deleted",
          [carRepeat, changed, forgotten, closedRepeat].map(({ id }) => [id, "person_card_repeat"]),
        ),
        ...events("memory.person_card_cleanup_undone", [
          [repeat.id, "duplicate"],
          [refuted.id, "refuted"],
        ]),
      ]);
      expect(notices).toEqual([
        "person card cleanup returned: 2 restored, 1 already back; stayed hidden: 1 changed since, " +
          "0 deleted, 1 kept record gone, 2 slot taken; 4 repeats left hidden deleted, " +
          "2 older versions moved behind the active version of their slot or the kept record; " +
          "7 reads dropped",
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
