/**
 * Which records a person card reads, per area.
 *
 * Constructs covered:
 * - Identity: subject ids, an unambiguous «Имя (username)» label; ambiguous, username-less and
 *   participant-less labels stay out.
 * - Areas: a group card reads only its group; the family card only family memory; the personal
 *   card personal, family and, once the owner enabled it and the group saw the notice, the
 *   external projection.
 * - Filters: sensitive, legacy and conflicted records stay out; discussion summaries come in as
 *   episodes only for participants.
 * - The person's own words are marked.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE } from "../memory-config.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import {
  ALEX_TELEGRAM_ID,
  createPersonCardFixture,
  insertPersonCardParticipant,
  insertPersonCardRecord,
  OWNER_TELEGRAM_ID,
  resetPersonCardTables,
  YURA_TELEGRAM_ID,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

const describeWithDatabase =
  process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

function groupKey(fixture: PersonCardFixture, groupId: string, telegramUserId: string) {
  return {
    area: "group" as const,
    areaKey: groupId,
    familyId: fixture.familyId,
    subjectTelegramUserId: telegramUserId,
  };
}

async function contents(key: Parameters<typeof loadPersonCardSources>[0]): Promise<string[]> {
  const sources = await loadPersonCardSources(key);
  return [...sources.records, ...sources.episodes].map((source) => source.content).sort();
}

describeWithDatabase("person card sources", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  // Fable review, 23 November 2026: the username in brackets alone tied «Вася (yura_k)», the name
  // of a participant without a username, to Юра's card. A label ties only when it is the person's
  // label now, name and username, and no one else in the area has that same label.
  it("ties group records to a person by subject ids and by their whole label only", async () => {
    const inA = { conversationId: fixture.groupA.conversationId, groupId: fixture.groupA.id };
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра: метка",
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра: метка с собакой",
      scope: "group",
      subjectLabel: "юра (@Yura_K)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра под прежним именем",
      scope: "group",
      subjectLabel: "Юрий (yura_k)",
    });
    // A participant without a username whose display name carries someone else's username.
    await insertPersonCardParticipant({
      conversationId: fixture.groupA.conversationId,
      displayName: "Вася (yura_k)",
      telegramUserId: "9416",
      username: null,
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Вася в скобках",
      scope: "group",
      subjectLabel: "Вася (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра: субъект",
      scope: "group",
      subjectParticipantId: fixture.participants.yuraInA,
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра без username",
      scope: "group",
      subjectLabel: "Юра",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Незнакомец",
      scope: "group",
      subjectLabel: "Петя (petya_p)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Близнец",
      scope: "group",
      subjectLabel: "Близнец (twin_name)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Лёша",
      scope: "group",
      subjectLabel: "Лёша (alex_x)",
    });
    await insertPersonCardRecord(fixture, {
      content: "Юра в группе B",
      conversationId: fixture.groupB.conversationId,
      groupId: fixture.groupB.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });

    const yuraInA = await loadPersonCardSources(
      groupKey(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
    );
    const tied = yuraInA.records
      .map((record) => [record.content, record.link])
      .sort((a, b) => a[0]!.localeCompare(b[0]!, "ru"));
    expect(tied).toEqual([
      ["Юра: метка", "label"],
      ["Юра: метка с собакой", "label"],
      ["Юра: субъект", "subject"],
    ]);
    expect(yuraInA.subjectLabel).toBe("Юра (yura_k)");
    expect(await contents(groupKey(fixture, fixture.groupA.id, ALEX_TELEGRAM_ID))).toEqual([
      "Лёша",
    ]);
    expect(await contents(groupKey(fixture, fixture.groupA.id, "9405"))).toEqual([]);
    expect(await contents(groupKey(fixture, fixture.groupB.id, YURA_TELEGRAM_ID))).toEqual([
      "Юра в группе B",
    ]);

    // Someone without a username named exactly as Юра's label: the label names no one alone.
    await insertPersonCardParticipant({
      conversationId: fixture.groupA.conversationId,
      displayName: "Юра (yura_k)",
      telegramUserId: "9417",
      username: null,
    });
    expect(await contents(groupKey(fixture, fixture.groupA.id, YURA_TELEGRAM_ID))).toEqual([
      "Юра: субъект",
    ]);
  });

  // Review of the fixes, 23 November 2026: a participant's label is «имя (username)» whenever there
  // is a username, so someone named as their username is found too (228 records of 11 people on
  // production were not); spaces of any kind at the edges and an «@» only in the closing brackets
  // do not count, for participants and records alike.
  it("compares the labels of every kind of participant with records the same way", async () => {
    const inA = { conversationId: fixture.groupA.conversationId, groupId: fixture.groupA.id };
    const participant = (telegramUserId: string, displayName: string, username: string | null) =>
      insertPersonCardParticipant({
        conversationId: fixture.groupA.conversationId,
        displayName,
        telegramUserId,
        username,
      });
    await participant("9418", "Pukh_K", "pukh_k");
    await participant("9419", "Ира ", "ira_k");
    await participant("9420", "Саша (@club)", "alex1");
    await participant("9421", "Саша (club) (alex1)", null);
    await participant("9422", "Вася (vasya_v)", null);
    await participant("9423", "Пётр", "petya_p");
    await participant("9424", "Пётр (@petya_p)", null);
    // A name ending in its own «(@username)»: the model sees «Оля (@olya_o) (olya_o)» and writes so
    // (review of the fixes: reading the name's «@» away left this record tied to no one).
    await participant("9425", "Оля (@olya_o)", "olya_o");
    await participant("9426", "Оля (olya_o)", null);
    // A name already ending in the username: the label is the name itself.
    await participant("9427", "Миша (misha_m)", "misha_m");
    const record = (content: string, subjectLabel: string) =>
      insertPersonCardRecord(fixture, { ...inA, content, scope: "group", subjectLabel });
    await record("Пух", "Pukh_K (pukh_k)");
    await record("Ира", " Ира (ira_k)　");
    await record("Саша из клуба", "Саша (@club) (alex1)");
    await record("Другой Саша", "Саша (club) (alex1)");
    await record("Вася", "Вася (@vasya_v)");
    await record("Пётр", "Пётр (petya_p)");
    await record("Оля", "Оля (@olya_o) (olya_o)");
    await record("Миша", "Миша (misha_m)");

    const of = (telegramUserId: string) =>
      contents(groupKey(fixture, fixture.groupA.id, telegramUserId));
    expect(await of("9418")).toEqual(["Пух"]);
    expect(await of("9419")).toEqual(["Ира"]);
    expect(await of("9420")).toEqual(["Саша из клуба"]);
    expect(await of("9421")).toEqual(["Другой Саша"]);
    expect(await of("9422")).toEqual(["Вася"]);
    // «Пётр (@petya_p)» without a username holds Пётр's label too: it names no one.
    expect(await of("9423")).toEqual([]);
    expect(await of("9424")).toEqual([]);
    expect(await of("9425")).toEqual(["Оля"]);
    expect(await of("9426")).toEqual([]);
    expect(await of("9427")).toEqual(["Миша"]);
  });

  it("keeps each card inside its area and projects groups into the personal card only by policy", async () => {
    await insertPersonCardRecord(fixture, {
      content: "Личное о себе",
      conversationId: fixture.personalConversationId,
      ownerUserId: fixture.ownerId,
      scope: "personal",
      subjectUserId: fixture.ownerId,
    });
    await insertPersonCardRecord(fixture, {
      content: "Семейное об Илье",
      conversationId: fixture.familyConversationId,
      scope: "family",
      subjectLabel: "Илья (ilya_k)",
    });
    await insertPersonCardRecord(fixture, {
      content: "Илья в группе A",
      conversationId: fixture.groupA.conversationId,
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "reported" },
      groupId: fixture.groupA.id,
      scope: "group",
      subjectParticipantId: fixture.participants.ownerInA,
    });
    const personalKey = {
      area: "personal" as const,
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    };
    const familyKey = { ...personalKey, area: "family" as const, areaKey: fixture.familyId };

    expect(await contents(groupKey(fixture, fixture.groupA.id, OWNER_TELEGRAM_ID))).toEqual([
      "Илья в группе A",
    ]);
    expect(await contents(familyKey)).toEqual(["Семейное об Илье"]);
    expect(await contents(personalKey)).toEqual(["Личное о себе", "Семейное об Илье"]);

    const policy = (await profileProjectionPolicyRepository.list(fixture.ownerAuth)).find(
      (entry) => entry.label === "Группа A",
    )!;
    await profileProjectionPolicyRepository.update(fixture.ownerAuth, {
      enabled: true,
      groupRef: policy.groupRef,
      operationKey: "enable-group-a",
    });
    expect(await contents(personalKey)).toEqual(["Личное о себе", "Семейное об Илье"]);
    const notice = await profileProjectionPolicyRepository.claimPendingGroupNotice(
      fixture.groupA.id,
    );
    await profileProjectionPolicyRepository.markGroupNoticePresented({
      deliveryToken: notice!.deliveryToken,
      noticeRef: notice!.noticeRef,
    });
    const personal = await loadPersonCardSources(personalKey);
    expect(personal.records.map((record) => record.content).sort()).toEqual([
      "Илья в группе A",
      "Личное о себе",
      "Семейное об Илье",
    ]);
  });

  it("filters like the profile block and takes discussions only from their participants", async () => {
    const inA = {
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group" as const,
    };
    const label = "Юра (yura_k)";
    await insertPersonCardRecord(fixture, { ...inA, content: "Обычная", subjectLabel: label });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Чувствительная",
      sensitivity: "sensitive",
      subjectLabel: label,
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Без доказательства",
      provenance: "legacy_unresolved",
      subjectLabel: label,
    });
    const first = await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Конфликт 1",
      subjectLabel: label,
    });
    const second = await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Конфликт 2",
      subjectLabel: label,
    });
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, 'group', $4,
               'deterministic_guard')`,
      [first.id, second.id, fixture.familyId, fixture.groupA.id],
    );
    await insertPersonCardRecord(fixture, {
      ...inA,
      attribute: MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE,
      content: "Спор о турбинах: Юра против",
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" },
      kind: "episode",
      occurredAt: new Date("2026-11-10T10:00:00Z"),
      subjectLabel: "турбины",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      attribute: MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE,
      content: "Спор без Юры",
      evidence: { authorParticipantId: fixture.participants.alexInA, kind: "firsthand" },
      kind: "episode",
      subjectLabel: "погода",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      attribute: "поездка",
      content: "Эпизод не итог",
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" },
      kind: "episode",
    });

    const sources = await loadPersonCardSources(
      groupKey(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
    );
    expect(sources.records.map((record) => record.content)).toEqual(["Обычная"]);
    expect(sources.episodes.map((episode) => [episode.content, episode.link])).toEqual([
      ["Спор о турбинах: Юра против", "participation"],
    ]);
  });

  // The person's own words told to Mia rank above the silent review's reading of them (owner,
  // 23 November 2026); evidence from before the mark ranks as told, as it did.
  it("tells the person's words told in their turn from those the review took down", async () => {
    const own = (content: string, recordedBy?: "review" | "turn") =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.groupA.conversationId,
        evidence: {
          authorParticipantId: fixture.participants.yuraInA,
          kind: "firsthand",
          ...(recordedBy === undefined ? {} : { recordedBy }),
        },
        groupId: fixture.groupA.id,
        scope: "group",
        subjectLabel: "Юра (yura_k)",
      });
    await own("Сказал Мии", "turn");
    await own("Записала проверка", "review");
    await own("До пометки");
    const sources = await loadPersonCardSources(
      groupKey(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
    );
    const byContent = new Map(sources.records.map((record) => [record.content, record]));
    expect(byContent.get("Сказал Мии")).toMatchObject({ selfDirect: true, selfStatement: true });
    expect(byContent.get("Записала проверка")).toMatchObject({
      selfDirect: false,
      selfStatement: true,
    });
    expect(byContent.get("До пометки")).toMatchObject({ selfDirect: true, selfStatement: true });
  });

  // The plan's mixed case: one record, several pieces of evidence; the strongest of the person's
  // own sets its rank, whatever the primary one is.
  it("ranks one record by the strongest of the person's own evidence on it", async () => {
    const record = (
      content: string,
      author: string,
      kind: "firsthand" | "reported",
      recordedBy: "review" | "turn",
    ) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.groupA.conversationId,
        evidence: { authorParticipantId: author, kind, recordedBy },
        groupId: fixture.groupA.id,
        scope: "group",
        subjectLabel: "Юра (yura_k)",
      });
    const confirm = (id: string, author: string, recordedBy: "review" | "turn") =>
      database().query(
        `INSERT INTO claim_evidence
           (claim_id, family_id, scope, scope_partition_key, evidence_role, evidence_kind,
            origin_conversation_id, origin_conversation_label_snapshot, origin_telegram_group_id,
            author_participant_id, author_label_snapshot, observed_at, evidence_snippet,
            timeline_sequence, source_message_id, source_snapshot, recorded_by)
         SELECT evidence.claim_id, evidence.family_id, evidence.scope, evidence.scope_partition_key,
                'reinforcement', 'firsthand', evidence.origin_conversation_id, 'Источник',
                evidence.origin_telegram_group_id, $2, 'Юра', now(), 'подтвердил', 2, 2,
                '{}'::jsonb, $3
         FROM claim_evidence AS evidence WHERE evidence.claim_id = $1`,
        [id, author, recordedBy],
      );
    const { yuraInA, alexInA } = fixture.participants;
    const reviewThenTurn = await record("Проверка, потом сам", yuraInA, "firsthand", "review");
    await confirm(reviewThenTurn.id, yuraInA, "turn");
    const otherThenReview = await record("Лёша, потом проверка", alexInA, "reported", "turn");
    await confirm(otherThenReview.id, yuraInA, "review");
    // Лёша's own words in his turn about Юра's label are firsthand too, but not Юра's.
    const alexTurn = await record("Лёша в своём ходе", alexInA, "firsthand", "turn");
    await confirm(alexTurn.id, yuraInA, "review");
    const sources = await loadPersonCardSources(
      groupKey(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
    );
    const byContent = new Map(sources.records.map((source) => [source.content, source]));
    expect(byContent.get("Проверка, потом сам")).toMatchObject({
      selfDirect: true,
      selfStatement: true,
    });
    expect(byContent.get("Лёша, потом проверка")).toMatchObject({
      selfDirect: false,
      selfStatement: true,
    });
    expect(byContent.get("Лёша в своём ходе")).toMatchObject({
      selfDirect: false,
      selfStatement: true,
    });
  });

  it("marks the person's own words", async () => {
    const inA = {
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group" as const,
    };
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Сам о себе",
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "firsthand" },
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Лёша о Юре",
      evidence: { authorParticipantId: fixture.participants.alexInA, kind: "reported" },
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      confirmation: "user_confirmed",
      content: "Подтвердил",
      subjectLabel: "Юра (yura_k)",
    });
    const sources = await loadPersonCardSources(
      groupKey(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
    );
    const byContent = new Map(sources.records.map((record) => [record.content, record]));
    expect(byContent.get("Сам о себе")).toMatchObject({ selfStatement: true });
    expect(byContent.get("Лёша о Юре")).toMatchObject({ selfStatement: false });
    expect(byContent.get("Подтвердил")).toMatchObject({ selfStatement: false });
  });
});
