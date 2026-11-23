/**
 * Which records are about which person, per card area.
 *
 * Exports:
 * - `PersonCardArea`, `PersonCardKey`: an area and the person a card is about.
 * - `personCardSourceAliveSql`: the condition every cited record must still meet for its card to be
 *   shown: still the active version, evidenced and normal, no unresolved conflict, still tied to
 *   the person the way it was (a label still names exactly this person; a subject record is still
 *   profile-eligible) and, in a personal card, a group record still under the live projection.
 *   An item citing a record that no longer stands leaves the turn until the daily rebuild: an edit
 *   that made a record sensitive leaves its old version `superseded` but `normal`.
 * - `personCardLinksSql`: CTEs ending in `links`, one row per (record, area, person).
 * - `cardRecordKindSql`, `eligibleRecordSql`: the record kinds a card reads and the profile block's
 *   filters, shared by every query.
 * - `labelUsernameOfSql`, `labelUsernameSql`, `labelHolderSql`, `labelNamesOnlySql`: the username
 *   closing a label, a record's label's username (the expression of its index), the one person
 *   holding a record's label in its partition (a participant's `label_key`, migration 156), and
 *   the condition that this holder is a given person.
 *
 * Key constructs:
 * - A record counts when it passes the filters of the profile block: active, evidenced, normal
 *   sensitivity, no unresolved conflict. Episodes count only as summaries of a discussion and only
 *   for the person's positions.
 * - A record is tied to a person by its subject ids, or, when it carries only the «Имя (username)»
 *   label the silent review writes (almost every group record), by the whole label when it is the
 *   stored label (`label_key`, migration 156) of exactly one participant of the same memory
 *   partition right now. A subject record must be profile-eligible like in the profile block;
 *   that flag requires subject ids, so for a label-tied record its other two conditions
 *   (evidenced, normal) are checked directly.
 *   Ambiguous labels and labels without a username stay out.
 * - The person's own words: firsthand evidence from the person, the first statement or a later
 *   confirmation of the same record; never an episode, which is about a topic.
 * - Areas never widen a record: a group record reaches that group's card and, through the live
 *   external projection policy exactly as the personal profile block has it, the personal card of
 *   the linked family member; a family record reaches the family card and the member's personal
 *   card; a personal record reaches only its owner's card, and only when it is about the owner.
 */
import type { MemoryScope } from "../memory-context.js";
import { MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE } from "../memory-config.js";
import { externalProfileProjectionPredicate } from "../external-profile-projection-predicate.js";

export type PersonCardArea = MemoryScope;

/** The kinds of record a card reads (besides discussion summaries for positions). */
export function cardRecordKindSql(alias: string): string {
  return `${alias}.kind IN ('profile', 'preference', 'fact')`;
}

export interface PersonCardKey {
  area: PersonCardArea;
  /** personal: the user; family: the family; group: the external group. */
  areaKey: string;
  familyId: string;
  subjectTelegramUserId: string;
}

/** The filters of the profile block: active, evidenced, normal, no unresolved conflict. */
export function eligibleRecordSql(alias: string): string {
  return `(${alias}.claim_status = 'active' AND ${alias}.provenance_state = 'evidenced'
    AND ${alias}.sensitivity = 'normal'
    AND NOT EXISTS (SELECT 1 FROM claim_conflicts AS open_conflict
                    WHERE open_conflict.resolution = 'unresolved'
                      AND open_conflict.claim_a_id = ${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM claim_conflicts AS open_conflict
                    WHERE open_conflict.resolution = 'unresolved'
                      AND open_conflict.claim_b_id = ${alias}.id))`;
}

/** The username closing a «Имя (username)» label, lower-cased; NULL when the label has none. */
export function labelUsernameOfSql(label: string): string {
  return String.raw`lower(substring(${label} from '\(@?([A-Za-z0-9_]{4,})\)\s*$'))`;
}

/** A record's label's username: the expression of its index (`memory_items_label_username`). */
export function labelUsernameSql(alias: string): string {
  return labelUsernameOfSql(`${alias}.subject_label`);
}

/**
 * A record's label as participants' `label_key` holds them (`person_label_key` of the label alone),
 * or NULL: a label without a username names no one.
 */
function tiedLabelSql(alias: string): string {
  return `CASE WHEN ${labelUsernameSql(alias)} IS NOT NULL
    THEN person_label_key(${alias}.subject_label, NULL) END`;
}

