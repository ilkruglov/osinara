/**
 * Scheduled external-group history chunking tests.
 *
 * Constructs covered:
 * - Every retained entry remains in chronological order across bounded model chunks.
 * - Oversized message content is split into explicit parts without truncation.
 * - Snapshot entry limits fail closed instead of returning a partial week.
 */
import { describe, expect, it } from "vitest";

import {
  chunkScheduledGroupHistory,
  type ScheduledGroupHistoryEntry,
} from "./scheduled-group-history-chunker.js";

function entry(sequence: number, content = `Сообщение ${sequence}`): ScheduledGroupHistoryEntry {
  return {
    actor: "user",
    content,
    displayName: "Участник",
    kind: "text",
    replyToSequence: null,
    sentAt: "2026-08-09T10:00:00.000Z",
    sequence: String(sequence),
    username: "member",
  };
}

describe("scheduled group history chunker", () => {
  it("preserves chronology across entry-bounded chunks", () => {
    const chunks = chunkScheduledGroupHistory(
      Array.from({ length: 51 }, (_, index) => entry(index + 1)),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks.flat().map((item) => item.sequence)).toEqual(
      Array.from({ length: 51 }, (_, index) => String(index + 1)),
    );
  });

  it("splits one oversized message without dropping content", () => {
    const content = "я".repeat(20_000);
    const chunks = chunkScheduledGroupHistory([entry(1, content)]);
    const parts = chunks.flat();

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((item) => item.content).join("")).toBe(content);
    expect(parts.map((item) => item.contentPart)).toEqual(
      parts.map((_item, index) => ({ index: index + 1, total: parts.length })),
    );
  });

  it("rejects more entries than the retained snapshot contract permits", () => {
    expect(() => chunkScheduledGroupHistory(
      Array.from({ length: 1_001 }, (_, index) => entry(index + 1)),
    )).toThrowError(/AGENT_SCHEDULE_HISTORY_SNAPSHOT_TOO_LARGE/u);
  });
});
