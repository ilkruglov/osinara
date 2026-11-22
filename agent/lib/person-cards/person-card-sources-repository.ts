/**
 * The records one card build reads.
 *
 * Exports:
 * - `PersonCardSource`: one record as the build sees it.
 * - `PersonCardSources`: the person's label, the records and the moment they were read.
 * - `loadPersonCardSources`: reads them for one card key.
 *
 * Key constructs:
 * - One repeatable-read snapshot taken at `sourcesAsOf`. Which records the card knows is the set it
 *   read (`person_card_reads`), not a time: a record committed after the snapshot is unread.
 * - `cleanable` is false for what the cleanup never touches: records the person confirmed,
 *   episodes, records of another area than the card's own (a personal card sees projected group
 *   records but does not clean them), and `cleanupUntouchedSql`: records a thread or a confirmed
 *   outcome stands on and records an undo restored.
 * - Above the character cap the newest semantic records are kept; episodes are the newest 40.
 */
import type { PoolClient } from "pg";

import type { MemoryScope } from "../memory-context.js";
import type { MemoryKind } from "../memory-record.js";
import { participantLabel } from "../telegram-participant-label.js";
import {
  PERSON_CARD_INPUT_MAX_CHARACTERS,
  PERSON_CARD_MAX_EPISODES,
} from "./person-card-config.js";
import {
  cleanupUntouchedSql,
  personCardLinksSql,
  type PersonCardKey,
} from "./person-card-links.js";
import { personCardTransaction } from "./person-card-transaction.js";

export interface PersonCardSource {
  attribute: string | null;
  authorLabel: string | null;
  cleanable: boolean;
  content: string;
  createdAt: Date;
  evidenceKind: "firsthand" | "inferred" | "reported" | null;
  id: string;
  kind: MemoryKind;
  link: "label" | "participation" | "subject";
  memoryRef: string;
  occurredAt: Date | null;
  scope: MemoryScope;
  scopePartitionKey: string;
  selfStatement: boolean;
  /** `updated_at` as Postgres prints it: exact to the microsecond, unlike a JS Date. */
  version: string;
}

export interface PersonCardSources {
  episodes: PersonCardSource[];
  records: PersonCardSource[];
  sourcesAsOf: Date;
  subjectLabel: string;
  /** Semantic records tied to the person before the cap; the build logs what the cap dropped. */
  totalRecords: number;
  /**
   * What the card will count as read: every semantic record loaded, over the cap included (the
   * oldest; otherwise they would stay "new" forever and rebuild the card every day), and the
   * episodes sent.
   */
  readIds: string[];
}

interface SourceRow {
  attribute: string | null;
  author_label: string | null;
  cleanable: boolean;
  content: string;
  created_at: Date;
  evidence_kind: PersonCardSource["evidenceKind"];
  id: string;
  kind: MemoryKind;
  link: PersonCardSource["link"];
  memory_ref: string;
  occurred_at: Date | null;
  scope: MemoryScope;
  scope_partition_key: string;
  self_statement: boolean;
  version: string;
}

function toSource(row: SourceRow): PersonCardSource {
  return {
    attribute: row.attribute,
    authorLabel: row.author_label,
    cleanable: row.cleanable,
    content: row.content,
    createdAt: row.created_at,
    evidenceKind: row.evidence_kind,
    id: row.id,
    kind: row.kind,
    link: row.link,
    memoryRef: row.memory_ref,
    occurredAt: row.occurred_at,
    scope: row.scope,
    scopePartitionKey: row.scope_partition_key,
    selfStatement: row.self_statement,
    version: row.version,
  };
}

async function subjectLabel(client: PoolClient, key: PersonCardKey): Promise<string> {
  const result = await client.query<{ display: string | null; username: string | null }>(
    `SELECT display, username FROM (
       SELECT participant.display_name_snapshot AS display, participant.username_snapshot AS username,
              participant.last_observed_at AS seen
       FROM conversation_participants AS participant
       WHERE participant.family_id = $1 AND participant.telegram_user_id = $3
         AND $2::memory_scope = 'group' AND participant.scope_partition_key = $4
       UNION ALL
       SELECT app_user.display_name, app_user.telegram_username, 'infinity'::timestamptz
       FROM users AS app_user
       WHERE app_user.telegram_user_id = $3 AND $2::memory_scope <> 'group'
     ) AS candidate
     ORDER BY seen DESC LIMIT 1`,
    [key.familyId, key.area, key.subjectTelegramUserId, key.areaKey],
  );
  const row = result.rows[0];
  return participantLabel(row?.display ?? null, row?.username ?? null) ?? key.subjectTelegramUserId;
}

function capByCharacters(records: PersonCardSource[]): PersonCardSource[] {
  const newestFirst = [...records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const kept: PersonCardSource[] = [];
  let characters = 0;
  for (const record of newestFirst) {
    characters += record.content.length;
    if (characters > PERSON_CARD_INPUT_MAX_CHARACTERS) break;
    kept.push(record);
  }
  return kept.reverse();
}

export async function loadPersonCardSources(key: PersonCardKey): Promise<PersonCardSources> {
  const { asOf, label, rows } = await personCardTransaction(
    async (client) => {
      const snapshot = await client.query<{ as_of: Date }>("SELECT now() AS as_of");
      const subject = await subjectLabel(client, key);
      const records = await client.query<SourceRow>(
        `WITH ${personCardLinksSql("$1")}
         SELECT DISTINCT ON (item.id)
                item.id, ref.memory_ref, item.kind, item.content, item.attribute, item.scope,
                item.scope_partition_key, item.created_at, item.updated_at::text AS version,
                item.occurred_at, links.link, links.self_statement_at IS NOT NULL AS self_statement,
                evidence.evidence_kind, evidence.author_label_snapshot AS author_label,
                (item.confirmation <> 'user_confirmed' AND item.kind <> 'episode'
                  AND item.scope = $2::memory_scope AND ${cleanupUntouchedSql("item")}) AS cleanable
         FROM links
         JOIN memory_items AS item ON item.id = links.memory_item_id
         JOIN memory_item_refs AS ref ON ref.memory_item_id = item.id
         LEFT JOIN LATERAL (
           SELECT evidence_kind, author_label_snapshot FROM claim_evidence
           WHERE claim_id = item.id AND evidence_role = 'primary' LIMIT 1
         ) AS evidence ON true
         WHERE links.family_id = $1 AND links.area = $2::memory_scope AND links.area_key = $3
           AND links.telegram_user_id = $4
         ORDER BY item.id, links.link`,
        [key.familyId, key.area, key.areaKey, key.subjectTelegramUserId],
      );
      return { asOf: snapshot.rows[0]!.as_of, label: subject, rows: records.rows };
    },
    { begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" },
  );
  const sources = rows.map(toSource);
  const semantic = sources.filter((source) => source.kind !== "episode");
  const episodes = sources
    .filter((source) => source.kind === "episode")
    .sort(
      (a, b) => (b.occurredAt ?? b.createdAt).getTime() - (a.occurredAt ?? a.createdAt).getTime(),
    )
    .slice(0, PERSON_CARD_MAX_EPISODES)
    .reverse();
  return {
    episodes,
    readIds: [...semantic, ...episodes].map((source) => source.id),
    records: capByCharacters(semantic),
    sourcesAsOf: asOf,
    subjectLabel: label,
    totalRecords: semantic.length,
  };
}
