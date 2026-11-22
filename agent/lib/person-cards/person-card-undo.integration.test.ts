/**
 * Undo of the person card cleanup, against PostgreSQL.
 *
 * Constructs covered:
 * - Undo returns the cleaned records to active and, with the card still shown, back into the
 *   profile block (no card counts them as read); it leaves a record a person changed after the
 *   cleanup as it is; a second undo finds nothing open.
 * - Deleting a kept record deletes its hidden repeats with it, along a whole chain (otherwise
 *   purging it later returns them to active); a cleaned record can be deleted by its ref; undo
 *   does not bring back a repeat of a deleted record.
 * - A record kept in place of a repeat is never cleaned itself (no chains).
 * - Undo leaves hidden a record whose slot got a newer version meanwhile: two active versions of
 *   one slot would be worse than the cleanup.
 * - Undo shows the record in every area's card at once: a family cleanup undone shows up beside
 *   the member's personal card, and a build that read the records while it was hidden does not
 *   hide it again.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { memoryRepository } from "../memory-repository.js";
import { profileViewRepository } from "../profile-view-repository.js";
import { undoPersonCardCleanups } from "./person-card-cleanup-undo.js";
import { personCardDispatchRepository } from "./person-card-dispatch-repository.js";
import type { PersonCardKey } from "./person-card-links.js";
import { publishPersonCard } from "./person-card-publish-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import {
  createPersonCardFixture,
  insertPersonCardRecord,
  OWNER_TELEGRAM_ID,
  resetPersonCardTables,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/** The owner's private profile block, as a turn showing their cards builds it when `withCards`. */
async function profileContents(
  fixture: PersonCardFixture,
  turnId: string,
  withCards = false,
): Promise<string[]> {
  const cards = withCards
    ? (await database().query<{ id: string }>("SELECT id FROM person_cards")).rows.map(
        (row) => row.id,
      )
    : [];
  const view = await profileViewRepository.create(fixture.ownerAuth, {
    conversationId: fixture.personalConversationId,
    currentTelegramUserId: OWNER_TELEGRAM_ID,
    explicitMentionTelegramUserIds: [],
    now: new Date(),
    personCardIds: cards,
    provenance: { sessionId: "session-undo", turnId },
    replyTelegramUserId: null,
    retrievalClaimIds: [],
  });
  return view.subjects.flatMap((subject) => subject.claims.map((claim) => claim.content)).sort();
}

