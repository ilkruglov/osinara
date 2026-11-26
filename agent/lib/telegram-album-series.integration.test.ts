/**
 * Albums and series end to end on the test database (25-26 November 2026).
 *
 * Constructs covered:
 * - A group text, then an album whose second photo comes a second later: the drain wakes by itself
 *   and takes the text and the whole album as one series, and the address of the series stays
 *   on every member in the queue.
 * - A series of eleven messages: one turn for ten, the eleventh in the next.
 * - A private album of four with a failed third photo: the turn of the tail lists the files of the
 *   earlier photos from what the session has not seen, and a photo an earlier turn saw stays out.
 */
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TelegramDrainContext, TelegramMessage } from "eve/channels/telegram";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTelegramWorkspaceAttachmentImporter } from "./attachments/telegram-workspace-attachments.js";
import { conversationTimelineRepository } from "./conversation-timeline-repository.js";
import { closeDatabase, database } from "./database.js";
import { createTelegramDurableIngress } from "./telegram-durable-ingress.js";
import { telegramIngressRepository } from "./telegram-ingress-repository.js";
import { readTelegramSeriesMarker } from "./telegram-message-series.js";
import { unseenFileMessageIds } from "./telegram-series-attachments.js";
import { createWorkspaceBinaryRepository } from "./workspaces/workspace-binary-repository.js";
import { createWorkspaceRepository } from "./workspaces/workspace-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeWithDatabase = enabled && process.env.DATABASE_URL ? describe : describe.skip;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const roots: string[] = [];

interface Dispatched {
  role: string;
  updateId: string;
}

/** A drain whose turns end at once, recording each dispatch and its series role. */
function drainOnce(burst: { maxWaitMilliseconds: number; quietMilliseconds: number }) {
  const dispatched: Dispatched[] = [];
  const dispatch = async (update: {
    message: { messageId: string; raw: Record<string, unknown> };
  }) => {
    const role = readTelegramSeriesMarker(update.message.raw)?.role ?? "alone";
    dispatched.push({ role, updateId: update.message.messageId });
    if (role === "context") return undefined;
    return {
      getEventStream: async () =>
        new ReadableStream({
          start: (controller) => controller.enqueue({ type: "session.waiting" }),
        }),
      id: `session-${update.message.messageId}`,
    };
  };
  const ingress = createTelegramDurableIngress({
    acceptMedia: async () => true,
    authorizeVoice: async () => false,
    botUsername: "osinara_bot",
    handleSoftwareUpdateCallback: async () => false,
    leaseMilliseconds: 60_000,
    privateBurst: burst,
    repository: telegramIngressRepository,
    transcribeVoice: async () => "",
  });
  const tasks: Promise<unknown>[] = [];
  const context = {
    dispatch,
    waitUntil: (task: Promise<unknown>) => tasks.push(task),
  } as TelegramDrainContext;
  return { context, dispatched, ingress, tasks };
}

function queued(chat: Record<string, unknown>, updateId: number, extra: Record<string, unknown>) {
  return {
    continuationKey: `telegram:${String(chat.id)}`,
    payload: {
      message: {
        chat,
        date: 1_790_000_000,
        from: { first_name: "Женя", id: 7, is_bot: false },
        message_id: updateId,
        ...extra,
      },
      update_id: updateId,
    },
    updateId: String(updateId),
  };
}

