/**
 * Helpers for the cleanup, undo and lock tests of person cards, against PostgreSQL.
 *
 * Exports:
 * - `ownerPersonalKey`: the owner's personal card.
 * - `insertOwnerRecord`: a personal record about the owner, made some minutes ago.
 * - `claimOwnerBuild`: a claimed build of that card with the sources it reads.
 * - `ownerPublishInput`: the publish of such a build, citing one record, with a cleanup.
 * - `publishOwnerCleanup`: one build of that card that publishes the given cleanup.
 * - `markOwnerRepeat`: hides a record as a repeat the way another area's build would.
 * - `waitForLockWaiters`: resolves once that many sessions wait on a lock.
 * - `deadlockCount`: deadlocks PostgreSQL has detected in this database so far.
 */
import { database } from "../database.js";
import { personCardDispatchRepository } from "./person-card-dispatch-repository.js";
import type { PersonCardKey } from "./person-card-links.js";
import {
  publishPersonCard,
  type PublishPersonCardInput,
} from "./person-card-publish-repository.js";
import { loadPersonCardSources } from "./person-card-sources-repository.js";
import {
  insertPersonCardRecord,
  OWNER_TELEGRAM_ID,
  type PersonCardFixture,
} from "./person-card.integration-fixtures.js";

export interface CleanupRecord {
  id: string;
  memoryRef: string;
}

export function ownerPersonalKey(fixture: PersonCardFixture): PersonCardKey {
  return {
    area: "personal",
    areaKey: fixture.ownerId,
    familyId: fixture.familyId,
    subjectTelegramUserId: OWNER_TELEGRAM_ID,
  };
}

export function insertOwnerRecord(
  fixture: PersonCardFixture,
  content: string,
  minutesAgo: number,
  attribute?: string,
): Promise<CleanupRecord> {
  return insertPersonCardRecord(fixture, {
    ...(attribute === undefined ? {} : { attribute }),
    content,
    conversationId: fixture.personalConversationId,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    ownerUserId: fixture.ownerId,
    scope: "personal",
    subjectUserId: fixture.ownerId,
  });
}

export async function claimOwnerBuild(fixture: PersonCardFixture) {
  const key = ownerPersonalKey(fixture);
  await database().query(
    `INSERT INTO person_card_builds (family_id, area, area_key, subject_telegram_user_id, reason)
     VALUES ($1, 'personal', $2, $3, 'new_records')`,
    [fixture.familyId, fixture.ownerId, OWNER_TELEGRAM_ID],
  );
  const [claimed] = await personCardDispatchRepository.claim(2);
  return { claimed: claimed!, key, sources: await loadPersonCardSources(key) };
}

export type OwnerBuild = Awaited<ReturnType<typeof claimOwnerBuild>>;

export interface OwnerCleanupEntry {
  item: CleanupRecord;
  kept: CleanupRecord;
  reason: "duplicate" | "refuted";
}

/** A publish of a claimed owner build: one fact citing `cite`, and the proposed cleanup. */
export function ownerPublishInput(
  build: OwnerBuild,
  cite: CleanupRecord,
  cleanup: readonly OwnerCleanupEntry[] = [],
): PublishPersonCardInput {
  const { claimed, key, sources } = build;
  const version = (id: string) => sources.records.find((record) => record.id === id)!.version;
  return {
    buildId: claimed.id,
    characters: 20,
    cited: sources.records.filter((record) => record.id === cite.id),
    cleanup: cleanup.map((entry) => ({
      explanation: "чистка",
      keptMemoryItemId: entry.kept.id,
      memoryItemId: entry.item.id,
      readVersion: version(entry.item.id),
      reason: entry.reason,
    })),
    cleanupEnabled: true,
    inputRecords: sources.records.length,
    key,
    leaseToken: claimed.leaseToken,
    readIds: sources.readIds,
    sections: {
      communication: [],
      facts: [{ scope: "всегда", sourceRefs: [cite.memoryRef], text: "Факт" }],
      interests: [],
      positions: [],
    },
    sourcesAsOf: sources.sourcesAsOf,
    subjectLabel: sources.subjectLabel,
  };
}

/** Claims a new build of the owner's card and publishes it citing the first kept record. */
export async function publishOwnerCleanup(
  fixture: PersonCardFixture,
  cleanup: readonly OwnerCleanupEntry[],
): Promise<{ buildId: string; cleaned: number }> {
  const build = await claimOwnerBuild(fixture);
  const result = await publishPersonCard(ownerPublishInput(build, cleanup[0]!.kept, cleanup));
  return { buildId: build.claimed.id, cleaned: result.cleaned };
}

/** Another area's build hid `repeat` behind `kept` (a new version of the row, like the cleanup). */
export async function markOwnerRepeat(repeat: CleanupRecord, kept: CleanupRecord): Promise<void> {
  await database().query(
    `UPDATE memory_items_all SET claim_status = 'duplicate', duplicate_of = $2, updated_at = now()
     WHERE id = $1`,
    [repeat.id, kept.id],
  );
}

/** Polls until `count` sessions of this database wait on a lock; fails after five seconds. */
export async function waitForLockWaiters(count: number): Promise<void> {
  for (let poll = 0; poll < 500; poll += 1) {
    const waiting = await database().query<{ waiters: number }>(
      `SELECT count(*)::int AS waiters FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (waiting.rows[0]!.waiters >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${count} sessions never waited on a lock`);
}

export async function deadlockCount(): Promise<number> {
  const result = await database().query<{ deadlocks: string }>(
    "SELECT deadlocks::text FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(result.rows[0]!.deadlocks);
}