/**
 * The one Telegram user whose label now is the record's label, in the record's partition, or NULL.
 * The whole label, not the username in it (Fable review, 23 November 2026: «Вася (yura_k)», the
 * name of a participant without a username, tied to Юра); a label two people hold names neither,
 * and a label without a username names no one.
 */
export function labelHolderSql(alias: string): string {
  return `(SELECT min(holder.telegram_user_id) FROM conversation_participants AS holder
    WHERE holder.family_id = ${alias}.family_id
      AND holder.scope_partition_key = ${alias}.scope_partition_key
      AND holder.label_key = ${tiedLabelSql(alias)}
    HAVING count(DISTINCT holder.telegram_user_id) = 1)`;
}

/** The label of `cited` names exactly the Telegram user in `telegramUserId`, in its partition. */
export function labelNamesOnlySql(cited: string, telegramUserId: string): string {
  return `COALESCE(${labelHolderSql(cited)} = ${telegramUserId}, false)`;
}

/**
 * Aliases: `card` a `person_cards` row, `source` its `person_card_sources` row, `cited` the
 * record from the `memory_items` view (soft-deleted rows are already gone from it).
 */
export function personCardSourceAliveSql(aliases: {
  card: string;
  cited: string;
  source: string;
}): string {
  const { card, cited, source } = aliases;
  return `(${eligibleRecordSql(cited)}
    AND (${source}.link <> 'subject' OR ${cited}.profile_eligible)
    AND (${source}.link <> 'label' OR ${labelNamesOnlySql(cited, `${card}.subject_telegram_user_id`)})
    AND (${card}.area <> 'personal' OR ${cited}.scope <> 'group'
         OR ${externalProfileProjectionPredicate({ claimAlias: cited, viewerUserParameter: `${card}.area_key` })}))`;
}

/**
 * `familyParameter` is a `uuid` placeholder; NULL reads every family (the dispatcher's scan).
 * The result columns of `links`: memory_item_id, family_id, area, area_key, telegram_user_id,
 * link ('subject' | 'label' | 'participation'), self_statement_at (when the person's own words
 * about themselves backed the record, first or as a later confirmation; never for an episode,
 * whose summary is about a topic), self_direct (some of those words were told to Mia, not taken
 * down from the chat: evidence not `recorded_by` the review, or older than the mark), kind.
 */
