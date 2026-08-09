/**
 * Bounded chunking for one durable scheduled group-history snapshot.
 *
 * Exports:
 * - `ScheduledGroupHistoryEntry`: model-safe timeline entry without transport/database identities.
 * - `chunkScheduledGroupHistory`: lossless chronological chunks within hard model limits.
 */
import { AppError } from "../app-error.js";

const SNAPSHOT_MAX_ENTRIES = 1_000;
const SNAPSHOT_MAX_CONTENT_CHARACTERS = 4_500_000;
const CHUNK_MAX_ENTRIES = 50;
const CHUNK_MAX_CHARACTERS = 9_000;
const CONTENT_PART_MAX_CHARACTERS = 6_000;

export interface ScheduledGroupHistoryEntry {
  actor: "agent_self" | "user";
  content: string | null;
  contentPart?: { index: number; total: number };
  displayName: string | null;
  kind: string;
  replyToSequence: string | null;
  sentAt: string;
  sequence: string;
  username: string | null;
}

function tooLarge(): AppError {
  return new AppError(
    "AGENT_SCHEDULE_HISTORY_SNAPSHOT_TOO_LARGE",
    "История группы за выбранный период превышает безопасный размер автоматизации",
  );
}

function splitEntry(entry: ScheduledGroupHistoryEntry): ScheduledGroupHistoryEntry[] {
  if (entry.content === null || entry.content.length <= CONTENT_PART_MAX_CHARACTERS) return [entry];
  const total = Math.ceil(entry.content.length / CONTENT_PART_MAX_CHARACTERS);
  return Array.from({ length: total }, (_value, index) => ({
    ...entry,
    content: entry.content!.slice(
      index * CONTENT_PART_MAX_CHARACTERS,
      (index + 1) * CONTENT_PART_MAX_CHARACTERS,
    ),
    contentPart: { index: index + 1, total },
  }));
}

export function chunkScheduledGroupHistory(
  entries: readonly ScheduledGroupHistoryEntry[],
): ScheduledGroupHistoryEntry[][] {
  if (entries.length > SNAPSHOT_MAX_ENTRIES) throw tooLarge();
  const contentCharacters = entries.reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0);
  if (contentCharacters > SNAPSHOT_MAX_CONTENT_CHARACTERS) throw tooLarge();

  const chunks: ScheduledGroupHistoryEntry[][] = [];
  let current: ScheduledGroupHistoryEntry[] = [];
  for (const entry of entries.flatMap(splitEntry)) {
    const candidate = [...current, entry];
    if (
      current.length > 0 &&
      (candidate.length > CHUNK_MAX_ENTRIES || JSON.stringify(candidate).length > CHUNK_MAX_CHARACTERS)
    ) {
      chunks.push(current);
      current = [entry];
      continue;
    }
    if (JSON.stringify(candidate).length > CHUNK_MAX_CHARACTERS) throw tooLarge();
    current = candidate;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
