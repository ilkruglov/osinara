/**
 * The person cards a turn shows.
 *
 * Exports:
 * - `LoadPersonCardsInput`: the people this turn is about.
 * - `loadPersonCardsForTurn`: their valid cards in this chat's area, in priority order.
 *
 * Key constructs:
 * - The area follows the chat, checked by the same access rule as the profile block: a private
 *   chat shows only its owner's personal card, the family group the members' family cards, an
 *   external group that group's cards. A family card needs the person to still be a member.
 * - Who, in order (the profile block's rules): the author, the person replied to, the people
 *   mentioned, then the people the turn's retrieved records are about.
 * - An item citing a record that no longer stands (deleted, edited, made sensitive, no longer
 *   projected or tied to the person) is left out until the rebuild; a card left with no item is
 *   not shown, and the profile block shows that person's records as before cards.
 * - Label-only records about the person the card did not read come with it (up to five, short
 *   ones, newest first): the profile block cannot show records without subject ids.
 */
import type { PoolClient } from "pg";

import type { MemoryAuthorization } from "../memory-context.js";
import { PROFILE_CONTEXT_MAX_SUBJECTS } from "../memory-config.js";
import {
  requireConversationAccess,
  timelineReplyTelegramUserIds,
} from "../profile-conversation-access.js";
import {
  cardRecordKindSql,
  eligibleRecordSql,
  labelHolderSql,
  labelNamesOnlySql,
  labelUsernameSql,
  personCardSourceAliveSql,
  type PersonCardArea,
} from "./person-card-links.js";
import { PERSON_CARD_SECTIONS, type PersonCardSections } from "./person-card-parse.js";
import { personCardTransaction } from "./person-card-transaction.js";
import type { ShownPersonCard } from "./person-card-render.js";

interface CardRow {
  alive_refs: string[];
  built_at: Date;
  card_ref: string;
  id: string;
  sections: PersonCardSections;
  subject_label: string;
  subject_telegram_user_id: string;
  version: number;
}

const FRESH_RECORDS_PER_CARD = 5;
const FRESH_RECORD_MAX_CHARACTERS = 500;

export interface LoadPersonCardsInput {
  conversationId: string;
  /** The author first, then the person replied to and the people mentioned; the order is kept. */
  telegramUserIds: readonly string[];
  /** A reply resolved through the journal only; it goes right after the author. */
  replyTimelineSequence: string | null;
  /** The turn's retrieved records, best first: the people they are about come last. */
  retrievalClaimIds: readonly string[];
}

async function retrievalSubjects(
  client: PoolClient,
  familyId: string,
  claimIds: readonly string[],
): Promise<string[]> {
  if (claimIds.length === 0) return [];
  const result = await client.query<{ telegram_user_id: string }>(
    `SELECT person.telegram_user_id
     FROM unnest($2::uuid[]) WITH ORDINALITY AS retrieved(id, rank)
     JOIN memory_items AS item ON item.id = retrieved.id AND item.family_id = $1
     LEFT JOIN conversation_participants AS participant
       ON participant.id = item.subject_participant_id
     LEFT JOIN users AS app_user ON app_user.id = item.subject_user_id
     CROSS JOIN LATERAL (
       SELECT COALESCE(participant.telegram_user_id, app_user.telegram_user_id,
                       CASE WHEN item.subject_participant_id IS NULL AND item.subject_user_id IS NULL
                            THEN ${labelHolderSql("item")} END) AS telegram_user_id
     ) AS person
     WHERE person.telegram_user_id IS NOT NULL
     ORDER BY retrieved.rank`,
    [familyId, claimIds],
  );
  return result.rows.map((row) => row.telegram_user_id);
}

async function freshLabelRecords(
  client: PoolClient,
  cardIds: readonly string[],
): Promise<Map<string, ShownPersonCard["freshRecords"]>> {
  const result = await client.query<{ card_id: string; content: string; memory_ref: string }>(
    `SELECT card.id AS card_id, fresh.content, ref.memory_ref
     FROM person_cards AS card
     CROSS JOIN LATERAL (
       SELECT item.id, item.content, item.created_at FROM memory_items AS item
       WHERE item.family_id = card.family_id
         AND ${cardRecordKindSql("item")} AND ${eligibleRecordSql("item")}
         -- The person's own usernames first: the index on the label's username finds the few
         -- candidates instead of reading the whole area.
         AND ${labelUsernameSql("item")} = ANY(ARRAY(
           SELECT lower(own.username_snapshot) FROM conversation_participants AS own
           WHERE own.family_id = card.family_id
             AND own.telegram_user_id = card.subject_telegram_user_id
             AND own.username_snapshot IS NOT NULL
         ))
         AND NOT EXISTS (
           SELECT 1 FROM person_card_reads AS known
           WHERE known.card_id = card.id AND known.memory_item_id = item.id
         )
         AND char_length(item.content) <= $2
         AND item.subject_user_id IS NULL AND item.subject_participant_id IS NULL
         AND item.subject_family_id IS NULL
         AND ((card.area = 'group' AND item.scope = 'group' AND item.group_id = card.area_key)
           OR (card.area = 'family' AND item.scope = 'family')
           OR (card.area = 'personal' AND (item.scope = 'family'
               OR (item.scope = 'personal' AND item.owner_user_id = card.area_key))))
         AND ${labelNamesOnlySql("item", "card.subject_telegram_user_id")}
       ORDER BY item.created_at DESC LIMIT $3
     ) AS fresh
     JOIN memory_item_refs AS ref ON ref.memory_item_id = fresh.id
     WHERE card.id = ANY($1::uuid[])
     ORDER BY card.id, fresh.created_at DESC`,
    [cardIds, FRESH_RECORD_MAX_CHARACTERS, FRESH_RECORDS_PER_CARD],
  );
  const byCard = new Map<string, ShownPersonCard["freshRecords"]>();
  for (const row of result.rows) {
    const records = byCard.get(row.card_id) ?? [];
    records.push({ content: row.content, memoryRef: row.memory_ref });
    byCard.set(row.card_id, records);
  }
  return byCard;
}

