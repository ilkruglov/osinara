/**
 * Person cards in a turn, against PostgreSQL.
 *
 * Constructs covered:
 * - A group chat shows that group's cards only; a private chat only its owner's personal card.
 * - A card whose cited record was deleted leaves the turn until it is rebuilt.
 * - So does a card whose cited record was edited (made sensitive), whose label no longer names
 *   the person, or whose projected group record lost the live projection; the queue rebuilds it.
 * - A subject record that is not profile-eligible never reaches a card.
 * - A card comes with the label-only records about the person it did not read, from its own area
 *   only; the person replied to through the journal comes right after the author, the people the
 *   turn's retrieved records are about last.
 * - Only the items citing a record that no longer stands leave; a record that became visible
 *   after the build (a conflict resolved) is unread and shows in the profile block.
 * - The profile block keeps for a carded person only records the card did not read and records
 *   which cards the turn carried; a person retrieval named only by a label gets the subject
 *   records the card did not read there too.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "../database.js";
import type { MemoryAuthorization } from "../memory-context.js";
import { profileProjectionPolicyRepository } from "../profile-projection-policy-repository.js";
import { profileViewRepository } from "../profile-view-repository.js";
import { personCardDispatchRepository } from "./person-card-dispatch-repository.js";
import type { PersonCardKey } from "./person-card-links.js";
import { publishPersonCard, retirePersonCard } from "./person-card-publish-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import { loadPersonCardsForTurn } from "./person-card-view-repository.js";
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

async function publishFor(key: PersonCardKey): Promise<void> {
  await database().query(
    `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
     VALUES ($1, $2, $3, $4, 'new_records')`,
    [key.familyId, key.area, key.areaKey, key.subjectTelegramUserId],
  );
  const [claimed] = await personCardDispatchRepository.claim(4);
  const sources = await loadPersonCardSources(key);
  await publishPersonCard({
    buildId: claimed!.id,
    characters: 20,
    cited: sources.records,
    cleanup: [],
    cleanupEnabled: true,
    inputRecords: sources.records.length,
    key,
    leaseToken: claimed!.leaseToken,
    readIds: sources.records.map((record) => record.id),
    sections: {
      communication: [],
      facts: [
        {
          scope: "всегда",
          sourceRefs: sources.records.map((record) => record.memoryRef),
          text: `Карточка ${key.area}`,
        },
      ],
      interests: [],
      positions: [],
    },
    sourcesAsOf: sources.sourcesAsOf,
    subjectLabel: sources.subjectLabel,
  });
}

function groupAuth(
  fixture: PersonCardFixture,
  groupId: string,
  telegramUserId: string,
): MemoryAuthorization {
  return {
    familyId: fixture.familyId,
    groupId,
    role: "external",
    scopes: ["group"],
    telegramActorId: telegramUserId,
    telegramActorKind: "telegram_user",
    telegramUserId,
    userId: null,
  };
}

describeWithDatabase("person cards in a turn", () => {
  let fixture: PersonCardFixture;

  beforeEach(async () => {
    await resetPersonCardTables();
    fixture = await createPersonCardFixture();
  });

  afterAll(closeDatabase);

  it("shows only the chat's own area and drops a card whose source was deleted", async () => {
    const inA = await insertPersonCardRecord(fixture, {
      content: "Юра в A",
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      content: "Юра в B",
      conversationId: fixture.groupB.conversationId,
      groupId: fixture.groupB.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      content: "Личное",
      conversationId: fixture.personalConversationId,
      ownerUserId: fixture.ownerId,
      scope: "personal",
      subjectUserId: fixture.ownerId,
    });
    const yura = (groupId: string): PersonCardKey => ({
      area: "group",
      areaKey: groupId,
      familyId: fixture.familyId,
      subjectTelegramUserId: YURA_TELEGRAM_ID,
    });
    await publishFor(yura(fixture.groupA.id));
    await publishFor(yura(fixture.groupB.id));
    await publishFor({
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    });

    const inGroupA = await loadPersonCardsForTurn(
      groupAuth(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
      {
        conversationId: fixture.groupA.conversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [YURA_TELEGRAM_ID, OWNER_TELEGRAM_ID],
      },
    );
    expect(
      inGroupA.map((card) => [card.subjectTelegramUserId, card.sections.facts[0]!.text]),
    ).toEqual([[YURA_TELEGRAM_ID, "Карточка group"]]);
    // A chat that is not this group's cannot read its cards.
    await expect(
      loadPersonCardsForTurn(groupAuth(fixture, fixture.groupB.id, YURA_TELEGRAM_ID), {
        conversationId: fixture.groupA.conversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [YURA_TELEGRAM_ID],
      }),
    ).rejects.toMatchObject({ code: "AGENT_PROFILE_VIEW_SCOPE_DENIED" });

    const inPrivate = await loadPersonCardsForTurn(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      replyTimelineSequence: null,
      retrievalClaimIds: [],
      telegramUserIds: [OWNER_TELEGRAM_ID, YURA_TELEGRAM_ID],
    });
    expect(inPrivate.map((card) => card.sections.facts[0]!.text)).toEqual(["Карточка personal"]);

    await database().query("UPDATE memory_items_all SET deleted_at = now() WHERE id = $1", [
      inA.id,
    ]);
    expect(
      await loadPersonCardsForTurn(groupAuth(fixture, fixture.groupA.id, YURA_TELEGRAM_ID), {
        conversationId: fixture.groupA.conversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [YURA_TELEGRAM_ID],
      }),
    ).toEqual([]);
  });

  it("keeps in the profile block only what the card does not know yet", async () => {
    const personal = (content: string, createdAt?: Date) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.personalConversationId,
        ...(createdAt === undefined ? {} : { createdAt }),
        evidence: { authorUserId: fixture.ownerId, kind: "firsthand" },
        ownerUserId: fixture.ownerId,
        scope: "personal",
        subjectUserId: fixture.ownerId,
      });
    // Older than the minute of margin the card keeps before its snapshot.
    await personal("Старое о себе", new Date(Date.now() - 10 * 60_000));
    await database().query(
      `INSERT INTO profile_subjects
         (conversation_id, family_id, subject_user_id, display_label_snapshot, last_verified_at)
       VALUES ($1, $2, $3, 'Илья', now())`,
      [fixture.personalConversationId, fixture.familyId, fixture.ownerId],
    );
    await publishFor({
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    });
    await personal("Новое о себе");
    const [card] = await loadPersonCardsForTurn(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      replyTimelineSequence: null,
      retrievalClaimIds: [],
      telegramUserIds: [OWNER_TELEGRAM_ID],
    });
    const view = await profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: OWNER_TELEGRAM_ID,
      explicitMentionTelegramUserIds: [],
      now: new Date(),
      personCardIds: [card!.cardId],
      provenance: { sessionId: "session-1", turnId: "turn-1" },
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    expect(
      view.subjects.flatMap((subject) => subject.claims.map((claim) => claim.content)),
    ).toEqual(["Новое о себе"]);
    // The cards took the block's budget: nothing is left for records.
    const squeezed = await profileViewRepository.create(fixture.ownerAuth, {
      conversationId: fixture.personalConversationId,
      currentTelegramUserId: OWNER_TELEGRAM_ID,
      explicitMentionTelegramUserIds: [],
      maxCharacters: 10,
      now: new Date(),
      personCardIds: [card!.cardId],
      provenance: { sessionId: "session-1", turnId: "turn-2" },
      replyTelegramUserId: null,
      retrievalClaimIds: [],
    });
    expect(squeezed.subjects).toEqual([]);
    const stored = await database().query(
      "SELECT person_card_ids FROM profile_views WHERE profile_view_ref = $1",
      [view.profileViewRef],
    );
    expect(stored.rows).toEqual([{ person_card_ids: [card!.cardId] }]);
  });

  it("takes the items citing a changed record out, and queues the daily rebuild", async () => {
    await insertPersonCardRecord(fixture, {
      content: "Юра любит турбины",
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    const groupRecord = await insertPersonCardRecord(fixture, {
      content: "Юра ездит на E60",
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      content: "Не профильная запись",
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group",
      subjectParticipantId: fixture.participants.yuraInA,
    });
    await database().query(
      "UPDATE memory_items_all SET profile_eligible = false WHERE content = 'Не профильная запись'",
    );
    const yura: PersonCardKey = {
      area: "group",
      areaKey: fixture.groupA.id,
      familyId: fixture.familyId,
      subjectTelegramUserId: YURA_TELEGRAM_ID,
    };
    expect(
      (await loadPersonCardSources(yura)).records.map((record) => record.content).sort(),
    ).toEqual(["Юра ездит на E60", "Юра любит турбины"]);
    await publishFor(yura);
    const shown = () =>
      loadPersonCardsForTurn(groupAuth(fixture, fixture.groupA.id, YURA_TELEGRAM_ID), {
        conversationId: fixture.groupA.conversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [YURA_TELEGRAM_ID],
      });
    expect(await shown()).toHaveLength(1);

    // The username now belongs to two people: the label no longer names Юра alone.
    await database().query(
      "UPDATE conversation_participants SET username_snapshot = 'yura_k' WHERE telegram_user_id = '9403'",
    );
    expect(await shown()).toEqual([]);
    await database().query(
      "UPDATE conversation_participants SET username_snapshot = 'alex_x' WHERE telegram_user_id = '9403'",
    );
    expect(await shown()).toHaveLength(1);

    // An edit to sensitive makes a new version and leaves the old one superseded but normal.
    const sensitive = await insertPersonCardRecord(fixture, {
      content: "Юра ездит на E60 (чувствительно)",
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group",
      sensitivity: "sensitive",
      subjectLabel: "Юра (yura_k)",
    });
    await database().query(
      "UPDATE memory_items_all SET claim_status = 'superseded', superseded_by = $2 WHERE id = $1",
      [groupRecord.id, sensitive.id],
    );
    expect(await shown()).toEqual([]);
    // The rebuild waits for the day; meanwhile the item citing it stays out.
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([]);
    await database().query(
      "UPDATE person_card_builds SET requested_at = now() - interval '25 hours', finished_at = now() - interval '25 hours'",
    );
    expect(await personCardDispatchRepository.enqueueDue()).toEqual([
      { key: yura, reason: "invalidated" },
    ]);
    // Once no cited record stands and no build is open, the card itself goes.
    await database().query(
      "UPDATE memory_items_all SET deleted_at = now() WHERE content = 'Юра любит турбины'",
    );
    expect(await personCardDispatchRepository.purgeOrphans()).toBe(0);
    await database().query(
      "UPDATE person_card_builds SET status = 'failed', finished_at = now() WHERE status = 'pending'",
    );
    // Within the day of the last build the card waits for its rebuild.
    expect(await personCardDispatchRepository.purgeOrphans()).toBe(0);
    await database().query(
      `UPDATE person_card_builds SET requested_at = requested_at - interval '25 hours',
         finished_at = finished_at - interval '25 hours'`,
    );
    expect(await personCardDispatchRepository.purgeOrphans()).toBe(1);
  });

  it("takes a personal card with a projected group record out when the projection is off", async () => {
    await insertPersonCardRecord(fixture, {
      content: "Илья в группе A",
      conversationId: fixture.groupA.conversationId,
      evidence: { authorParticipantId: fixture.participants.yuraInA, kind: "reported" },
      groupId: fixture.groupA.id,
      scope: "group",
      subjectParticipantId: fixture.participants.ownerInA,
    });
    const policy = (await profileProjectionPolicyRepository.list(fixture.ownerAuth)).find(
      (entry) => entry.label === "Группа A",
    )!;
    await profileProjectionPolicyRepository.update(fixture.ownerAuth, {
      enabled: true,
      groupRef: policy.groupRef,
      operationKey: "enable-group-a",
    });
    const notice = await profileProjectionPolicyRepository.claimPendingGroupNotice(
      fixture.groupA.id,
    );
    await profileProjectionPolicyRepository.markGroupNoticePresented({
      deliveryToken: notice!.deliveryToken,
      noticeRef: notice!.noticeRef,
    });
    await publishFor({
      area: "personal",
      areaKey: fixture.ownerId,
      familyId: fixture.familyId,
      subjectTelegramUserId: OWNER_TELEGRAM_ID,
    });
    const shown = () =>
      loadPersonCardsForTurn(fixture.ownerAuth, {
        conversationId: fixture.personalConversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [OWNER_TELEGRAM_ID],
      });
    expect(await shown()).toHaveLength(1);
    await profileProjectionPolicyRepository.update(fixture.ownerAuth, {
      enabled: false,
      groupRef: policy.groupRef,
      operationKey: "disable-group-a",
    });
    expect(await shown()).toEqual([]);
  });

  it("brings newer label records with the card, and cards and unread records of people retrieval found", async () => {
    const inA = {
      conversationId: fixture.groupA.conversationId,
      createdAt: new Date(Date.now() - 10 * 60_000),
      groupId: fixture.groupA.id,
      scope: "group" as const,
    };
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра любит турбины",
      subjectLabel: "Юра (yura_k)",
    });
    const aboutAlex = await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Лёша чинит BMW",
      subjectLabel: "Лёша (alex_x)",
    });
    const key = (telegramUserId: string): PersonCardKey => ({
      area: "group",
      areaKey: fixture.groupA.id,
      familyId: fixture.familyId,
      subjectTelegramUserId: telegramUserId,
    });
    await publishFor(key(YURA_TELEGRAM_ID));
    await publishFor(key(ALEX_TELEGRAM_ID));
    await insertPersonCardRecord(fixture, {
      conversationId: fixture.groupA.conversationId,
      content: "Юра купил E39",
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });

    const cards = await loadPersonCardsForTurn(
      groupAuth(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
      {
        conversationId: fixture.groupA.conversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [aboutAlex.id],
        telegramUserIds: [YURA_TELEGRAM_ID],
      },
    );
    expect(cards.map((card) => card.subjectTelegramUserId)).toEqual([
      YURA_TELEGRAM_ID,
      ALEX_TELEGRAM_ID,
    ]);
    expect(cards[0]!.freshRecords.map((record) => record.content)).toEqual(["Юра купил E39"]);
    expect(cards[1]!.freshRecords).toEqual([]);

    // The profile block shows what Лёша's card did not read, though only retrieval named him.
    await insertPersonCardRecord(fixture, {
      conversationId: fixture.groupA.conversationId,
      content: "Лёша сменил работу",
      groupId: fixture.groupA.id,
      scope: "group",
      subjectParticipantId: fixture.participants.alexInA,
    });
    const view = await profileViewRepository.create(
      groupAuth(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
      {
        conversationId: fixture.groupA.conversationId,
        currentTelegramUserId: YURA_TELEGRAM_ID,
        explicitMentionTelegramUserIds: [],
        now: new Date(),
        personCardIds: cards.map((card) => card.cardId),
        provenance: { sessionId: "session-retrieval", turnId: "turn-retrieval" },
        replyTelegramUserId: null,
        retrievalClaimIds: [aboutAlex.id],
      },
    );
    expect(
      view.subjects.flatMap((subject) => subject.claims.map((claim) => claim.content)),
    ).toEqual(["Лёша сменил работу"]);
  });

  it("drops only the items citing a gone record, and keeps area, order and unread records", async () => {
    const inA = {
      conversationId: fixture.groupA.conversationId,
      createdAt: new Date(Date.now() - 10 * 60_000),
      groupId: fixture.groupA.id,
      scope: "group" as const,
      subjectLabel: "Юра (yura_k)",
    };
    const kept = await insertPersonCardRecord(fixture, { ...inA, content: "Юра любит турбины" });
    const gone = await insertPersonCardRecord(fixture, { ...inA, content: "Юра водит E60" });
    const key: PersonCardKey = {
      area: "group",
      areaKey: fixture.groupA.id,
      familyId: fixture.familyId,
      subjectTelegramUserId: YURA_TELEGRAM_ID,
    };
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'group', $2, $3, 'new_records')`,
      [fixture.familyId, fixture.groupA.id, YURA_TELEGRAM_ID],
    );
    const [claimed] = await personCardDispatchRepository.claim(4);
    const sources = await loadPersonCardSources(key);
    await publishPersonCard({
      buildId: claimed!.id,
      characters: 20,
      cited: sources.records,
      cleanup: [],
      cleanupEnabled: true,
      inputRecords: 2,
      key,
      leaseToken: claimed!.leaseToken,
      readIds: sources.records.map((record) => record.id),
      sections: {
        communication: [],
        facts: [
          { scope: "всегда", sourceRefs: [kept.memoryRef], text: "Турбины" },
          { scope: "всегда", sourceRefs: [gone.memoryRef], text: "E60" },
        ],
        interests: [],
        positions: [],
      },
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    // Unread label records of other areas never come with the card.
    await insertPersonCardRecord(fixture, {
      content: "Юра в группе B",
      conversationId: fixture.groupB.conversationId,
      groupId: fixture.groupB.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Юра купил E39",
      createdAt: undefined,
    });
    const load = (extra: Partial<Parameters<typeof loadPersonCardsForTurn>[1]> = {}) =>
      loadPersonCardsForTurn(groupAuth(fixture, fixture.groupA.id, ALEX_TELEGRAM_ID), {
        conversationId: fixture.groupA.conversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [YURA_TELEGRAM_ID],
        ...extra,
      });
    expect((await load())[0]!.freshRecords.map((record) => record.content)).toEqual([
      "Юра купил E39",
    ]);
    // An open conflict after the build: only the item citing it leaves.
    const other = await insertPersonCardRecord(fixture, { ...inA, content: "Юра продал E60" });
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, 'group', $4,
               'deterministic_guard')`,
      [gone.id, other.id, fixture.familyId, fixture.groupA.id],
    );
    expect((await load())[0]!.sections.facts.map((item) => item.text)).toEqual(["Турбины"]);
    await database().query("DELETE FROM claim_conflicts");
    expect((await load())[0]!.sections.facts.map((item) => item.text)).toEqual(["Турбины", "E60"]);
    // Not profile-eligible any more: the item citing it leaves too.
    await database().query(
      "UPDATE memory_items_all SET profile_eligible = false, subject_label = NULL, subject_participant_id = $2, subject_conversation_id = $3 WHERE id = $1",
      [gone.id, fixture.participants.yuraInA, fixture.groupA.conversationId],
    );
    expect((await load())[0]!.sections.facts.map((item) => item.text)).toEqual(["Турбины"]);

    // The person replied to through the journal comes right after the author, before mentions.
    await insertPersonCardRecord(fixture, {
      ...inA,
      content: "Лёша чинит BMW",
      subjectLabel: "Лёша (alex_x)",
    });
    const alexKey = { ...key, subjectTelegramUserId: ALEX_TELEGRAM_ID };
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'group', $2, $3, 'new_records')`,
      [fixture.familyId, fixture.groupA.id, ALEX_TELEGRAM_ID],
    );
    const [alexBuild] = await personCardDispatchRepository.claim(4);
    const alexSources = await loadPersonCardSources(alexKey);
    await publishPersonCard({
      buildId: alexBuild!.id,
      characters: 20,
      cited: alexSources.records,
      cleanup: [],
      cleanupEnabled: true,
      inputRecords: 1,
      key: alexKey,
      leaseToken: alexBuild!.leaseToken,
      readIds: alexSources.records.map((record) => record.id),
      sections: {
        communication: [],
        facts: [
          { scope: "всегда", sourceRefs: alexSources.records.map((r) => r.memoryRef), text: "BMW" },
        ],
        interests: [],
        positions: [],
      },
      sourcesAsOf: alexSources.sourcesAsOf,
      subjectLabel: alexSources.subjectLabel,
    });
    const [message] = (
      await database().query<{ sequence_id: string }>(
        `INSERT INTO telegram_group_messages
           (conversation_id, group_id, telegram_message_id, sequence_id, actor_kind, actor_id,
            telegram_user_id, sender_display_name, sender_is_bot, message_kind, content_text,
            sent_at)
         VALUES ($1, $2, 70, 7, 'user', $3, $4, 'Лёша', false, 'text', 'привет', now())
         RETURNING sequence_id::text`,
        [
          fixture.groupA.conversationId,
          fixture.groupA.id,
          `telegram:${ALEX_TELEGRAM_ID}`,
          ALEX_TELEGRAM_ID,
        ],
      )
    ).rows;
    const ordered = await loadPersonCardsForTurn(groupAuth(fixture, fixture.groupA.id, "9499"), {
      conversationId: fixture.groupA.conversationId,
      replyTimelineSequence: message!.sequence_id,
      retrievalClaimIds: [],
      telegramUserIds: ["9499", YURA_TELEGRAM_ID],
    });
    expect(ordered.map((shown) => shown.subjectTelegramUserId)).toEqual([
      ALEX_TELEGRAM_ID,
      YURA_TELEGRAM_ID,
    ]);
  });

  it("hides what the card read, not only what it cited, and shows what became visible later", async () => {
    const personal = (content: string) =>
      insertPersonCardRecord(fixture, {
        content,
        conversationId: fixture.personalConversationId,
        createdAt: new Date(Date.now() - 60 * 60_000),
        evidence: { authorUserId: fixture.ownerId, kind: "firsthand" },
        ownerUserId: fixture.ownerId,
        scope: "personal",
        subjectUserId: fixture.ownerId,
      });
    const cited = await personal("Ездит на E60");
    await personal("Любит кофе");
    const first = await personal("Живёт в Москве");
    const second = await personal("Живёт в Казани");
    await database().query(
      `INSERT INTO claim_conflicts
         (claim_a_id, claim_b_id, family_id, scope, scope_partition_key, detection_method)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $3, 'personal', $4,
               'deterministic_guard')`,
      [first.id, second.id, fixture.familyId, fixture.ownerId],
    );
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
    await publishPersonCard({
      buildId: claimed!.id,
      characters: 20,
      cited: sources.records.filter((record) => record.id === cited.id),
      cleanup: [],
      cleanupEnabled: true,
      inputRecords: sources.records.length,
      key,
      leaseToken: claimed!.leaseToken,
      readIds: sources.readIds,
      sections: {
        communication: [],
        facts: [{ scope: "всегда", sourceRefs: [cited.memoryRef], text: "E60" }],
        interests: [],
        positions: [],
      },
      sourcesAsOf: sources.sourcesAsOf,
      subjectLabel: sources.subjectLabel,
    });
    const profile = async (turnId: string) => {
      const [shown] = await loadPersonCardsForTurn(fixture.ownerAuth, {
        conversationId: fixture.personalConversationId,
        replyTimelineSequence: null,
        retrievalClaimIds: [],
        telegramUserIds: [OWNER_TELEGRAM_ID],
      });
      const view = await profileViewRepository.create(fixture.ownerAuth, {
        conversationId: fixture.personalConversationId,
        currentTelegramUserId: OWNER_TELEGRAM_ID,
        explicitMentionTelegramUserIds: [],
        now: new Date(),
        personCardIds: [shown!.cardId],
        provenance: { sessionId: "session-1", turnId },
        replyTelegramUserId: null,
        retrievalClaimIds: [],
      });
      return view.subjects
        .flatMap((subject) => subject.claims.map((claim) => claim.content))
        .sort();
    };
    // «Любит кофе» was read but not cited: the card knows it, the block leaves it out.
    expect(await profile("turn-a")).toEqual([]);
    // The conflict is gone: two old records the build could not read show up at once.
    await database().query("DELETE FROM claim_conflicts");
    expect(await profile("turn-b")).toEqual(["Живёт в Казани", "Живёт в Москве"]);

    // A person with nothing left to build from: the card goes, under the lease only.
    await database().query(
      `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
       VALUES ($1, 'personal', $2, $3, 'invalidated')`,
      [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
    );
    const [retiring] = await personCardDispatchRepository.claim(2);
    await expect(
      retirePersonCard({
        buildId: retiring!.id,
        key,
        leaseToken: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toMatchObject({ code: "AGENT_PERSON_CARD_LEASE_LOST" });
    await retirePersonCard({ buildId: retiring!.id, key, leaseToken: retiring!.leaseToken });
    expect(
      (await database().query("SELECT count(*)::int AS cards FROM person_cards")).rows,
    ).toEqual([{ cards: 0 }]);
  });

  it("loads cards while the chat's journal writes its sequence", async () => {
    await insertPersonCardRecord(fixture, {
      content: "Юра любит турбины",
      conversationId: fixture.groupA.conversationId,
      groupId: fixture.groupA.id,
      scope: "group",
      subjectLabel: "Юра (yura_k)",
    });
    await publishFor({
      area: "group",
      areaKey: fixture.groupA.id,
      familyId: fixture.familyId,
      subjectTelegramUserId: YURA_TELEGRAM_ID,
    });
    const journal = await database().connect();
    try {
      await journal.query("BEGIN");
      await journal.query("UPDATE application_conversations SET updated_at = now() WHERE id = $1", [
        fixture.groupA.conversationId,
      ]);
      const loading = loadPersonCardsForTurn(
        groupAuth(fixture, fixture.groupA.id, YURA_TELEGRAM_ID),
        {
          conversationId: fixture.groupA.conversationId,
          replyTimelineSequence: null,
          retrievalClaimIds: [],
          telegramUserIds: [YURA_TELEGRAM_ID],
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await journal.query("COMMIT");
      expect(await loading).toHaveLength(1);
    } finally {
      journal.release();
    }
  });
});
