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
 * - The person's own words are marked; protected records are not cleanable.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import { MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE } from "../memory-config.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import {
  ALEX_TELEGRAM_ID,
  createPersonCardFixture,
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

  it("ties group records to a person by subject ids and an unambiguous username only", async () => {
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
      subjectLabel: "Юрий (@Yura_K)",
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
    // The projected record belongs to the group: the personal card never cleans it.
    expect(personal.records.find((record) => record.content === "Илья в группе A")!.cleanable).toBe(
      false,
    );
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
    expect(
      sources.episodes.map((episode) => [episode.content, episode.link, episode.cleanable]),
    ).toEqual([["Спор о турбинах: Юра против", "participation", false]]);
  });

  it("marks the person's own words and keeps confirmed records out of the cleanup", async () => {
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
    expect(byContent.get("Сам о себе")).toMatchObject({ cleanable: true, selfStatement: true });
    expect(byContent.get("Лёша о Юре")).toMatchObject({ cleanable: true, selfStatement: false });
    expect(byContent.get("Подтвердил")).toMatchObject({ cleanable: false });
  });
});