/** Only items whose every source still stands; null when none is left. */
function standingSections(
  sections: PersonCardSections,
  aliveRefs: ReadonlySet<string>,
): PersonCardSections | null {
  const kept = Object.fromEntries(
    PERSON_CARD_SECTIONS.map((name) => [
      name,
      (sections[name] ?? []).filter((item) => item.sourceRefs.every((ref) => aliveRefs.has(ref))),
    ]),
  ) as PersonCardSections;
  return PERSON_CARD_SECTIONS.some((name) => kept[name].length > 0) ? kept : null;
}

export async function loadPersonCardsForTurn(
  auth: MemoryAuthorization,
  input: LoadPersonCardsInput,
): Promise<ShownPersonCard[]> {
  // Not read-only: the access check locks the conversation and membership like the profile block.
  // Read committed on purpose: under repeatable read that lock fails (40001) whenever the chat's
  // journal writes its sequence meanwhile; a card republished between the two reads is a narrow
  // window that costs one turn a record at most.
  return personCardTransaction(async (client) => {
    const conversation = await requireConversationAccess(client, auth, input.conversationId);
    const area: PersonCardArea = conversation.scope;
    const areaKey =
      area === "personal"
        ? conversation.owner_user_id
        : area === "family"
          ? auth.familyId
          : conversation.telegram_group_id;
    const [author, ...others] = input.telegramUserIds;
    // A private chat is about its owner only, as the profile block there is.
    const subjects =
      area === "personal"
        ? input.telegramUserIds.filter((id) => id === auth.telegramUserId).slice(0, 1)
        : [
            ...new Set([
              ...(author === undefined ? [] : [author]),
              ...(input.replyTimelineSequence === null
                ? []
                : await timelineReplyTelegramUserIds(
                    client,
                    input.conversationId,
                    input.replyTimelineSequence,
                  )),
              ...others,
              ...(await retrievalSubjects(client, auth.familyId, input.retrievalClaimIds)),
            ]),
          ];
    if (areaKey === null || subjects.length === 0) return [];
    const result = await client.query<CardRow>(
      `SELECT card.id, card.card_ref, card.version, card.sections,
              card.built_at, card.subject_label, card.subject_telegram_user_id,
              ARRAY(
                SELECT ref.memory_ref FROM person_card_sources AS source
                JOIN memory_items AS cited ON cited.id = source.memory_item_id
                JOIN memory_item_refs AS ref ON ref.memory_item_id = cited.id
                WHERE source.card_id = card.id
                  AND ${personCardSourceAliveSql({ card: "card", cited: "cited", source: "source" })}
              ) AS alive_refs
       FROM person_cards AS card
       WHERE card.family_id = $1 AND card.area = $2::memory_scope AND card.area_key = $3
         AND card.subject_telegram_user_id = ANY($4::text[])
         AND ($2::memory_scope = 'group' OR EXISTS (
           SELECT 1 FROM family_memberships AS membership
           JOIN users AS member ON member.id = membership.user_id
           WHERE membership.family_id = card.family_id
             AND member.telegram_user_id = card.subject_telegram_user_id
         ))`,
      [auth.familyId, area, areaKey, subjects],
    );
    const byTelegramUser = new Map(result.rows.map((row) => [row.subject_telegram_user_id, row]));
    const shown = subjects
      .flatMap((id) => {
        const row = byTelegramUser.get(id);
        const sections = row && standingSections(row.sections, new Set(row.alive_refs));
        return row && sections ? [{ row, sections }] : [];
      })
      .slice(0, PROFILE_CONTEXT_MAX_SUBJECTS);
    const fresh = await freshLabelRecords(
      client,
      shown.map(({ row }) => row.id),
    );
    return shown.map(({ row, sections }) => ({
      builtAt: row.built_at,
      cardId: row.id,
      cardRef: row.card_ref,
      freshRecords: fresh.get(row.id) ?? [],
      sections,
      subjectLabel: row.subject_label,
      subjectTelegramUserId: row.subject_telegram_user_id,
      version: row.version,
    }));
  });
}
