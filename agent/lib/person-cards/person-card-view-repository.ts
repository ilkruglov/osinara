/**
 * The person cards a turn shows.
 *
 * Exports:
 * - `LoadPersonCardsInput`: the people this turn is about.
 * - `TurnPersonCard`: a shown card with what it keeps out of the profile block.
 * - `loadPersonCardsForTurn`: their valid cards in this chat's area, in priority order.
 *
 * Key constructs:
 * - The area follows the chat, checked by the same access rule as the profile block: a private
 *   chat shows only its owner's personal card, the family group the members' family cards, an
 *   external group that group's cards. A family card needs the person to still be a member.
 * - Who, in order (the profile block's rules): the author, the person replied to, the people
 *   mentioned, then the people the turn's retrieved records are about.
 * - An item citing a record that no longer stands (deleted, edited, made sensitive, no longer
 *   projected or tied to the person) is left out until the rebuild, and its records that stand and
 *   that no remaining item cites are released: the profile block shows them although the card read
 *   them, label-only ones come with the card (Fable review, 23 November 2026: a trait several
 *   records back vanished whole when one of them went). A card left with no item hides nothing
 *   from the profile block, which shows that person's records as before cards; it is shown only to
 *   bring label-only records.
 * - Label-only records about the person the card did not read, or released, come with it (every
 *   released one first, clipped when long, then up to five short unread ones, newest first): the
 *   profile block cannot show records without subject ids.
 * - `personCardsForProfile`: what the profile block needs of the shown cards.
 */
import type { PoolClient } from "pg";

import { clipText } from "../display-text.js";
import type { MemoryAuthorization } from "../memory-context.js";
import type { PersonCardsInProfile } from "../profile-view.js";
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
  labelUsernameOfSql,
  labelUsernameSql,
  personCardSourceAliveSql,
  type PersonCardArea,
} from "./person-card-links.js";
import {
  PERSON_CARD_SECTIONS,
  type PersonCardItem,
  type PersonCardSections,
} from "./person-card-parse.js";
import { personCardTransaction } from "./person-card-transaction.js";
import { hasItems, type ShownPersonCard } from "./person-card-render.js";

/** A card as the turn shows it, and what it gives back to the profile block. */
export interface TurnPersonCard extends ShownPersonCard {
  /** Read records that stand only in items that left the turn. */
  releasedMemoryItemIds: string[];
}

/** A card whose items stand keeps what it read out of the block; one with none hides nothing. */
export function personCardsForProfile(cards: readonly TurnPersonCard[]): PersonCardsInProfile {
  return {
    personCardIds: cards.map((card) => card.cardId),
    readHidingPersonCardIds: cards
      .filter((card) => hasItems(card.sections))
      .map((card) => card.cardId),
    releasedMemoryItemIds: cards.flatMap((card) => card.releasedMemoryItemIds),
  };
}

