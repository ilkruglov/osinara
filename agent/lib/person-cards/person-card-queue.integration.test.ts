/**
 * Person card queue and publishing against PostgreSQL.
 *
 * Constructs covered:
 * - Due: 9 new records no, 10 yes, a second build within a day no, the person's own record about
 *   themselves at once (after a quiet window), a deleted cited record once a day; a failed build of
 *   the person's own words is retried after a back-off, not lost; the day counts from the end of
 *   the last build, not from its request.
 * - Leases: an expired lease returns the build to pending, spent attempts fail it; a retry waits
 *   for its pause; a deploy pause claims nothing.
 * - New means unread: records the card read never count again, however recent; the week's limit
 *   of failed builds stops the person's builds, counting a build when any attempt may have been
 *   paid; the person confirming someone else's record about them counts as their own words.
 * - Publishing: versions and sources; a lost or expired lease publishes nothing, fails nothing and
 *   retries nothing; the cleanup marks repeats and skips confirmed, changed, other-area, kept and
 *   switched-off cases; a journal row left open by a purged kept record does not break the next
 *   cleanup.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { PERSON_CARD_MAX_FAILED_BUILDS_PER_WEEK } from "./person-card-config.js";
import { personCardDispatchRepository } from "./person-card-dispatch-repository.js";
import type { PersonCardKey } from "./person-card-links.js";
import type { PersonCardSections } from "./person-card-parse.js";
import { failPersonCardBuild, publishPersonCard } from "./person-card-publish-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import {
  createPersonCardFixture,
  insertPersonCardRecord,
  resetPersonCardTables,
  YURA_TELEGRAM_ID,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const SECTIONS: PersonCardSections = {
  communication: [{ scope: "всегда", sourceRefs: [], text: "Коротко" }],
  facts: [],
  interests: [],
  positions: [],
};

function yuraKey(fixture: PersonCardFixture): PersonCardKey {
  return {
    area: "group",
    areaKey: fixture.groupA.id,
    familyId: fixture.familyId,
    subjectTelegramUserId: YURA_TELEGRAM_ID,
  };
}

async function addYuraRecords(fixture: PersonCardFixture, count: number, createdAt?: Date) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = await insertPersonCardRecord(fixture, {
      content: `Юра ${Math.random()}`,
      conversationId: fixture.groupA.conversationId,
      ...(createdAt === undefined ? {} : { createdAt }),
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    ids.push(record.id);
  }
  return ids;
}

/** Claims the queued build and publishes a card citing every record the build reads. */
async function buildCard(
  fixture: PersonCardFixture,
  cleanup: Parameters<typeof publishPersonCard>[0]["cleanup"] = [],
  readAllLoaded = false,
) {
  const [claimed] = await personCardDispatchRepository.claim(2);
  const sources = await loadPersonCardSources(yuraKey(fixture));
  const result = await publishPersonCard({
    buildId: claimed!.id,
    characters: 7,
    cited: sources.records,
    cleanup,
    cleanupEnabled: true,
    inputRecords: sources.records.length,
    key: yuraKey(fixture),
    leaseToken: claimed!.leaseToken,
    readIds: readAllLoaded ? sources.readIds : sources.records.map((record) => record.id),
    sections: SECTIONS,
    sourcesAsOf: sources.sourcesAsOf,
    subjectLabel: sources.subjectLabel,
  });
  return { claimed: claimed!, result, sources };
}

async function ageBuilds(hours: number): Promise<void> {
  await database().query(
    `UPDATE person_card_builds SET requested_at = requested_at - $1::interval,
       started_at = started_at - $1::interval, finished_at = finished_at - $1::interval`,
    [`${hours} hours`],
  );
  await database().query(
    `UPDATE person_cards SET built_at = built_at - $1::interval,
       sources_as_of = sources_as_of - $1::interval`,
    [`${hours} hours`],
  );
}