describeWithDatabase("person card cleanup undo", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  it("restores cleaned records except the ones people changed since", async () => {
    const records: string[] = [];
    for (const content of [
      "Пьёт эспрессо",
      "Любит эспрессо",
      "Живёт в Москве",
      "Переехал в Казань",
    ]) {
      records.push(
        (
          await insertPersonCardRecord(fixture, {
            content,
            conversationId: fixture.personalConversationId,
            createdAt: new Date(Date.now() - 60 * 60_000),
            ownerUserId: fixture.ownerId,
            scope: "personal",
            subjectUserId: fixture.ownerId,
          })
        ).id,
      );
    }
    await database().query(
      `INSERT INTO profile_subjects
         (conversation_id, family_id, subject_user_id, display_label_snapshot, last_verified_at)
       VALUES ($1, $2, $3, 'Илья', now())`,
      [fixture.personalConversationId, fixture.familyId, fixture.ownerId],
    );
    const key: PersonCardKey = {
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    };
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'personal', $2, $3, 'new_records')`,
      [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
    );
    const [claimed] = await personCardDispatchRepository.claim(2);
    const sources = await loadPersonCardSources(key);
    const version = (id: string) => sources.records.find((record) => record.id === id)!.version;
    const result = await publishPersonCard({
      buildId: claimed!.id,
      characters: 20,
      cited: sources.records.filter(
        (record) => record.id === records[1] || record.id === records[3],
      ),
      cleanup: [
        {
          explanation: "то же самое",
          keptMemoryItemId: records[1]!,
          memoryItemId: records[0]!,
          readVersion: version(records[0]!),
          reason: "duplicate",
        },
        {
          explanation: "переехал",
          keptMemoryItemId: records[3]!,
          memoryItemId: records[2]!,
          readVersion: version(records[2]!),
          reason: "refuted",
        },
      ],
      cleanupEnabled: true,
      inputRecords: 4,
      key,
      leaseToken: claimed!.leaseToken,
      readIds: sources.records.map((record) => record.id),
      sections: {
        communication: [],
        facts: [{ scope: "всегда", sourceRefs: [], text: "Живёт в Казани" }],
        interests: [],
        positions: [],
      },
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    expect(result.cleaned).toBe(2);
    expect(await profileContents(fixture, "before-undo")).toEqual([
      "Любит эспрессо",
      "Переехал в Казань",
    ]);
    // With the card shown, the records it read stay out of the block.
    expect(await profileContents(fixture, "before-undo-card", true)).toEqual([]);

    // A person touched the refuted record after the cleanup: undo leaves it to them.
    await database().query(
      "UPDATE memory_items_all SET updated_at = now() + interval '1 second' WHERE id = $1",
      [records[2]],
    );
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 1,
      restored: 1,
    });
    // The card stays; it no longer counts the restored record as read, so the block shows it.
    expect(await profileContents(fixture, "after-undo-card", true)).toEqual(["Пьёт эспрессо"]);
    expect(await profileContents(fixture, "after-undo")).toEqual([
      "Любит эспрессо",
      "Переехал в Казань",
      "Пьёт эспрессо",
    ]);
    const statuses = await database().query<{ claim_status: string; id: string }>(
      "SELECT id, claim_status FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[records[0], records[2]]],
    );
    expect(new Map(statuses.rows.map((row) => [row.id, row.claim_status]))).toEqual(
      new Map([
        [records[0], "active"],
        [records[2], "superseded"],
      ]),
    );
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 0,
      restored: 0,
    });
    await expect(
      undoPersonCardCleanups({ buildId: "00000000-0000-4000-8000-00000000abcd" }),
    ).rejects.toMatchObject({ code: "AGENT_PERSON_CARD_BUILD_NOT_FOUND" });
  });

  it("deletes the hidden repeats of a deleted record and lets a cleaned record be deleted", async () => {
    const personal = async (content: string) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.personalConversationId,
        createdAt: new Date(Date.now() - 60 * 60_000),
        ownerUserId: fixture.ownerId,
        scope: "personal",
        subjectUserId: fixture.ownerId,
      });
    const repeat = await personal("Пьёт эспрессо");
    const kept = await personal("Любит эспрессо");
    const refuted = await personal("Живёт в Москве");
    const newer = await insertPersonCardRecord(fixture, {
      content: "Переехал в Казань",
      conversationId: fixture.personalConversationId,
      createdAt: new Date(Date.now() - 30 * 60_000),
      ownerUserId: fixture.ownerId,
      scope: "personal",
      subjectUserId: fixture.ownerId,
    });
    const key: PersonCardKey = {
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    };
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'personal', $2, $3, 'new_records')`,
      [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
    );
    const [claimed] = await personCardDispatchRepository.claim(2);
    const sources = await loadPersonCardSources(key);
    const version = (id: string) => sources.records.find((record) => record.id === id)!.version;
    await publishPersonCard({
      buildId: claimed!.id,
      characters: 20,
      cited: sources.records.filter((record) => record.id === kept.id || record.id === newer.id),
      cleanup: [
        {
          explanation: "повтор",
          keptMemoryItemId: kept.id,
          memoryItemId: repeat.id,
          readVersion: version(repeat.id),
          reason: "duplicate",
        },
        {
          explanation: "переехал",
          keptMemoryItemId: newer.id,
          memoryItemId: refuted.id,
          readVersion: version(refuted.id),
          reason: "refuted",
        },
      ],
      cleanupEnabled: true,
      inputRecords: 4,
      key,
      leaseToken: claimed!.leaseToken,
      readIds: sources.records.map((record) => record.id),
      sections: {
        communication: [],
        facts: [{ scope: "всегда", sourceRefs: [], text: "Живёт в Казани" }],
        interests: [],
        positions: [],
      },
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });

    await memoryRepository.deleteByRef(fixture.ownerAuth, kept.memoryRef, "forget-espresso");
    await memoryRepository.deleteByRef(fixture.ownerAuth, refuted.memoryRef, "forget-moscow");
    const rows = await database().query<{ claim_status: string; deleted: boolean; id: string }>(
      "SELECT id, claim_status, deleted_at IS NOT NULL AS deleted FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[repeat.id, kept.id, refuted.id]],
    );
    expect(new Map(rows.rows.map((row) => [row.id, [row.claim_status, row.deleted]]))).toEqual(
      new Map([
        [repeat.id, ["retracted", true]],
        [kept.id, ["retracted", true]],
        [refuted.id, ["retracted", true]],
      ]),
    );
    // Purging the kept record later finds no hidden repeat to return to active.
    await database().query("DELETE FROM memory_items_all WHERE id = $1", [kept.id]);
    expect(
      (
        await database().query("SELECT claim_status FROM memory_items_all WHERE id = $1", [
          repeat.id,
        ])
      ).rows,
    ).toEqual([{ claim_status: "retracted" }]);
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 2,
      restored: 0,
    });
  });

  it("undoes across areas, past a running build, and never builds a chain", async () => {
    const family = (content: string, minutesAgo: number) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.familyConversationId,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        scope: "family",
        subjectUserId: fixture.ownerId,
      });
    const repeat = await family("Пьёт эспрессо", 90);
    const kept = await family("Любит эспрессо", 60);
    await family("Ездит на E60", 50);
    await database().query(
      `INSERT INTO profile_subjects
         (conversation_id, family_id, subject_user_id, display_label_snapshot, last_verified_at)
       VALUES ($1, $2, $3, 'Илья', now())`,
      [fixture.personalConversationId, fixture.familyId, fixture.ownerId],
    );
    const familyKey: PersonCardKey = {
      area: "family",
      areaKey: fixture.familyId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    };
    const personalKey: PersonCardKey = { ...familyKey, area: "personal", areaKey: fixture.ownerId };
    const publish = async (
      key: PersonCardKey,
      cleanup: Parameters<typeof publishPersonCard>[0]["cleanup"],
    ) => {
      await database().query(
        `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
         VALUES ($1, $2, $3, $4, 'new_records')`,
        [key.familyId, key.area, key.areaKey, key.subjectTelegramUserId],
      );
      const [claimed] = await personCardDispatchRepository.claim(4);
      const sources = await loadPersonCardSources(key);
      return { claimed: claimed!, key, sources, cleanup };
    };
    const finish = async (pending: Awaited<ReturnType<typeof publish>>) =>
      publishPersonCard({
        buildId: pending.claimed.id,
        characters: 20,
        cited: pending.sources.records,
        cleanup: pending.cleanup,
        cleanupEnabled: true,
        inputRecords: pending.sources.records.length,
        key: pending.key,
        leaseToken: pending.claimed.leaseToken,
        readIds: pending.sources.records.map((record) => record.id),
        sections: {
          communication: [],
          facts: [{ scope: "всегда", sourceRefs: [], text: "Кофе" }],
          interests: [],
          positions: [],
        },
        sourcesAsOf: pending.sources.sourcesAsOf,
        subjectLabel: pending.sources.subjectLabel,
      });
    const familySources = await loadPersonCardSources(familyKey);
    const version = (id: string) =>
      familySources.records.find((record) => record.id === id)!.version;
    const familyBuild = await publish(familyKey, [
      {
        explanation: "повтор",
        keptMemoryItemId: kept.id,
        memoryItemId: repeat.id,
        readVersion: version(repeat.id),
        reason: "duplicate",
      },
    ]);
    expect((await finish(familyBuild)).cleaned).toBe(1);
    // The kept record is no longer cleanable: no chains.
    const after = await loadPersonCardSources(familyKey);
    expect(after.records.find((record) => record.id === kept.id)!.cleanable).toBe(false);
    await finish(await publish(personalKey, []));
    // A build of the personal card reads while the repeat is hidden and publishes after the undo.
    const inflight = await publish(personalKey, []);
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 0,
      restored: 1,
    });
    await finish(inflight);
    expect(await profileContents(fixture, "after-undo-cards", true)).toEqual(["Пьёт эспрессо"]);
  });

  it("deletes a whole chain of repeats with its end", async () => {
    const personal = (content: string) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.personalConversationId,
        ownerUserId: fixture.ownerId,
        scope: "personal",
        subjectUserId: fixture.ownerId,
      });
    const a = await personal("A");
    const b = await personal("B");
    const c = await personal("C");
    await database().query(
      "UPDATE memory_items_all SET claim_status = 'duplicate', duplicate_of = $2 WHERE id = $1",
      [b.id, c.id],
    );
    await database().query(
      "UPDATE memory_items_all SET claim_status = 'duplicate', duplicate_of = $2 WHERE id = $1",
      [a.id, b.id],
    );
    await memoryRepository.deleteByRef(fixture.ownerAuth, c.memoryRef, "forget-chain");
    const rows = await database().query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM memory_items_all WHERE id = ANY($1::uuid[])",
      [[a.id, b.id, c.id]],
    );
    expect(rows.rows.every((row) => row.deleted)).toBe(true);
  });

  it("does not restore a record whose slot got a newer version while it was hidden", async () => {
    const personal = (content: string, minutesAgo: number) =>
      insertPersonCardRecord(fixture, {
        attribute: "город",
        content,
        conversationId: fixture.personalConversationId,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        ownerUserId: fixture.ownerId,
        scope: "personal",
        subjectUserId: fixture.ownerId,
      });
    const moscow = await personal("Живёт в Москве", 120);
    const kazan = await insertPersonCardRecord(fixture, {
      content: "Переехал в Казань",
      conversationId: fixture.personalConversationId,
      createdAt: new Date(Date.now() - 60 * 60_000),
      ownerUserId: fixture.ownerId,
      scope: "personal",
      subjectUserId: fixture.ownerId,
    });
    const key: PersonCardKey = {
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    };
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'personal', $2, $3, 'new_records')`,
      [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
    );
    const [claimed] = await personCardDispatchRepository.claim(2);
    const sources = await loadPersonCardSources(key);
    const result = await publishPersonCard({
      buildId: claimed!.id,
      characters: 20,
      cited: sources.records.filter((record) => record.id === kazan.id),
      cleanup: [
        {
          explanation: "переехал",
          keptMemoryItemId: kazan.id,
          memoryItemId: moscow.id,
          readVersion: sources.records.find((record) => record.id === moscow.id)!.version,
          reason: "refuted",
        },
      ],
      cleanupEnabled: true,
      inputRecords: 2,
      key,
      leaseToken: claimed!.leaseToken,
      readIds: sources.readIds,
      sections: {
        communication: [],
        facts: [{ scope: "всегда", sourceRefs: [kazan.memoryRef], text: "Живёт в Казани" }],
        interests: [],
        positions: [],
      },
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    expect(result.cleaned).toBe(1);
    // The slot looked empty to memory writes while Moscow was hidden: a new version went in.
    await personal("Живёт в Казани, Вахитовский район", 0);
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 1,
      restored: 0,
    });
  });

  it("does not restore a repeat whose text about the same person was written again", async () => {
    const owner = (content: string) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.personalConversationId,
        createdAt: new Date(Date.now() - 60 * 60_000),
        ownerUserId: fixture.ownerId,
        scope: "personal",
        subjectUserId: fixture.ownerId,
      });
    const repeat = await owner("Пьёт эспрессо");
    const kept = await owner("Любит эспрессо");
    const key: PersonCardKey = {
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    };
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'personal', $2, $3, 'new_records')`,
      [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
    );
    const [claimed] = await personCardDispatchRepository.claim(2);
    const sources = await loadPersonCardSources(key);
    await publishPersonCard({
      buildId: claimed!.id,
      characters: 20,
      cited: sources.records.filter((record) => record.id === kept.id),
      cleanup: [
        {
          explanation: "повтор",
          keptMemoryItemId: kept.id,
          memoryItemId: repeat.id,
          readVersion: sources.records.find((record) => record.id === repeat.id)!.version,
          reason: "duplicate",
        },
      ],
      cleanupEnabled: true,
      inputRecords: 2,
      key,
      leaseToken: claimed!.leaseToken,
      readIds: sources.readIds,
      sections: {
        communication: [],
        facts: [{ scope: "всегда", sourceRefs: [kept.memoryRef], text: "Кофе" }],
        interests: [],
        positions: [],
      },
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    // Written again while the repeat was hidden: restoring it would make a second copy.
    await owner("Пьёт эспрессо");
    expect(await undoPersonCardCleanups({ buildId: null })).toEqual({
      changedSince: 1,
      restored: 0,
    });
  });
});
