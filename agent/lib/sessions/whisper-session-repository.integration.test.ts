/**
 * Whisper sessions in PostgreSQL.
 *
 * Constructs covered:
 * - A whisper gets its own session next to the group's active canonical one: the database admits
 *   one active canonical session per group topic and per thread, so a whisper is never canonical.
 * - It shares the group's sandbox thread (the group workspace) and never touches the group session.
 * - A whisper session ends with its turn; the next whisper starts a fresh one on the same thread,
 *   with or without a group session in the topic, and never reuses a continuation token.
 * - A group session that starts after a whisper is the group's first, not a replacement of it.
 * - Two people's whispers never share a session.
 */
import { afterAll, beforeEach, expect, it } from "vitest";
import { describe } from "vitest";

import { closeDatabase, database } from "../database.js";
import { sessionRepository } from "./session-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;
const NOW = new Date("2026-11-06T18:00:00.000Z");

async function fixture() {
  const family = await database().query<{ id: string }>(
    "INSERT INTO families (name) VALUES ('Whisper') RETURNING id",
  );
  const group = await database().query<{ id: string }>(
    `INSERT INTO telegram_groups (family_id, telegram_chat_id, title, type, message_mode)
     VALUES ($1, '-100-whisper', 'Whisper', 'family_private', 'addressed_only') RETURNING id`,
    [family.rows[0]!.id],
  );
  return { familyId: family.rows[0]!.id, groupId: group.rows[0]!.id };
}

function input(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "canonical" | "whisper",
  token: string,
) {
  return {
    baseContinuationToken: token,
    familyId: f.familyId,
    groupId: f.groupId,
    kind,
    now: NOW,
    scope: "family" as const,
    telegramForumTopicId: null,
    userId: null,
  };
}

describeWithDatabase("whisper session repository", () => {
  beforeEach(async () => {
    await database().query(
      "TRUNCATE audit_events, conversation_session_routes, conversation_sessions, conversation_route_generations, telegram_groups, families CASCADE",
    );
  });
  afterAll(closeDatabase);

  it("opens a whisper session beside the group's canonical one on the group's thread", async () => {
    const f = await fixture();
    const group = await sessionRepository.prepareTurn(
      input(f, "canonical", `osinara:group:${f.groupId}:main`),
    );

    const whisper = await sessionRepository.prepareTurn(
      input(f, "whisper", `osinara:whisper:${f.groupId}:main:101`),
    );

    expect(whisper.id).not.toBe(group.id);
    expect(whisper.continuationToken).not.toBe(group.continuationToken);
    expect(whisper.sandboxSessionId).toBe(group.sandboxSessionId);
    const again = await sessionRepository.prepareTurn(
      input(f, "canonical", `osinara:group:${f.groupId}:main`),
    );
    expect(again.id).toBe(group.id);
  });

  it("ends a whisper session with its turn and opens a fresh one for the next whisper", async () => {
    const f = await fixture();
    const group = await sessionRepository.prepareTurn(
      input(f, "canonical", `osinara:group:${f.groupId}:main`),
    );
    const first = await sessionRepository.prepareTurn(
      input(f, "whisper", `osinara:whisper:${f.groupId}:main:101`),
    );
    await sessionRepository.bindEveSession(first.id, "eve-whisper-1");
    await sessionRepository.recordTurnCompleted(first.id, "eve-whisper-1", false);

    const second = await sessionRepository.prepareTurn(
      input(f, "whisper", `osinara:whisper:${f.groupId}:main:101`),
    );

    expect(second.id).not.toBe(first.id);
    expect(second.continuationToken).not.toBe(first.continuationToken);
    expect(second.sandboxSessionId).toBe(group.sandboxSessionId);
    const rows = await database().query<{ id: string; retired: boolean }>(
      "SELECT id, retired_at IS NOT NULL AS retired FROM conversation_sessions WHERE id = ANY($1::uuid[])",
      [[group.id, first.id]],
    );
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.retired]))).toEqual({
      [group.id]: false,
      [first.id]: true,
    });
  });

  it("opens one whisper after another in a topic that has no group session yet", async () => {
    const f = await fixture();
    const token = `osinara:whisper:${f.groupId}:main:101`;
    const first = await sessionRepository.prepareTurn(input(f, "whisper", token));
    await sessionRepository.bindEveSession(first.id, "eve-whisper-1");
    await sessionRepository.recordTurnCompleted(first.id, "eve-whisper-1", false);

    const second = await sessionRepository.prepareTurn(input(f, "whisper", token));

    expect(second.continuationToken).not.toBe(first.continuationToken);
    expect(second.sandboxSessionId).toBe(first.sandboxSessionId);
  });

  it("keeps whisper tokens unique when the group's session arrives between two whispers", async () => {
    const f = await fixture();
    const token = `osinara:whisper:${f.groupId}:main:101`;
    const first = await sessionRepository.prepareTurn(input(f, "whisper", token));
    await sessionRepository.bindEveSession(first.id, "eve-whisper-1");
    await sessionRepository.recordTurnCompleted(first.id, "eve-whisper-1", false);
    const group = await sessionRepository.prepareTurn(
      input(f, "canonical", `osinara:group:${f.groupId}:main`),
    );

    const second = await sessionRepository.prepareTurn(input(f, "whisper", token));

    expect(second.continuationToken).not.toBe(first.continuationToken);
    expect(second.sandboxSessionId).toBe(group.sandboxSessionId);
    const audit = await database().query(
      "SELECT 1 FROM audit_events WHERE event_type = 'session.canonical_replaced'",
    );
    expect(audit.rowCount).toBe(0);
  });

  it("keeps two people's whispers apart", async () => {
    const f = await fixture();

    const anna = await sessionRepository.prepareTurn(
      input(f, "whisper", `osinara:whisper:${f.groupId}:main:101`),
    );
    const ilya = await sessionRepository.prepareTurn(
      input(f, "whisper", `osinara:whisper:${f.groupId}:main:102`),
    );

    expect(ilya.id).not.toBe(anna.id);
  });
});
