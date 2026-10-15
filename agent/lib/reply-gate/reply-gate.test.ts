/**
 * Reply gate tests.
 *
 * Constructs covered:
 * - Only an interactive external-group turn is observed; a family chat, a scheduled run and a
 *   subagent are not.
 * - Without a key the verdict is `skipped`; without the trigger in the journal too.
 * - A scored decision lands with the exchange metrics, clamped scores and the vendor's model; the
 *   journal is read for the group and topic and Mia's just-sent ids are excluded.
 * - A vendor failure is `unavailable` with its code; an answer of the wrong type is a vendor
 *   contract break and lands as `unavailable` too; a repository failure is logged, never thrown.
 * - The response kind is recorded for any interactive turn with an identity.
 */
import { describe, expect, it, vi } from "vitest";

import type { JevClient } from "./jev-client.js";
import { JevClientError } from "./jev-client.js";
import { observeReplyGate, recordTurnResponseKind, type ReplyGateDependencies } from "./reply-gate.js";
import type { ReplyGateEntry } from "./reply-gate-state.js";

const versions = { modelConfigHash: "a".repeat(32), promptHash: "b".repeat(32), softwareVersion: "1.8.36" };

function context(attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "u1", principalType: "user" } },
      id: "eve-1",
      turn: { id: "turn-1" },
    },
    ...extra,
  } as unknown as Parameters<typeof observeReplyGate>[0];
}
const external = context({ familyId: "f1", groupId: "g1", groupType: "external", telegramChatId: "-100", telegramTimelineEntryId: "e2" });

const entries: ReplyGateEntry[] = [
  { actorId: "telegram:7", actorKind: "user", contentText: "Мия, что за кот?", entryId: "e1", messageKind: "text", replyToSequenceId: null, senderDisplayName: "Vadim", senderUsername: "v", sequenceId: "1", telegramMessageId: "11" },
  { actorId: "agent", actorKind: "agent_self", contentText: "Сиамский.", entryId: "ea", messageKind: "text", replyToSequenceId: "1", senderDisplayName: "Мия", senderUsername: null, sequenceId: "2", telegramMessageId: "12" },
  { actorId: "telegram:7", actorKind: "user", contentText: "а пёс?", entryId: "e2", messageKind: "text", replyToSequenceId: "2", senderDisplayName: "Vadim", senderUsername: "v", sequenceId: "3", telegramMessageId: "13" },
  { actorId: "agent", actorKind: "agent_self", contentText: "Такса.", entryId: "eb", messageKind: "text", replyToSequenceId: "3", senderDisplayName: "Мия", senderUsername: null, sequenceId: "4", telegramMessageId: "14" },
];

const decision = {
  answers: {
    asked: { type: "noul", noul: 0.9 },
    escalates: { type: "noul", noul: 0.05 },
    register: { type: "choice", choice: "answer", confidence: 0.8, probabilities: { answer: 0.8, banter: 0.1, off: 0.05, retort: 0.05 } },
    repeats_self: { type: "noul", noul: 1.2 },
    third_party: { type: "noul", noul: 0.1 },
    worth: { type: "score", score: 2.6, confidence: 0.5, probabilities: { "2": 0.4, "3": 0.6 } },
  },
  latencyMs: 180,
  model: "jev-1.13.0",
  usage: { inputTokens: 500, outputTokens: 40 },
} as const;

function dependencies(overrides: Partial<ReplyGateDependencies> = {}) {
  const deps = {
    client: { decide: vi.fn().mockResolvedValue(decision) } as unknown as JevClient,
    listRecent: vi.fn().mockResolvedValue(entries),
    recordResponseKind: vi.fn().mockResolvedValue(undefined),
    recordVerdict: vi.fn().mockResolvedValue(undefined),
    versions: () => versions,
    ...overrides,
  };
  return deps as ReplyGateDependencies & { listRecent: ReturnType<typeof vi.fn>; recordVerdict: ReturnType<typeof vi.fn>; recordResponseKind: ReturnType<typeof vi.fn> };
}
const input = { candidate: "Такса.", forumTopicId: null, groupId: "g1", ownMessageIds: ["14"] };
const identity = { chatKind: "external", eveSessionId: "eve-1", eveTurnId: "turn-1", familyId: "f1", telegramChatId: "-100", triggeringEntryId: "e2" };

