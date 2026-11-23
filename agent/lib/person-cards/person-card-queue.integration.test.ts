/**
 * Person card queue and publishing against PostgreSQL.
 *
 * Constructs covered:
 * - Due: 9 new records no, 10 yes, a second build within a day no, whatever the reason: the
 *   person's own words, written as the silent review writes them, only lift the ten-records rule
 *   (after a quiet window), and a failed build counts toward the day; a deleted cited record
 *   rebuilds once a day; the day counts from the end of the last build, not from its request.
 * - Leases: an expired lease returns the build to pending, spent attempts fail it; a retry waits
 *   for its pause; a deploy pause claims nothing.
 * - New means unread: records the card read never count again, however recent; the person
 *   confirming someone else's record about them counts as their own words.
 * - Publishing: versions and sources; a lost or expired lease publishes nothing, fails nothing and
 *   retries nothing.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
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
async function buildCard(fixture: PersonCardFixture, readAllLoaded = false) {
  const [claimed] = await personCardDispatchRepository.claim(2);
  const sources = await loadPersonCardSources(yuraKey(fixture));
  const result = await publishPersonCard({
    buildId: claimed!.id,
    characters: 7,
    cited: sources.records,
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

  // Fable review, 23 November 2026: the person's own words rebuilt the card at once, and the
  // silent review writes them for every message of an active person (72 of 147 builds a day on
  // production, up to 7 for one person). They now only lift the ten-records rule; one build a day.
  it("lifts the ten-records rule on the person's own words, once a day", async () => {
    const [first] = await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(1);
    const own = (content: string) => ({
      content,
      conversationId: fixture.groupA.conversationId,
      createdAt: new Date(Date.now() - 3 * 60_000),
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" as const },
      groupId: fixture.groupA.id,
      scope: "group" as const,
      subjectLabel: "Юра (yura_k)",
    });
    // As the silent review writes them: one record of his own words after another.
    for (let index = 0; index < 6; index += 1) {
      await insertPersonCardRecord(fixture, own(`Я теперь живу в Казани ${index}`));
      expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    }
    await ageBuilds(24);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "self_statement" },
    ]);
    await buildCard(fixture);
    // A day on, not the card's snapshot: the words are older than it.
    await database().query(
      `UPDATE person_card_builds SET requested_at = requested_at - interval '25 hours',
         finished_at = finished_at - interval '25 hours'`,
    );
    // The same words do not rebuild twice.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);

    // A deleted source takes only the items citing it out of the turn; the rebuild is daily.
    await database().query("UPDATE memory_items_all SET deleted_at = now() WHERE id = $1", [first]);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "invalidated" },
    ]);
  });

  it("counts a failed build toward the day", async () => {
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(25);
    await addYuraRecords(fixture, 10);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yuraKey(fixture), reason: "new_records" },
    ]);
    const [claimed] = await personCardDispatchRepository.claim(2);
    await failPersonCardBuild({
      buildId: claimed!.id,
      errorCode: "AGENT_PERSON_CARD_RESPONSE_INVALID",
      inputRecords: 20,
      leaseToken: claimed!.leaseToken,
    });
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    // Seven hours on (a failed build used to wait six), the person's own words do not build again
    // within the day either.
    await ageBuilds(7);
    await insertPersonCardRecord(fixture, {
      content: "Я теперь живу в Казани",
      conversationId: fixture.groupA.conversationId,
      createdAt: new Date(Date.now() - 3 * 60_000),
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" },
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await ageBuilds(18);
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

  it("counts only unread records as new", async () => {
    // Ten records the build reads seconds before its snapshot are known, not new, a day later.
    await addYuraRecords(fixture, 10);
    await personCardDispatchRepository.enqueueDue();
    await buildCard(fixture);
    await ageBuilds(25);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
  });

  it("counts records over the input cap as read", async () => {
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
    const { sources } = await buildCard(fixture, true);
    expect(sources.records.length).toBeLessThan(80);
    expect(sources.readIds).toHaveLength(80);
    await ageBuilds(25);
    // Nothing new: the records over the cap were read too, so no paid daily rebuild.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
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
    await ageBuilds(24);
    // Someone else's words about him are no reason before ten records gather.
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
      }),
    ).toBe(false);
    expect(
      await personCardDispatchRepository.releaseForRetry({
        ...lease,
        errorCode: "AGENT_X",
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
    const build = await database().query("SELECT status, error_code FROM person_card_builds");
    // Three attempts are one build: the third ends it, and the day counts from there.
    expect(build.rows).toEqual([
      { error_code: "AGENT_PERSON_CARD_BUILD_ABANDONED", status: "failed" },
    ]);
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
    // Up to three attempts in all: the third unclear outcome fails the build for the day.
    const release = (build: { id: string; leaseToken: string }, errorCode: string) =>
      personCardDispatchRepository.releaseForRetry({
        buildId: build.id,
        errorCode,
        leaseToken: build.leaseToken,
      });
    expect(await release(again!, "AGENT_PERSON_CARD_GENERATE_TIMEOUT")).toBe("retry");
    await database().query(
      "UPDATE person_card_builds SET retry_after = now() - interval '1 second'",
    );
    const [third] = await personCardDispatchRepository.claim(2);
    expect(third).toMatchObject({ attempts: 3, id: claimed!.id });
    expect(await release(third!, "AGENT_PERSON_CARD_PROVIDER_FAILED")).toBe("failed");
    expect(
      (await database().query("SELECT status, error_code FROM person_card_builds")).rows,
    ).toEqual([{ error_code: "AGENT_PERSON_CARD_PROVIDER_FAILED", status: "failed" }]);
    expect(await personCardDispatchRepository.claim(2)).toEqual([]);
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
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
});
