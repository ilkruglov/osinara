/**
 * Reply gate state tests.
 *
 * Constructs covered:
 * - The excerpt names people, marks Mia and replies to her, clips long text, keeps only the last
 *   entries before the trigger and drops the messages Mia just sent for this turn.
 * - A trigger that replies to Mia is `reply_to_mia`, an addressed message is `addressed`.
 * - The reply chain depth counts Mia's messages along the chain; the same-author run counts Mia's
 *   consecutive latest replies to the triggering person and stops at a reply to someone else.
 * - An unknown trigger or a trigger authored by Mia yields nothing.
 */
import { describe, expect, it } from "vitest";

import { buildReplyGateState, type ReplyGateEntry } from "./reply-gate-state.js";

function entry(input: Partial<ReplyGateEntry> & { seq: number; text: string }): ReplyGateEntry {
  const mia = input.actorKind === "agent_self";
  return {
    actorId: mia ? "agent" : input.actorId ?? "telegram:1",
    actorKind: input.actorKind ?? "user",
    contentText: input.text,
    entryId: `e${input.seq}`,
    messageKind: "text",
    replyToSequenceId: input.replyToSequenceId ?? null,
    senderDisplayName: mia ? "Мия" : input.senderDisplayName ?? null,
    senderUsername: mia ? null : input.senderUsername ?? "vadim",
    sequenceId: String(input.seq),
    telegramMessageId: String(1000 + input.seq),
  };
}

const vadim = { actorId: "telegram:1", senderDisplayName: "Vadim" };
const yuri = { actorId: "telegram:2", senderDisplayName: "Yuri", senderUsername: "j_suleiman" };

describe("buildReplyGateState", () => {
  it("builds the excerpt around the triggering message and drops Mia's own just-sent messages", () => {
    const entries = [
      entry({ ...yuri, seq: 1, text: "Мия, что по шинам?" }),
      entry({ actorKind: "agent_self", replyToSequenceId: "1", seq: 2, text: "Зимние на следующей неделе." }),
      entry({ ...vadim, replyToSequenceId: "2", seq: 3, text: `${"а".repeat(400)}?` }),
      entry({ actorKind: "agent_self", replyToSequenceId: "3", seq: 4, text: "уже отправлено" }),
    ];
    const built = buildReplyGateState({ candidate: " Ответ \n\n Мии ", entries, ownMessageIds: ["1004"], triggeringEntryId: "e3" });

    expect(built?.state.recent).toEqual([
      { from: "Yuri", reply_to_mia: false, text: "Мия, что по шинам?" },
      { from: "Мия (бот)", reply_to_mia: false, text: "Зимние на следующей неделе." },
    ]);
    expect(built?.state.current.from).toBe("Vadim");
    expect(built?.state.current.reply_to_mia).toBe(true);
    expect(built?.state.current.text).toHaveLength(300);
    expect(built?.state.current.text.endsWith("…")).toBe(true);
    expect(built?.state.candidate).toEqual({ from: "Мия (бот)", text: "Ответ Мии" });
    expect(built?.metrics).toEqual({ replyChainDepth: 1, sameAuthorRun: 0, triggerKind: "reply_to_mia" });
  });

  it("measures the chain depth and the run of replies to the same person", () => {
    const entries = [
      entry({ ...vadim, seq: 1, text: "Мия, привет" }),
      entry({ actorKind: "agent_self", replyToSequenceId: "1", seq: 2, text: "Привет" }),
      entry({ ...vadim, replyToSequenceId: "2", seq: 3, text: "ты куколд" }),
      entry({ actorKind: "agent_self", replyToSequenceId: "3", seq: 4, text: "Диагноз оставь себе" }),
      entry({ ...yuri, seq: 5, text: "ыыы" }),
      entry({ ...vadim, replyToSequenceId: "4", seq: 6, text: "а Сергей гей?" }),
      entry({ actorKind: "agent_self", replyToSequenceId: "6", seq: 7, text: "Спроси у него" }),
      entry({ ...vadim, replyToSequenceId: "7", seq: 8, text: "ну ты же понимаешь" }),
    ];
    const built = buildReplyGateState({ candidate: "Понимаю", entries, ownMessageIds: [], triggeringEntryId: "e8" });

    expect(built?.metrics).toEqual({ replyChainDepth: 3, sameAuthorRun: 3, triggerKind: "reply_to_mia" });
    expect(built?.state.recent.map((message) => message.from)).toEqual(["Vadim", "Мия (бот)", "Vadim", "Мия (бот)", "Yuri", "Vadim", "Мия (бот)"]);
    // Mia's last reply went to Yuri: the run for Vadim is over even though he replied to her.
    const switched = [...entries.slice(0, 7), entry({ actorKind: "agent_self", replyToSequenceId: "5", seq: 9, text: "Смешно" }), entries[7]!];
    expect(buildReplyGateState({ candidate: "x", entries: switched, ownMessageIds: [], triggeringEntryId: "e8" })?.metrics.sameAuthorRun).toBe(0);
  });

  it("keeps only the last twelve entries before the trigger and recognises an addressed trigger", () => {
    const entries = [
      ...Array.from({ length: 15 }, (_, index) => entry({ ...yuri, seq: index + 1, text: `сообщение ${index + 1}` })),
      entry({ ...vadim, seq: 16, text: "Мия, рассуди" }),
    ];
    const built = buildReplyGateState({ candidate: "x", entries, ownMessageIds: [], triggeringEntryId: "e16" });

    expect(built?.state.recent).toHaveLength(12);
    expect(built?.state.recent[0]?.text).toBe("сообщение 4");
    expect(built?.metrics).toEqual({ replyChainDepth: 0, sameAuthorRun: 0, triggerKind: "addressed" });
  });

  it("yields nothing without the trigger or for a trigger authored by Mia", () => {
    const entries = [entry({ actorKind: "agent_self", seq: 1, text: "сама с собой" })];
    expect(buildReplyGateState({ candidate: "x", entries, ownMessageIds: [], triggeringEntryId: "e1" })).toBeNull();
    expect(buildReplyGateState({ candidate: "x", entries, ownMessageIds: [], triggeringEntryId: "e9" })).toBeNull();
  });
});