export function personCardLinksSql(familyParameter: string): string {
  const family = `${familyParameter}::uuid`;
  return `names AS (
    SELECT participant.family_id, participant.scope_partition_key AS part,
           participant.label_key AS label,
           min(participant.telegram_user_id) AS telegram_user_id,
           count(DISTINCT participant.telegram_user_id) AS holders
    FROM conversation_participants AS participant
    WHERE (${family} IS NULL OR participant.family_id = ${family})
    GROUP BY participant.family_id, participant.scope_partition_key, 3
  ),
  eligible AS (
    SELECT item.id, item.family_id, item.scope, item.scope_partition_key, item.owner_user_id,
           item.kind, item.subject_user_id, item.subject_participant_id,
           item.subject_family_id, item.profile_eligible,
           ${tiedLabelSql("item")} AS label
    FROM memory_items AS item
    WHERE (${family} IS NULL OR item.family_id = ${family}) AND ${eligibleRecordSql("item")}
      AND (${cardRecordKindSql("item")}
           OR (item.kind = 'episode' AND item.attribute = '${MEMORY_DISCUSSION_SUMMARY_ATTRIBUTE}'))
  ),
  persons AS (
    SELECT eligible.id,
           COALESCE(participant.telegram_user_id, app_user.telegram_user_id) AS telegram_user_id,
           'subject'::text AS link
    FROM eligible
    LEFT JOIN conversation_participants AS participant
      ON participant.id = eligible.subject_participant_id
    LEFT JOIN users AS app_user ON app_user.id = eligible.subject_user_id
    WHERE eligible.kind <> 'episode' AND eligible.profile_eligible
      AND num_nonnulls(eligible.subject_participant_id, eligible.subject_user_id) = 1
    UNION ALL
    SELECT eligible.id, names.telegram_user_id, 'label'::text
    FROM eligible
    JOIN names ON names.family_id = eligible.family_id AND names.part = eligible.scope_partition_key
      AND names.label = eligible.label AND names.holders = 1
    WHERE eligible.kind <> 'episode' AND eligible.subject_participant_id IS NULL
      AND eligible.subject_user_id IS NULL AND eligible.subject_family_id IS NULL
    UNION ALL
    SELECT DISTINCT eligible.id,
           COALESCE(author_participant.telegram_user_id, author_user.telegram_user_id),
           'participation'::text
    FROM eligible
    JOIN claim_evidence AS evidence ON evidence.claim_id = eligible.id
    LEFT JOIN conversation_participants AS author_participant
      ON author_participant.id = evidence.author_participant_id
    LEFT JOIN users AS author_user ON author_user.id = evidence.author_user_id
    WHERE eligible.kind = 'episode'
      AND COALESCE(author_participant.telegram_user_id, author_user.telegram_user_id) IS NOT NULL
  ),
  own_words AS (
    SELECT own.claim_id,
           COALESCE(own_participant.telegram_user_id, own_user.telegram_user_id) AS telegram_user_id,
           max(own.created_at) AS said_at,
           bool_or(own.recorded_by IS DISTINCT FROM 'review') AS said_directly
    FROM claim_evidence AS own
    LEFT JOIN conversation_participants AS own_participant
      ON own_participant.id = own.author_participant_id
    LEFT JOIN users AS own_user ON own_user.id = own.author_user_id
    WHERE own.evidence_kind = 'firsthand' AND (${family} IS NULL OR own.family_id = ${family})
    GROUP BY 1, 2
  ),
  tied AS (
    SELECT persons.id, persons.telegram_user_id, persons.link, eligible.family_id, eligible.scope,
           eligible.scope_partition_key, eligible.owner_user_id, eligible.kind,
           CASE WHEN eligible.kind <> 'episode' THEN own_words.said_at END AS self_statement_at,
           eligible.kind <> 'episode' AND COALESCE(own_words.said_directly, false) AS self_direct
    FROM persons JOIN eligible ON eligible.id = persons.id
    LEFT JOIN own_words ON own_words.claim_id = persons.id
      AND own_words.telegram_user_id = persons.telegram_user_id
    WHERE persons.telegram_user_id IS NOT NULL
  ),
  members AS (
    SELECT membership.family_id, membership.user_id, member_user.telegram_user_id
    FROM family_memberships AS membership
    JOIN users AS member_user ON member_user.id = membership.user_id
    WHERE (${family} IS NULL OR membership.family_id = ${family})
  ),
  links AS (
    SELECT tied.id AS memory_item_id, tied.family_id, 'group'::memory_scope AS area,
           tied.scope_partition_key AS area_key, tied.telegram_user_id, tied.link,
           tied.self_statement_at, tied.self_direct, tied.kind
    FROM tied WHERE tied.scope = 'group'
    UNION ALL
    SELECT tied.id, tied.family_id, area.scope, area.area_key, tied.telegram_user_id, tied.link,
           tied.self_statement_at, tied.self_direct, tied.kind
    FROM tied
    JOIN members ON members.family_id = tied.family_id
      AND members.telegram_user_id = tied.telegram_user_id
    CROSS JOIN LATERAL (VALUES ('family'::memory_scope, tied.family_id),
                               ('personal'::memory_scope, members.user_id)) AS area(scope, area_key)
    WHERE tied.scope = 'family'
    UNION ALL
    SELECT tied.id, tied.family_id, 'personal'::memory_scope, tied.owner_user_id,
           tied.telegram_user_id, tied.link, tied.self_statement_at, tied.self_direct, tied.kind
    FROM tied
    JOIN members ON members.family_id = tied.family_id AND members.user_id = tied.owner_user_id
      AND members.telegram_user_id = tied.telegram_user_id
    WHERE tied.scope = 'personal'
    UNION ALL
    SELECT tied.id, tied.family_id, 'personal'::memory_scope, projected.linked_user_id,
           tied.telegram_user_id, tied.link, tied.self_statement_at, tied.self_direct, tied.kind
    FROM tied
    JOIN memory_items AS item ON item.id = tied.id
    JOIN conversation_participants AS projected ON projected.id = item.subject_participant_id
    JOIN members ON members.family_id = tied.family_id
      AND members.user_id = projected.linked_user_id
      AND members.telegram_user_id = tied.telegram_user_id
    WHERE tied.scope = 'group' AND tied.link = 'subject' AND tied.kind <> 'episode'
      AND ${externalProfileProjectionPredicate({ claimAlias: "item", viewerUserParameter: "projected.linked_user_id" })}
  )`;
}