describeWithDatabase("albums and series end to end", () => {
  beforeEach(async () => {
    await database().query(
      `TRUNCATE eve_session_event_cursors, telegram_ingress_ignored_updates,
         telegram_ingress_updates, telegram_ingress_continuation_aliases,
         telegram_ingress_queues CASCADE`,
    );
  });

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
    await closeDatabase();
  });

  it("takes a group text and the album after it as one addressed turn, waking by itself", async () => {
    const group = { id: -100, title: "Семья", type: "supergroup" };
    const photo = (id: number) => ({
      media_group_id: "album-1",
      photo: [{ file_id: `p${id}`, file_unique_id: `u${id}`, height: 1, width: 1 }],
    });
    const { context, dispatched, ingress, tasks } = drainOnce({
      maxWaitMilliseconds: 20_000,
      quietMilliseconds: 2_000,
    });
    await telegramIngressRepository.enqueue(queued(group, 5001, { text: "Мия, вот мои фото" }));
    await telegramIngressRepository.enqueue(queued(group, 5002, photo(5002)));

    await ingress.drain(context);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await telegramIngressRepository.enqueue(queued(group, 5003, photo(5003)));
    await Promise.all(tasks);

    expect(dispatched).toEqual([
      { role: "context", updateId: "5001" },
      { role: "context", updateId: "5002" },
      { role: "current", updateId: "5003" },
    ]);
    const marked = await database().query<{ update_id: string }>(
      `SELECT update_id::text FROM telegram_ingress_updates
        WHERE series_addressed ORDER BY update_id`,
    );
    expect(marked.rows.map((row) => row.update_id)).toEqual(["5001", "5002", "5003"]);
  }, 15_000);

  it("answers ten messages of a series in one turn and the eleventh in the next", async () => {
    const chat = { id: 7, type: "private" };
    for (let id = 6001; id <= 6011; id += 1) {
      await telegramIngressRepository.enqueue(queued(chat, id, { text: `часть ${id}` }));
    }
    const { context, dispatched, ingress, tasks } = drainOnce({
      maxWaitMilliseconds: 0,
      quietMilliseconds: 0,
    });

    await ingress.drain(context);
    await Promise.all(tasks);

    expect(dispatched.map((item) => item.role)).toEqual([
      ...Array.from({ length: 9 }, () => "context"),
      "current",
      "alone",
    ]);
    expect(dispatched.map((item) => item.updateId)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(6001 + index)),
    );
  });

  it("lists the earlier photos of a private album whose third photo failed", async () => {
    // Unique per run: the users table is not truncated between runs.
    const telegramUserId = String(randomInt(1_000_000_000, 9_000_000_000));
    const family = await database().query<{ id: string }>(
      "INSERT INTO families (name) VALUES ('Альбомы') RETURNING id",
    );
    const user = await database().query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ($1, 'Женя') RETURNING id",
      [telegramUserId],
    );
    await database().query(
      "INSERT INTO family_memberships (family_id, user_id, role) VALUES ($1, $2, 'owner')",
      [family.rows[0]!.id, user.rows[0]!.id],
    );
    const conversationId = (
      await database().query<{ id: string }>(
        "SELECT id FROM application_conversations WHERE telegram_chat_id = $1",
        [telegramUserId],
      )
    ).rows[0]!.id;
    const root = await mkdtemp(join(tmpdir(), "osinara-album-"));
    roots.push(root);
    const binaries = createWorkspaceBinaryRepository(root, createWorkspaceRepository(root));
    let downloadFails = false;
    const importer = createTelegramWorkspaceAttachmentImporter({
      download: async () => {
        if (downloadFails) throw new Error("download timed out");
        return PNG;
      },
      findBinaryWritesByKeyPrefixes: binaries.findBinaryWritesByKeyPrefixes,
      listFilesUnder: binaries.listFilesUnder,
      writeBinary: binaries.writeBinary,
    });
    const auth = {
      familyId: family.rows[0]!.id,
      groupId: null,
      groupType: null,
      role: "owner" as const,
      telegramChatType: "private" as const,
      userId: user.rows[0]!.id,
    };
    const message = (id: number, photo: boolean): TelegramMessage => ({
      attachments: photo
        ? [{ fileId: `f-${id}`, fileUniqueId: `u-${id}`, kind: "photo", mediaType: "image/jpeg" }]
        : [],
      caption: "",
      chat: { id: telegramUserId, type: "private" },
      from: { firstName: "Женя", id: telegramUserId, isBot: false },
      messageId: String(id),
      raw: photo ? { date: 1_764_000_000 + id, photo: [{}] } : { date: 1_764_000_000 + id },
      text: photo ? "" : "нарисуй меня в этом",
    });
    // What the handler does for a private message: journal it, then store its file.
    const receive = async (id: number, photo = true) => {
      const recorded = await conversationTimelineRepository.recordInbound(
        conversationId,
        message(id, photo),
      );
      if (photo) {
        await importer
          .persist({
            attachments: message(id, true).attachments,
            auth,
            chatId: telegramUserId,
            messageId: String(id),
            scope: "personal",
          })
          .catch(() => undefined);
      }
      return recorded;
    };
    // An earlier photo had its own turn: the session's cursor stands on it.
    const seen = await receive(20);
    await receive(31);
    await receive(32);
    downloadFails = true;
    await receive(33);
    downloadFails = false;
    await receive(34);
    const current = await receive(35, false);

    const unseen = await conversationTimelineRepository.listIncremental({
      afterSequence: seen.sequenceId,
      anchorEntryId: current.entryId,
      applicationSessionId: randomUUID(),
      beforeSequence: current.sequenceId,
      conversationId,
      limit: 99,
    });
    const ids = unseenFileMessageIds(unseen.entries, []);
    const stored = await importer.stored({
      auth,
      chatId: telegramUserId,
      messageIds: ids,
      scope: "personal",
    });

    expect(ids).toEqual(["31", "32", "33", "34"]);
    expect(stored.map((file) => file.telegramMessageId)).toEqual(["31", "32", "34"]);
  });
});