interface CardRow {
  /** The memory ref of every cited record that still stands, to its id. */
  alive: Record<string, string>;
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
  released: { itemlessCardIds: readonly string[]; memoryItemIds: readonly string[] },
): Promise<Map<string, ShownPersonCard["freshRecords"]>> {
  const result = await client.query<{
    card_id: string;
    content: string;
    memory_ref: string;
    released: boolean;
  }>(
    `SELECT card.id AS card_id, fresh.content, fresh.released, ref.memory_ref
     FROM person_cards AS card
     CROSS JOIN LATERAL (
       SELECT ranked.* FROM (
       SELECT item.id, item.content, item.created_at, item.id = ANY($4::uuid[]) AS released,
              row_number() OVER (PARTITION BY item.id = ANY($4::uuid[])
                                 ORDER BY item.created_at DESC) AS place
       FROM memory_items AS item
       WHERE item.family_id = card.family_id
         AND ${cardRecordKindSql("item")} AND ${eligibleRecordSql("item")}
         -- The usernames the person's labels end in (their own, or one in the name of a person
         -- without one) first: the index on the label's username finds the few candidates
         -- instead of reading the whole area.
         AND ${labelUsernameSql("item")} = ANY(ARRAY(
           SELECT ${labelUsernameOfSql("own.label_key")}
           FROM conversation_participants AS own
           WHERE own.family_id = card.family_id
             AND own.telegram_user_id = card.subject_telegram_user_id
             AND own.label_key IS NOT NULL
         ))
         AND (NOT EXISTS (
           SELECT 1 FROM person_card_reads AS known
           WHERE known.card_id = card.id AND known.memory_item_id = item.id
         ) OR item.id = ANY($4::uuid[]) OR card.id = ANY($5::uuid[]))
         -- A released record comes however long (clipped below): it was in the card.
         AND (char_length(item.content) <= $2 OR item.id = ANY($4::uuid[]))
         AND item.subject_user_id IS NULL AND item.subject_participant_id IS NULL
         AND item.subject_family_id IS NULL
         AND ((card.area = 'group' AND item.scope = 'group' AND item.group_id = card.area_key)
           OR (card.area = 'family' AND item.scope = 'family')
           OR (card.area = 'personal' AND (item.scope = 'family'
               OR (item.scope = 'personal' AND item.owner_user_id = card.area_key))))
         AND ${labelNamesOnlySql("item", "card.subject_telegram_user_id")}
       ) AS ranked
       -- Every released record (it was in the card) and the newest unread ones.
       WHERE ranked.released OR ranked.place <= $3
     ) AS fresh
     JOIN memory_item_refs AS ref ON ref.memory_item_id = fresh.id
     WHERE card.id = ANY($1::uuid[])
     ORDER BY card.id, fresh.released DESC, fresh.created_at DESC`,
    [
      cardIds,
      FRESH_RECORD_MAX_CHARACTERS,
      FRESH_RECORDS_PER_CARD,
      released.memoryItemIds,
      released.itemlessCardIds,
    ],
  );
  const byCard = new Map<string, ShownPersonCard["freshRecords"]>();
  for (const row of result.rows) {
    const records = byCard.get(row.card_id) ?? [];
    records.push({
      // Only a released record can be longer: the query keeps unread ones within the limit.
      content: row.released ? clipText(row.content, FRESH_RECORD_MAX_CHARACTERS) : row.content,
      memoryRef: row.memory_ref,
    });
    byCard.set(row.card_id, records);
  }
  return byCard;
}

/**
 * Only items whose every source still stands, and the standing records that only the left-out
 * items cite.
 */
function standingSections(row: CardRow): { released: string[]; sections: PersonCardSections } {
  const alive = new Map(Object.entries(row.alive));
  const stands = (item: PersonCardItem) => item.sourceRefs.every((ref) => alive.has(ref));
  const sections = Object.fromEntries(
    PERSON_CARD_SECTIONS.map((name) => [name, (row.sections[name] ?? []).filter(stands)]),
  ) as PersonCardSections;
  const keptRefs = new Set(
    Object.values(sections)
      .flat()
      .flatMap((item) => item.sourceRefs),
  );
  const cited = PERSON_CARD_SECTIONS.flatMap((name) => row.sections[name] ?? []).flatMap(
    (item) => item.sourceRefs,
  );
  const released = [...new Set(cited)]
    .filter((ref) => alive.has(ref) && !keptRefs.has(ref))
    .map((ref) => alive.get(ref)!);
  return { released, sections };
}

export async function loadPersonCardsForTurn(
  auth: MemoryAuthorization,
  input: LoadPersonCardsInput,
): Promise<TurnPersonCard[]> {
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
              COALESCE(alive.map, '{}'::jsonb) AS alive
       FROM person_cards AS card
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(ref.memory_ref, cited.id) AS map
         FROM person_card_sources AS source
         JOIN memory_items AS cited ON cited.id = source.memory_item_id
         JOIN memory_item_refs AS ref ON ref.memory_item_id = cited.id
         WHERE source.card_id = card.id
           AND ${personCardSourceAliveSql({ card: "card", cited: "cited", source: "source" })}
       ) AS alive ON true
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
    const candidates = subjects.flatMap((id) => {
      const row = byTelegramUser.get(id);
      return row ? [{ row, ...standingSections(row) }] : [];
    });
    const fresh = await freshLabelRecords(
      client,
      candidates.map(({ row }) => row.id),
      {
        itemlessCardIds: candidates
          .filter(({ sections }) => !hasItems(sections))
          .map(({ row }) => row.id),
        memoryItemIds: candidates.flatMap((card) => card.released),
      },
    );
    // A card left with no item comes only for its label-only records.
    return candidates
      .filter(({ row, sections }) => hasItems(sections) || (fresh.get(row.id) ?? []).length > 0)
      .slice(0, PROFILE_CONTEXT_MAX_SUBJECTS)
      .map(({ released, row, sections }) => ({
        builtAt: row.built_at,
        cardId: row.id,
        cardRef: row.card_ref,
        freshRecords: fresh.get(row.id) ?? [],
        releasedMemoryItemIds: released,
        sections,
        subjectLabel: row.subject_label,
        subjectTelegramUserId: row.subject_telegram_user_id,
        version: row.version,
      }));
  });
}
