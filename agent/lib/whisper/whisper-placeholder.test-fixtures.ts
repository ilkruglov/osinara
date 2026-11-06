/**
 * In-memory whisper placeholders for unit tests: the same transitions and settlements as the
 * table (`whisper-placeholder-repository.ts`, covered against PostgreSQL in its integration test).
 */
import { vi } from "vitest";

import type {
  DueWhisperPlaceholder,
  StaleWhisperPlaceholder,
  WhisperPlaceholderContent,
  WhisperPlaceholderKey,
  WhisperPlaceholderRepository,
  WhisperPlaceholderStatus,
} from "./whisper-placeholder-repository.js";
import { WHISPER_PLACEHOLDER_MAX_ATTEMPTS } from "./whisper-placeholder-repository.js";

export interface MemoryPlaceholder {
  attemptCount: number;
  lastErrorCode: string | null;
  pendingContent: WhisperPlaceholderContent | null;
  status: WhisperPlaceholderStatus;
}

export const PLACEHOLDER_KEY: WhisperPlaceholderKey = { chatId: "-1001", placeholderMessageId: 31, receiverUserId: "101" };

const id = (key: WhisperPlaceholderKey) => `${key.chatId}:${key.placeholderMessageId}:${key.receiverUserId}`;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function memoryPlaceholders(options: { stale?: StaleWhisperPlaceholder[] } = {}) {
  const rows = new Map<string, MemoryPlaceholder & { key: WhisperPlaceholderKey }>();
  const repository: WhisperPlaceholderRepository = {
    claimDue: vi.fn(async (limit: number): Promise<DueWhisperPlaceholder[]> =>
      [...rows.values()].filter((row) => row.pendingContent !== null).slice(0, limit).map((row) => ({
        ...row.key, attemptCount: row.attemptCount, content: row.pendingContent!, status: row.status,
      }))),
    listStale: vi.fn(async () => options.stale ?? []),
    purge: vi.fn(async () => 0),
    record: vi.fn(async (input: WhisperPlaceholderKey & { updateId: string }) => {
      const key = { chatId: input.chatId, placeholderMessageId: input.placeholderMessageId, receiverUserId: input.receiverUserId };
      if (!rows.has(id(key))) rows.set(id(key), { attemptCount: 0, key, lastErrorCode: null, pendingContent: null, status: "open" });
    }),
    settle: vi.fn(async (key, change, settlement) => {
      const row = rows.get(id(key));
      if (!row || row.status !== change.to || !same(row.pendingContent, change.content)) return "superseded" as const;
      if (settlement.outcome !== "retry") {
        row.pendingContent = null;
        row.lastErrorCode = settlement.outcome === "refused" ? settlement.errorCode : null;
        return "final" as const;
      }
      row.attemptCount += 1;
      row.lastErrorCode = settlement.errorCode;
      if (row.attemptCount >= WHISPER_PLACEHOLDER_MAX_ATTEMPTS) row.pendingContent = null;
      return row.pendingContent === null ? "final" as const : "waiting" as const;
    }),
    transition: vi.fn(async (key, change) => {
      const row = rows.get(id(key));
      if (!row) return "missing" as const;
      if (!change.from.includes(row.status)) return "refused" as const;
      Object.assign(row, { attemptCount: 0, lastErrorCode: null, pendingContent: change.content, status: change.to });
      return "applied" as const;
    }),
  };
  return {
    repository,
    row: (key: WhisperPlaceholderKey = PLACEHOLDER_KEY) => rows.get(id(key)),
    seed(status: WhisperPlaceholderStatus = "open", key: WhisperPlaceholderKey = PLACEHOLDER_KEY) {
      rows.set(id(key), { attemptCount: 0, key, lastErrorCode: null, pendingContent: null, status });
    },
  };
}

export function placeholderApi() {
  return {
    delete: vi.fn().mockResolvedValue({ ok: true }),
    edit: vi.fn().mockResolvedValue({ ok: true }),
  };
}