/** Failed builds of Юра in group A that may have cost a model call, finished a day ago. */
async function seedPaidFailures(fixture: PersonCardFixture, count: number) {
  const key = yuraKey(fixture);
  await database().query(
    `INSERT INTO person_card_builds
       (family_id, area, area_key, subject_telegram_user_id, reason, status, attempts,
        requested_at, started_at, finished_at, error_code, possibly_paid)
     SELECT $1, $2, $3, $4, 'new_records', 'failed', 1, now() - interval '27 hours',
            now() - interval '27 hours', now() - interval '26 hours', 'AGENT_X', true
     FROM generate_series(1, $5)`,
    [key.familyId, key.area, key.areaKey, key.subjectTelegramUserId, count],
  );
}

describeWithDatabase("person card queue", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  it("rebuilds after ten new records, at most once a day", async () => {
    await addYuraRecords(fixture, 9);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await addYuraRecords(fixture, 1);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "new_records" },
    ]);
    // An open build blocks a second one.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    const { result } = await buildCard(fixture);
    expect(result.cardVersion).toBe(1);

    await ageBuilds(1);
    await addYuraRecords(fixture, 10);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await ageBuilds(24);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "new_records" },
    ]);
    const second = await buildCard(fixture);
    expect(second.result.cardVersion).toBe(2);
    const card = await database().query(
      "SELECT version, source_count FROM person_cards WHERE subject_telegram_user_id = $1",
      [YURA_TELEGRAM_ID],
    );
    expect(card.rows).toEqual([{ source_count: 20, version: 2 }]);
  });

  it("rebuilds at once on the person's own words, once a day on a deleted source", async () => {
    const [first] = await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(1);
    const own = {
      content: "Я теперь живу в Казани",
      conversationId: fixture.groupA.conversationId,
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" as const },
      groupId: fixture.groupA.id,
      scope: "group" as const,
      subjectLabel: "Юра (yura_k)",
    };
    await insertPersonCardRecord(fixture, own);
    // Quiet for two minutes first: a review batch writes its records together.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await database().query(
      "UPDATE memory_items_all SET created_at = now() - interval '3 minutes' WHERE content = $1",
      [own.content],
    );
    await database().query(
      `UPDATE claim_evidence SET created_at = now() - interval '3 minutes'
       WHERE claim_id IN (SELECT id FROM memory_items_all WHERE content = $1)`,
      [own.content],
    );
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "self_statement" },
    ]);
    await buildCard(fixture);
    // The same words do not rebuild twice.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);

    // A deleted source takes only the items citing it out of the turn; the rebuild is daily.
    await database().query("UPDATE memory_items_all SET deleted_at = now() WHERE id = $1", [first]);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await database().query(
      `UPDATE person_card_builds SET requested_at = requested_at - interval '25 hours',
         finished_at = finished_at - interval '25 hours'`,
    );
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "invalidated" },
    ]);
  });

  it("retries a failed build of the person's own words after a back-off", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(1);
    await insertPersonCardRecord(fixture, {
      content: "Я переехал в Казань",
      conversationId: fixture.groupA.conversationId,
      createdAt: new Date(Date.now() - 3 * 60_000),
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" },
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "self_statement" },
    ]);
    const [claimed] = await personCardDispatchRepository.claim(2);
    await failPersonCardBuild({
      buildId: claimed!.id,
      errorCode: "AGENT_PERSON_CARD_PUBLISH_FAILED",
      inputRecords: 11,
      leaseToken: claimed!.leaseToken,
      possiblyPaid: true,
    });
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await database().query(
      "UPDATE person_card_builds SET finished_at = now() - interval '7 hours' WHERE status = 'failed'",
    );
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "self_statement" },
    ]);
  });

  it("counts the day from the end of the last build, not from its request", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    // The build waited 23 hours in the queue and finished an hour ago.
    await database().query(
      `UPDATE person_card_builds SET requested_at = now() - interval '25 hours',
         started_at = now() - interval '1 hour', finished_at = now() - interval '1 hour'`,
    );
    await database().query(
      "UPDATE person_cards SET built_at = now() - interval '1 hour', sources_as_of = now() - interval '61 minutes'",
    );
    await addYuraRecords(fixture, 10);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
  });

  it("counts only unread records as new and stops at the week's failed builds", async () => {
    // Ten records the build reads seconds before its snapshot are known, not new, a day later.
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(25);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);

    await addYuraRecords(fixture, 10);
    await seedPaidFailures(fixture, PERSON_CARD_MAX_FAILED_BUILDS_PER_WEEK - 1);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "new_records" },
    ]);
    const [claimed] = await personCardDispatchRepository.claim(2);
    await failPersonCardBuild({
      buildId: claimed!.id,
      errorCode: "AGENT_PERSON_CARD_RESPONSE_INVALID",
      inputRecords: 20,
      leaseToken: claimed!.leaseToken,
      possiblyPaid: true,
    });
    await database().query(
      `UPDATE person_card_builds SET requested_at = requested_at - interval '25 hours',
         finished_at = finished_at - interval '25 hours' WHERE status = 'failed'`,
    );
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
  });

  it("counts records over the input cap as read, and refusals before work not as failures", async () => {
    const long = "ж".repeat(3_990);
    for (let index = 0; index < 80; index += 1) {
      await insertPersonCardRecord(fixture, {
        content: `${index} ${long}`,
        conversationId: fixture.groupA.conversationId,
        groupId: fixture.groupA.id,
        scope: "group",
        subjectLabel: "Юра (yura_k)",
      });
    }
    await personCardDispatchRepository.enqueueDue();
    const { sources } = await buildCard(fixture, [], true);
    expect(sources.records.length).toBeLessThan(80);
    expect(sources.readIds).toHaveLength(80);
    await ageBuilds(25);
    // Nothing new: the records over the cap were read too, so no paid daily rebuild.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);

    // Three refusals before any work (an exhausted balance) do not stop the person's builds.
    await addYuraRecords(fixture, 10);
    for (let refused = 0; refused < 3; refused += 1) {
      expect(await personCardDispatchRepository.enqueueDue()).toEqual([
        { key: yuraKey(fixture), reason: "new_records" },
      ]);
      const [claimed] = await personCardDispatchRepository.claim(2);
      await failPersonCardBuild({
        buildId: claimed!.id,
        errorCode: "AGENT_MODEL_BALANCE_EXHAUSTED",
        inputRecords: 90,
        leaseToken: claimed!.leaseToken,
        possiblyPaid: false,
      });
      await ageBuilds(25);
    }
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "new_records" },
    ]);
  });

  it("publishes past a turn's foreign-key lock on a record it read", async () => {
    const ids = await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    // A turn's profile block inserting a row that references a record holds KEY SHARE on it.
    const turn = await database().connect();
    try {
      await turn.query("BEGIN");
      await turn.query("SELECT 1 FROM memory_items_all WHERE id = $1 FOR KEY SHARE", [ids[0]]);
      const published = await Promise.race([
        buildCard(fixture).then(() => "published"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
      ]);
      expect(published).toBe("published");
    } finally {
      await turn.query("ROLLBACK");
      turn.release();
    }
  });

  it("counts a person's failed builds across all their areas", async () => {
    await seedPaidFailures(fixture, PERSON_CARD_MAX_FAILED_BUILDS_PER_WEEK);
    // The same person in another group is stopped too.
    for (let index = 0; index < 10; index += 1) {
      await insertPersonCardRecord(fixture, {
        content: `Юра в B ${index}`,
        conversationId: fixture.groupB.conversationId,
        groupId: fixture.groupB.id,
        scope: "group",
        subjectLabel: "Юра (yura_k)",
      });
    }
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
  });

  it("takes the person's confirmation of someone else's record as their own words", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(1);
    const reported = await insertPersonCardRecord(fixture, {
      content: "Лёша говорит: Юра водит E60",
      conversationId: fixture.groupA.conversationId,
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
      evidence: { authorParticipantId: fixture.participants.alexInA, kind: "reported" },
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await database().query(
      `INSERT INTO claim_evidence
         (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
          origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
          author_participant_id, author_label_snapshot, observed_at, evidence_snippet,
          timeline_sequence, source_message_id, source_snapshot, created_at)
       SELECT item.id, item.family_id, item.scope, item.scope_partition_key, 'reinforcement',
              'firsthand', item.origin_conversation_id, 'Группа A', item.group_id, $2, 'Юра',
              now(), 'да, вожу', 2, 2, '{}'::jsonb, now() - interval '3 minutes'
       FROM memory_items_all AS item WHERE item.id = $1`,
      [reported.id, fixture.participants.yuraInA],
    );
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "self_statement" },
    ]);
  });

  it("neither fails nor retries a build whose lease expired", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    const [claimed] = await personCardDispatchRepository.claim(2);
    await database().query(
      "UPDATE person_card_builds SET lease_expires_at = now() - interval '1 second'",
    );
    const lease = { buildId: claimed!.id, leaseToken: claimed!.leaseToken };
    expect(
      await failPersonCardBuild({
        ...lease,
        errorCode: "AGENT_X",
        inputRecords: 1,
        possiblyPaid: true,
      }),
    ).toBe(false);
    expect(
      await personCardDispatchRepository.releaseForRetry({
        ...lease,
        errorCode: "AGENT_X",
        possiblyPaid: true,
      }),
    ).toBe("lost");
    expect(await personCardDispatchRepository.stillLeased(lease.buildId, lease.leaseToken)).toBe(
      false,
    );
    expect(await personCardDispatchRepository.reclaimExpired()).toEqual({ failed: 0, retried: 1 });
  });

  it("returns a build with a dead lease, fails it after the last attempt, honours pauses", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await database().query(
      "INSERT INTO deploy_turn_pause (paused_until) VALUES (now() + interval '5 minutes')",
    );
    expect(await personCardDispatchRepository.claim(2)).toEqual([]);
    await database().query("DELETE FROM deploy_turn_pause");

    for (const attempt of [1, 2, 3]) {
      const [claimed] = await personCardDispatchRepository.claim(2);
      expect(claimed?.attempts).toBe(attempt);
      await database().query(
        "UPDATE person_card_builds SET lease_expires_at = now() - interval '1 second'",
      );
      expect(await personCardDispatchRepository.reclaimExpired()).toEqual(
        attempt < 3 ? { failed: 0, retried: 1 } : { failed: 1, retried: 0 },
      );
    }
    const build = await database().query(
      "SELECT status, error_code, possibly_paid FROM person_card_builds",
    );
    // A run that died with its lease may have died in a model call: it counts as paid.
    expect(build.rows).toEqual([
      { error_code: "AGENT_PERSON_CARD_BUILD_ABANDONED", possibly_paid: true, status: "failed" },
    ]);
  });

  it("counts a failed build when any of its attempts may have been paid", async () => {
    await addYuraRecords(fixture, 10);
    // One build: whether each attempt may have cost a model call; the last attempt ends it.
    const fail = async (attempts: readonly boolean[]) => {
      expect(await personCardDispatchRepository.enqueueDue()).toEqual([
        { key: yuraKey(fixture), reason: "new_records" },
      ]);
      for (const [index, possiblyPaid] of attempts.entries()) {
        const [claimed] = await personCardDispatchRepository.claim(2);
        const attempt = {
          buildId: claimed!.id,
          errorCode: "AGENT_X",
          leaseToken: claimed!.leaseToken,
          possiblyPaid,
        };
        if (index < attempts.length - 1 || claimed!.attempts >= 3) {
          await personCardDispatchRepository.releaseForRetry(attempt);
          await database().query(
            "UPDATE person_card_builds SET retry_after = now() - interval '1 second'",
          );
        } else {
          await failPersonCardBuild({ ...attempt, inputRecords: 10 });
        }
      }
      await ageBuilds(25);
    };
    // Refusals before any work on every attempt (a rate limit, an overloaded provider).
    for (let build = 0; build < 3; build += 1) await fail([false, false, false]);
    // A paid attempt counts, whatever refusal ended the build after it.
    await seedPaidFailures(fixture, PERSON_CARD_MAX_FAILED_BUILDS_PER_WEEK - 3);
    await fail([true, false]);
    await fail([true, false, false]);
    await fail([false, true]);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
  });

  it("keeps a build with an unclear model outcome and retries it after a pause", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    const [claimed] = await personCardDispatchRepository.claim(2);
    expect(
      await personCardDispatchRepository.releaseForRetry({
        buildId: claimed!.id,
        errorCode: "AGENT_PERSON_CARD_GENERATE_FAILED",
        leaseToken: claimed!.leaseToken,
        possiblyPaid: true,
      }),
    ).toBe("retry");
    expect(await personCardDispatchRepository.claim(2)).toEqual([]);
    await database().query(
      "UPDATE person_card_builds SET retry_after = now() - interval '1 second'",
    );
    const [again] = await personCardDispatchRepository.claim(2);
    expect(again).toMatchObject({ attempts: 2, id: claimed!.id });
    expect(await database().query("SELECT count(*)::int AS cards FROM person_cards")).toMatchObject(
      {
        rows: [{ cards: 0 }],
      },
    );
  });

  it("publishes nothing without the lease", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    const [claimed] = await personCardDispatchRepository.claim(2);
    const sources = await loadPersonCardSources(yuraKey(fixture));
    await expect(
      publishPersonCard({
        buildId: claimed!.id,
        characters: 7,
        cited: sources.records,
        cleanup: [],
        cleanupEnabled: true,
        inputRecords: 10,
        key: yuraKey(fixture),
        leaseToken: "00000000-0000-4000-8000-000000000000",
        readIds: sources.records.map((record) => record.id),
        sections: SECTIONS,
        sourcesAsOf: sources.sourcesAsOf,
        subjectLabel: sources.subjectLabel,
      }),
    ).rejects.toMatchObject({ code: "AGENT_PERSON_CARD_LEASE_LOST" });
    expect(await database().query("SELECT count(*)::int AS cards FROM person_cards")).toMatchObject(
      {
        rows: [{ cards: 0 }],
      },
    );
  });

  it("publishes nothing once the lease expired, even with the right token", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    const [claimed] = await personCardDispatchRepository.claim(2);
    await database().query(
      "UPDATE person_card_builds SET lease_expires_at = now() - interval '1 second'",
    );
    const sources = await loadPersonCardSources(yuraKey(fixture));
    await expect(
      publishPersonCard({
        buildId: claimed!.id,
        characters: 7,
        cited: sources.records,
        cleanup: [],
        cleanupEnabled: true,
        inputRecords: 10,
        key: yuraKey(fixture),
        leaseToken: claimed!.leaseToken,
        readIds: sources.records.map((record) => record.id),
        sections: SECTIONS,
        sourcesAsOf: sources.sourcesAsOf,
        subjectLabel: sources.subjectLabel,
      }),
    ).rejects.toMatchObject({ code: "AGENT_PERSON_CARD_LEASE_LOST" });
  });

  it("cleans past a journal row left open by a purged kept record, never in another area", async () => {
    const ids = await addYuraRecords(fixture, 10);
    const inB = {
      conversationId: fixture.groupB.conversationId,
      groupId: fixture.groupB.id,
      scope: "group" as const,
      subjectLabel: "Юра (yura_k)",
    };
    const otherGroup = await insertPersonCardRecord(fixture, { ...inB, content: "Юра в B" });
    const otherKept = await insertPersonCardRecord(fixture, { ...inB, content: "Юра в B, полнее" });
    // A journal row still open for a record that is active again (its kept record was purged).
    await database().query(
      `INSERT INTO person_card_builds (id, family_id, area, area_key, subject_telegram_user_id, reason,
         status, finished_at)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, 'group', $2, '9402', 'new_records',
               'succeeded', now() - interval '2 days')`,
      [fixture.familyId, fixture.groupA.id],
    );
    await database().query(
      `INSERT INTO person_card_cleanups (build_id, family_id, memory_item_id, reason, explanation,
         cleaned_updated_at)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, $2, 'duplicate', 'старое', now())`,
      [fixture.familyId, ids[0]],
    );
    await personCardDispatchRepository.enqueueDue();
    const sources = await loadPersonCardSources(yuraKey(fixture));
    const version = (id: string) => sources.records.find((record) => record.id === id)!.version;
    const [claimed] = await personCardDispatchRepository.claim(2);
    const otherVersion = await database().query<{ version: string }>(
      "SELECT updated_at::text AS version FROM memory_items_all WHERE id = $1",
      [otherGroup.id],
    );
    const result = await publishPersonCard({
      buildId: claimed!.id,
      characters: 7,
      cited: sources.records.filter((record) => record.id !== ids[0]),
      cleanup: [
        {
          explanation: "повтор",
          keptMemoryItemId: ids[1]!,
          memoryItemId: ids[0]!,
          readVersion: version(ids[0]!),
          reason: "duplicate",
        },
        {
          explanation: "чужая группа",
          keptMemoryItemId: otherKept.id,
          memoryItemId: otherGroup.id,
          readVersion: otherVersion.rows[0]!.version,
          reason: "duplicate",
        },
      ],
      cleanupEnabled: true,
      inputRecords: 10,
      key: yuraKey(fixture),
      leaseToken: claimed!.leaseToken,
      readIds: sources.records.map((record) => record.id),
      sections: SECTIONS,
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    expect(result).toMatchObject({ cleaned: 1, cleanupSkipped: 1 });
    const open = await database().query(
      "SELECT build_id FROM person_card_cleanups WHERE memory_item_id = $1 AND undone_at IS NULL",
      [ids[0]],
    );
    expect(open.rows).toEqual([{ build_id: claimed!.id }]);
  });

  it("cleans repeats only where it is safe and only when switched on", async () => {
    const ids = await addYuraRecords(fixture, 10);
    await database().query(
      "UPDATE memory_items_all SET confirmation = 'user_confirmed' WHERE id = $1",
      [ids[2]],
    );
    await personCardDispatchRepository.enqueueDue();
    const sources = await loadPersonCardSources(yuraKey(fixture));
    const byId = new Map(sources.records.map((record) => [record.id, record]));
    const entry = (memoryItemId: string, keep: string) => ({
      explanation: "повтор",
      keptMemoryItemId: keep,
      memoryItemId,
      readVersion: byId.get(memoryItemId)!.version,
      reason: "duplicate" as const,
    });
    // Changed after the build read it: skipped.
    await database().query(
      "UPDATE memory_items_all SET updated_at = updated_at + interval '1 second' WHERE id = $1",
      [ids[1]],
    );
    const [claimed] = await personCardDispatchRepository.claim(2);
    const result = await publishPersonCard({
      buildId: claimed!.id,
      characters: 7,
      cited: sources.records.filter((record) => record.id !== ids[0]),
      cleanup: [entry(ids[0]!, ids[3]!), entry(ids[1]!, ids[3]!), entry(ids[2]!, ids[3]!)],
      cleanupEnabled: true,
      inputRecords: 10,
      key: yuraKey(fixture),
      leaseToken: claimed!.leaseToken,
      readIds: sources.records.map((record) => record.id),
      sections: SECTIONS,
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    expect(result).toMatchObject({ cleaned: 1, cleanupSkipped: 2 });
    const statuses = await database().query<{
      claim_status: string;
      duplicate_of: string | null;
      id: string;
    }>("SELECT id, claim_status, duplicate_of FROM memory_items_all WHERE id = ANY($1::uuid[])", [
      ids.slice(0, 3),
    ]);
    expect(
      new Map(statuses.rows.map((row) => [row.id, [row.claim_status, row.duplicate_of]])),
    ).toEqual(
      new Map([
        [ids[0], ["duplicate", ids[3]]],
        [ids[1], ["active", null]],
        [ids[2], ["active", null]],
      ]),
    );
    const log = await database().query(
      "SELECT reason, explanation, build_id FROM person_card_cleanups",
    );
    expect(log.rows).toEqual([
      { build_id: claimed!.id, explanation: "повтор", reason: "duplicate" },
    ]);
  });
});
