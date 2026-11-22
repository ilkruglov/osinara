/**
 * The cleanup's records under concurrent writers, against PostgreSQL.
 *
 * Constructs covered:
 * - Undo waits for a memory write that holds the record's empty slot or its text, and then leaves
 *   the record hidden: two active versions of one slot or two copies of one text never come out
 *   of a race.
 * - Undo and a delete of the kept record agree: a repeat undo reports restored stays active.
 * - Undo and the purge of the record a cleaned one points at do not deadlock: undo takes the
 *   record before its journal row, as the purge's trigger and foreign key do.
 * - A publish and a person's delete survive losing a deadlock to each other (the delete takes the
 *   record before its hidden repeats, the publish all its rows in creation order): the side
 *   PostgreSQL aborts retries once.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { memoryRepository } from "../memory-repository.js";
import { purgeSoftDeletedMemory } from "../memory-retention.js";
import { lockExactMemoryDuplicate } from "../memory-exact-reinforcement.js";
import { lockMemorySlot } from "../memory-slot-supersede.js";
import { undoPersonCardCleanups } from "./person-card-cleanup-undo.js";
import {
  claimOwnerBuild,
  deadlockCount,
  insertOwnerRecord,
  markOwnerRepeat,
  ownerPublishInput,
  publishOwnerCleanup,
  waitForLockWaiters,
} from "./person-card-cleanup.integration-fixtures.js";
import { publishPersonCard } from "./person-card-publish-repository.js";
import {
  createPersonCardFixture,
  insertPersonCardRecord,
  resetPersonCardTables,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("person card cleanup under concurrent writers", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  const owner = (content: string, minutesAgo: number, attribute?: string) =>
    insertOwnerRecord(fixture, content, minutesAgo, attribute);

  it("waits for a memory write holding the slot and leaves the record hidden", async () => {
    const moscow = await owner("Живёт в Москве", 120, "город");
    const moved = await owner("Переехал из Москвы", 110);
    await publishOwnerCleanup(fixture, [{ item: moscow, kept: moved, reason: "refuted" }]);

    // A memory write found the slot empty and has not committed yet.
    const writer = await database().connect();
    try {
      await writer.query("BEGIN");
      await lockMemorySlot(writer, fixture.familyId, {
        attribute: "город",
        kind: "preference",
        memoryProjectId: null,
        scope: "personal",
        scopePartitionKey: fixture.ownerId,
        subjectLabel: null,
        subjectParticipantId: null,
        subjectUserId: fixture.ownerId,
      });
      await insertPersonCardRecord(
        fixture,
        {
          attribute: "город",
          content: "Живёт в Казани",
          conversationId: fixture.personalConversationId,
          ownerUserId: fixture.ownerId,
          scope: "personal",
          subjectUserId: fixture.ownerId,
        },
        writer,
      );
      const undo = undoPersonCardCleanups({ buildId: null });
      const settled = await Promise.race([
        undo.then(() => "undone"),
        waitForLockWaiters(1).then(() => "waiting"),
      ]);
      expect(settled).toBe("waiting");
      await writer.query("COMMIT");
      expect(await undo).toEqual({ changedSince: 1, restored: 0 });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    const active = await database().query<{ content: string }>(
      `SELECT content FROM memory_items WHERE attribute = 'город' AND claim_status = 'active'`,
    );
    expect(active.rows).toEqual([{ content: "Живёт в Казани" }]);
  });

  it("waits for a memory write of the same text and leaves the repeat hidden", async () => {
    const repeat = await owner("Пьёт эспрессо", 120);
    const kept = await owner("Любит эспрессо", 110);
    await publishOwnerCleanup(fixture, [{ item: repeat, kept, reason: "duplicate" }]);

    // A memory write found no record with this text and has not committed yet.
    const writer = await database().connect();
    try {
      await writer.query("BEGIN");
      await lockExactMemoryDuplicate(writer, {
        contentNormalized: "пьёт эспрессо",
        memoryProjectId: null,
        scope: "personal",
        scopePartitionKey: fixture.ownerId,
        subjectLabel: null,
        subjectParticipantId: null,
        subjectUserId: fixture.ownerId,
      });
      await insertPersonCardRecord(
        fixture,
        {
          content: "Пьёт эспрессо",
          conversationId: fixture.personalConversationId,
          ownerUserId: fixture.ownerId,
          scope: "personal",
          subjectUserId: fixture.ownerId,
        },
        writer,
      );
      const undo = undoPersonCardCleanups({ buildId: null });
      const settled = await Promise.race([
        undo.then(() => "undone"),
        waitForLockWaiters(1).then(() => "waiting"),
      ]);
      expect(settled).toBe("waiting");
      await writer.query("COMMIT");
      expect(await undo).toEqual({ changedSince: 1, restored: 0 });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    const active = await database().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM memory_items
       WHERE content = 'Пьёт эспрессо' AND claim_status = 'active'`,
    );
    expect(active.rows).toEqual([{ count: 1 }]);
  });

  it("does not report a repeat restored that a delete of its kept record takes with it", async () => {
    const repeat = await owner("Пьёт эспрессо", 120);
    const kept = await owner("Любит эспрессо", 110);
    await publishOwnerCleanup(fixture, [{ item: repeat, kept, reason: "duplicate" }]);
    // A third session holds the journal row: undo stops just before it, and the person deletes
    // the kept record meanwhile.
    const holder = await database().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM person_card_cleanups FOR UPDATE");
      const undo = undoPersonCardCleanups({ buildId: null });
      await waitForLockWaiters(1);
      const deletion = memoryRepository.deleteByRef(
        fixture.ownerAuth,
        kept.memoryRef,
        "locks:delete-kept-during-undo",
      );
      await waitForLockWaiters(2);
      await holder.query("ROLLBACK");
      const outcome = await undo;
      await deletion;
      const status = await database().query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM memory_items_all WHERE id = $1",
        [repeat.id],
      );
      // Whichever went first, the report matches the record.
      expect(status.rows[0]!.deleted).toBe(outcome.restored === 0);
    } finally {
      holder.release();
    }
  });

  it("does not deadlock with purging the record that refuted the cleaned one", async () => {
    const moscow = await owner("Живёт в Москве", 120);
    const kazan = await owner("Переехал в Казань", 110);
    await publishOwnerCleanup(fixture, [{ item: moscow, kept: kazan, reason: "refuted" }]);
    await memoryRepository.deleteByRef(fixture.ownerAuth, kazan.memoryRef, "locks:delete-kazan");

    // A third session holds the cleaned record, so the purge's trigger waits on it first and undo
    // second; then it lets go.
    const holder = await database().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM memory_items_all WHERE id = $1 FOR UPDATE", [moscow.id]);
      const before = await deadlockCount();
      const purge = purgeSoftDeletedMemory(new Date(Date.now() + 40 * 24 * 60 * 60_000));
      await waitForLockWaiters(1);
      const undo = undoPersonCardCleanups({ buildId: null });
      await waitForLockWaiters(2);
      await holder.query("ROLLBACK");
      expect(await purge).toBe(1);
      expect(await undo).toEqual({ changedSince: 1, restored: 0 });
      expect(await deadlockCount()).toBe(before);
    } finally {
      holder.release();
    }
  });

  it("retries a publish that lost a deadlock to a person's delete", async () => {
    const repeat = await owner("Пьёт эспрессо", 120);
    const kept = await owner("Любит эспрессо", 60);
    const build = await claimOwnerBuild(fixture);
    await markOwnerRepeat(repeat, kept);
    // A third session holds the delete's operation key: the delete stops right after taking the
    // kept record, the publish takes the repeat and waits for the kept record first, and then the
    // delete reaches the repeat: PostgreSQL aborts the publish, the first to wait.
    const holder = await database().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `INSERT INTO memory_mutation_operations (family_id, operation_key, mutation_kind, input_hash)
         VALUES ($1, 'locks:forget-kept', 'delete', repeat('0', 64))`,
        [fixture.familyId],
      );
      const before = await deadlockCount();
      const deletion = memoryRepository.deleteByRef(
        fixture.ownerAuth,
        kept.memoryRef,
        "locks:forget-kept",
      );
      await waitForLockWaiters(1);
      const publish = publishPersonCard(ownerPublishInput(build, kept));
      await waitForLockWaiters(2);
      await holder.query("ROLLBACK");
      expect(await deletion).toEqual({ deleted: true });
      expect(await publish).toMatchObject({ cardVersion: 1 });
      expect(await deadlockCount()).toBe(before + 1);
    } finally {
      holder.release();
    }
  });

  it("retries a person's delete that lost a deadlock to a publish", async () => {
    const repeat = await owner("Пьёт эспрессо", 120);
    const between = await owner("Ездит на E60", 90);
    const kept = await owner("Любит эспрессо", 60);
    const build = await claimOwnerBuild(fixture);
    // Another area's build hid the repeat behind the kept record while this one ran.
    await markOwnerRepeat(repeat, kept);

    // A third session holds the record between the two, so the publish waits there holding the
    // repeat, the delete takes the kept record and waits for the repeat first, and only then does
    // the publish reach the kept record: PostgreSQL aborts the delete, the first to wait.
    const holder = await database().connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM memory_items_all WHERE id = $1 FOR UPDATE", [between.id]);
      const before = await deadlockCount();
      const publish = publishPersonCard(ownerPublishInput(build, kept));
      await waitForLockWaiters(1);
      const deletion = memoryRepository.deleteByRef(
        fixture.ownerAuth,
        kept.memoryRef,
        "locks:delete-kept",
      );
      await waitForLockWaiters(2);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query("ROLLBACK");
      expect(await publish).toMatchObject({ cardVersion: 1 });
      expect(await deletion).toEqual({ deleted: true });
      expect(await deadlockCount()).toBe(before + 1);
    } finally {
      holder.release();
    }
    const gone = await database().query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[repeat.id, kept.id]],
    );
    expect(gone.rows).toEqual([{ deleted: true }, { deleted: true }]);
  });
});