describe("observeReplyGate", () => {
  it("scores an external-group answer with the exchange metrics and excludes Mia's just-sent messages", async () => {
    const deps = dependencies();
    await observeReplyGate(external, input, deps);

    expect(deps.listRecent).toHaveBeenCalledWith({ groupId: "g1", messageThreadId: null });
    const state = (deps.client as unknown as { decide: ReturnType<typeof vi.fn> }).decide.mock.calls[0]![0] as { recent: unknown[]; candidate: { text: string } };
    expect(state.recent).toHaveLength(2);
    expect(state.candidate.text).toBe("Такса.");
    expect(deps.recordVerdict).toHaveBeenCalledWith(identity, {
      errorCode: null, latencyMs: 180, metrics: { replyChainDepth: 1, sameAuthorRun: 1, triggerKind: "reply_to_mia" }, model: "jev-1.13.0",
      scores: { asked: 0.9, escalates: 0.05, register: "answer", registerConfidence: 0.8, repeatsSelf: 1, thirdParty: 0.1, worth: 2.6 },
      status: "scored", versions,
    });
  });

  it("measures over the contiguous recent block, not over reply ancestors the journal prepends", async () => {
    // An old parent of the current reply chain arrives first, with the replies between it and now missing.
    const ancestor: ReplyGateEntry = { ...entries[1]!, contentText: "Старый ответ Мии", entryId: "e0", replyToSequenceId: null, sequenceId: "0", telegramMessageId: "10" };
    const filler = Array.from({ length: 20 }, (_, index): ReplyGateEntry => ({
      ...entries[0]!, contentText: `реплика ${index}`, entryId: `f${index}`, replyToSequenceId: index === 0 ? "0" : null, sequenceId: String(100 + index), telegramMessageId: String(200 + index),
    }));
    const deps = dependencies({ listRecent: vi.fn().mockResolvedValue([ancestor, ...filler, ...entries]) });
    await observeReplyGate(external, input, deps);
    expect(deps.recordVerdict).toHaveBeenCalledWith(identity, expect.objectContaining({ metrics: { replyChainDepth: 1, sameAuthorRun: 1, triggerKind: "reply_to_mia" }, status: "scored" }));
  });

  it("observes only interactive external-group turns", async () => {
    const deps = dependencies();
    await observeReplyGate(context({ familyId: "f1", groupId: "g1", groupType: "family_private", telegramChatId: "-100" }), input, deps);
    await observeReplyGate(context({ familyId: "f1", groupType: "external", scheduledRunId: "r1" }, { channel: { kind: "subagent" } }), input, deps);
    expect(deps.recordVerdict).not.toHaveBeenCalled();
    expect(deps.listRecent).not.toHaveBeenCalled();
  });

  it("records a skipped gate without a key or without the trigger", async () => {
    const noKey = dependencies({ client: null });
    await observeReplyGate(external, input, noKey);
    expect(noKey.recordVerdict).toHaveBeenCalledWith(identity, expect.objectContaining({ errorCode: "AGENT_REPLY_GATE_NOT_CONFIGURED", status: "skipped" }));
    const noTrigger = dependencies({ listRecent: vi.fn().mockResolvedValue(entries.slice(0, 2)) });
    await observeReplyGate(external, input, noTrigger);
    expect(noTrigger.recordVerdict).toHaveBeenCalledWith(identity, expect.objectContaining({ errorCode: "AGENT_REPLY_GATE_TRIGGER_MISSING", status: "skipped" }));
  });

  it("records an unavailable vendor with its code and never throws into the turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = dependencies({ client: { decide: vi.fn().mockRejectedValue(new JevClientError("AGENT_JEV_UNAVAILABLE", "HTTP 529", 529)) } as unknown as JevClient });
    await observeReplyGate(external, input, down);
    expect(down.recordVerdict).toHaveBeenCalledWith(identity, expect.objectContaining({
      errorCode: "AGENT_JEV_UNAVAILABLE", metrics: { replyChainDepth: 1, sameAuthorRun: 1, triggerKind: "reply_to_mia" }, status: "unavailable",
    }));
    expect(warn.mock.calls[0]?.[0]).toContain("AGENT_REPLY_GATE_UNAVAILABLE");
    expect(warn.mock.calls[0]?.[0]).not.toContain("HTTP 529");
    const wrongType = dependencies({ client: { decide: vi.fn().mockResolvedValue({ ...decision, answers: { ...decision.answers, worth: decision.answers.asked } }) } as unknown as JevClient });
    await observeReplyGate(external, input, wrongType);
    expect(wrongType.recordVerdict).toHaveBeenCalledWith(identity, expect.objectContaining({ errorCode: "AGENT_JEV_RESPONSE_INVALID", status: "unavailable" }));
    // Whatever the vendor puts in place of an option name stays out of the logs.
    const leaking = dependencies({ client: { decide: vi.fn().mockResolvedValue({ ...decision, answers: { ...decision.answers, register: { ...decision.answers.register, choice: "ты куколд" } } }) } as unknown as JevClient });
    await observeReplyGate(external, input, leaking);
    expect(leaking.recordVerdict).toHaveBeenCalledWith(identity, expect.objectContaining({ errorCode: "AGENT_JEV_RESPONSE_INVALID" }));
    expect([...warn.mock.calls, ...error.mock.calls].some((call) => String(call[0]).includes("куколд"))).toBe(false);
    const broken = dependencies({ recordVerdict: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(observeReplyGate(external, input, broken)).resolves.toBeUndefined();
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_REPLY_GATE_FAILED");
  });
});

describe("recordTurnResponseKind", () => {
  it("records how the turn answered for any interactive turn and logs a failure", async () => {
    const deps = dependencies();
    await recordTurnResponseKind(external, "silent", deps);
    expect(deps.recordResponseKind).toHaveBeenCalledWith(identity, "silent", versions);
    await recordTurnResponseKind(context({ familyId: "f1", groupType: "external", scheduledRunId: "r1" }), "text", deps);
    expect(deps.recordResponseKind).toHaveBeenCalledTimes(1);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await recordTurnResponseKind(external, "text", dependencies({ recordResponseKind: vi.fn().mockRejectedValue(new Error("db")) }));
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_TURN_EVALUATION_RESPONSE_KIND_FAILED");
  });
});
