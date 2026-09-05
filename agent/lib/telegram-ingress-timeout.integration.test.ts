/** A timed-out turn must not lend its old boundary to the next queued message. */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramDrainContext } from "eve/channels/telegram";
import { closeDatabase, database } from "./database.js";
import { createMainAgentMemoryFixture } from "./memory-agent-write.integration-fixtures.js";
import { sessionRepository } from "./sessions/session-repository.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";

const describeWithDatabase = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Telegram queue after a session timeout", () => {
  beforeEach(async () => { await database().query("TRUNCATE users, families, telegram_ingress_queues, eve_session_event_cursors CASCADE"); });
  afterAll(closeDatabase);

  it("starts a fresh canonical session and consumes separate boundaries for the next two messages", async () => {
    const fixture = await createMainAgentMemoryFixture();
    for (const id of [1, 2, 3]) {
      await telegramIngressRepository.enqueue({
        continuationKey: "-1001::",
        payload: { update_id: id, message: {
          message_id: id, date: 1_700_000_000,
          chat: { id: -1001, type: "supergroup" },
          from: { id: 101, first_name: "User", is_bot: false },
          text: `@osinara_bot message ${id}`,
        } },
        updateId: String(id),
      });
    }
    const sessionIds: string[] = [];
    const events = new Map<string, { type: string }[]>();
    const dispatch = vi.fn(async () => {
      const appSession = await sessionRepository.prepareTurn({
        baseContinuationToken: `osinara:group:${fixture.groupId}:main`,
        familyId: fixture.familyId, groupId: fixture.groupId, kind: "canonical",
        now: new Date(), scope: "family", telegramForumTopicId: null, userId: null,
      });
      const id = `eve-${appSession.generation}`;
      await sessionRepository.bindEveSession(appSession.id, id);
      sessionIds.push(id);
      const history = events.get(id) ?? [];
      events.set(id, history);
      const first = sessionIds.length === 1;
      history.push({ type: "turn.started" });
      if (!first) history.push({ type: "turn.completed" }, { type: "session.waiting" });
      return {
        id,
        async getEventStream(options?: { startIndex?: number }) {
          return new ReadableStream({
            start(c) { for (const event of history.slice(options?.startIndex ?? 0)) c.enqueue(event); },
            // The old turn settles only after the observer timed out; this must not finish message 2.
            cancel() { if (first) history.push({ type: "session.waiting" }); },
          });
        },
      };
    });
    const ingress = createTelegramDurableIngress({
      acceptMedia: vi.fn(), authorizeVoice: vi.fn(), botUsername: "osinara_bot",
      handleSoftwareUpdateCallback: vi.fn(), leaseMilliseconds: 300,
      repository: telegramIngressRepository, transcribeVoice: vi.fn(),
    });
    let running: Promise<unknown> | undefined;
    await ingress.drain({
      dispatch: dispatch as unknown as TelegramDrainContext["dispatch"],
      waitUntil(task) { running = task; },
    });
    await running;

    expect(sessionIds).toEqual(["eve-0", "eve-1", "eve-1"]);
    expect((await database().query(
      "SELECT status, eve_session_id FROM telegram_ingress_updates ORDER BY update_id",
    )).rows).toEqual([
      { status: "failed", eve_session_id: "eve-0" },
      { status: "completed", eve_session_id: "eve-1" },
      { status: "completed", eve_session_id: "eve-1" },
    ]);
    expect(await telegramIngressRepository.sessionEventStreamCursor("eve-1")).toBe(6);
  });
});
