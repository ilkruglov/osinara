/**
 * Turn exchange observer tests.
 *
 * Constructs covered:
 * - Only an interactive external-group turn is measured; a family chat, a scheduled run and a
 *   subagent are not.
 * - The metrics are taken over the contiguous recent block of the group or topic journal, not
 *   over reply ancestors the journal prepends, with Mia's just-sent messages excluded.
 * - A trigger missing from the journal records nothing; a repository failure is logged, never thrown.
 * - The response kind is recorded for any interactive turn with an identity.
 */
import { describe, expect, it, vi } from "vitest";

import type { ExchangeEntry } from "./turn-exchange-metrics.js";
import {
  observeTurnExchange,
  recordTurnResponseKind,
  type TurnExchangeDependencies,
} from "./turn-exchange.js";

const versions = {
  modelConfigHash: "a".repeat(32),
  promptHash: "b".repeat(32),
  softwareVersion: "1.8.55",
};

function context(attributes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    session: {
      auth: {
        current: {
          attributes,
          authenticator: "telegram",
          principalId: "u1",
          principalType: "user",
        },
      },
      id: "eve-1",
      turn: { id: "turn-1" },
    },
    ...extra,
  } as unknown as Parameters<typeof observeTurnExchange>[0];
}
const external = context({
  familyId: "f1",
  groupId: "g1",
  groupType: "external",
  telegramChatId: "-100",
  telegramTimelineEntryId: "e2",
});

const entries: ExchangeEntry[] = [
  {
    actorId: "telegram:7",
    actorKind: "user",
    entryId: "e1",
    replyToSequenceId: null,
    sequenceId: "1",
    telegramMessageId: "11",
  },
  {
    actorId: "agent",
    actorKind: "agent_self",
    entryId: "ea",
    replyToSequenceId: "1",
    sequenceId: "2",
    telegramMessageId: "12",
  },
  {
    actorId: "telegram:7",
    actorKind: "user",
    entryId: "e2",
    replyToSequenceId: "2",
    sequenceId: "3",
    telegramMessageId: "13",
  },
  {
    actorId: "agent",
    actorKind: "agent_self",
    entryId: "eb",
    replyToSequenceId: "3",
    sequenceId: "4",
    telegramMessageId: "14",
  },
];

function dependencies(overrides: Partial<TurnExchangeDependencies> = {}) {
  const deps = {
    listRecent: vi.fn().mockResolvedValue(entries),
    recordMetrics: vi.fn().mockResolvedValue(undefined),
    recordResponseKind: vi.fn().mockResolvedValue(undefined),
    versions: () => versions,
    ...overrides,
  };
  return deps as TurnExchangeDependencies & {
    listRecent: ReturnType<typeof vi.fn>;
    recordMetrics: ReturnType<typeof vi.fn>;
    recordResponseKind: ReturnType<typeof vi.fn>;
  };
}
const input = { forumTopicId: null, groupId: "g1", ownMessageIds: ["14"] };
const identity = {
  chatKind: "external",
  eveSessionId: "eve-1",
  eveTurnId: "turn-1",
  familyId: "f1",
  telegramChatId: "-100",
  triggeringEntryId: "e2",
};

describe("observeTurnExchange", () => {
  it("records the exchange metrics of an external-group turn without Mia's just-sent messages", async () => {
    const deps = dependencies();
    await observeTurnExchange(external, input, deps);

    expect(deps.listRecent).toHaveBeenCalledWith({ groupId: "g1", messageThreadId: null });
    expect(deps.recordMetrics).toHaveBeenCalledWith(
      identity,
      { replyChainDepth: 1, sameAuthorRun: 1, triggerKind: "reply_to_mia" },
      versions,
    );
  });

  it("measures over the contiguous recent block, not over reply ancestors the journal prepends", async () => {
    // An old parent of the current reply chain arrives first, with the replies between it and now missing.
    const ancestor: ExchangeEntry = {
      ...entries[1]!,
      entryId: "e0",
      replyToSequenceId: null,
      sequenceId: "0",
      telegramMessageId: "10",
    };
    const filler = Array.from({ length: 20 }, (_, index): ExchangeEntry => ({
      ...entries[0]!,
      entryId: `f${index}`,
      replyToSequenceId: index === 0 ? "0" : null,
      sequenceId: String(100 + index),
      telegramMessageId: String(200 + index),
    }));
    const deps = dependencies({
      listRecent: vi.fn().mockResolvedValue([ancestor, ...filler, ...entries]),
    });
    await observeTurnExchange(external, input, deps);
    expect(deps.recordMetrics).toHaveBeenCalledWith(
      identity,
      { replyChainDepth: 1, sameAuthorRun: 1, triggerKind: "reply_to_mia" },
      versions,
    );
  });

  it("measures only interactive external-group turns with a trigger in the journal", async () => {
    const deps = dependencies();
    await observeTurnExchange(
      context({
        familyId: "f1",
        groupId: "g1",
        groupType: "family_private",
        telegramChatId: "-100",
      }),
      input,
      deps,
    );
    await observeTurnExchange(
      context(
        { familyId: "f1", groupType: "external", scheduledRunId: "r1" },
        { channel: { kind: "subagent" } },
      ),
      input,
      deps,
    );
    expect(deps.listRecent).not.toHaveBeenCalled();
    const noTrigger = dependencies({ listRecent: vi.fn().mockResolvedValue(entries.slice(0, 2)) });
    await observeTurnExchange(external, input, noTrigger);
    expect(noTrigger.recordMetrics).not.toHaveBeenCalled();
    expect(deps.recordMetrics).not.toHaveBeenCalled();
  });

  it("never throws into the turn", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = dependencies({ recordMetrics: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(observeTurnExchange(external, input, broken)).resolves.toBeUndefined();
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_TURN_EXCHANGE_FAILED");
  });
});

describe("recordTurnResponseKind", () => {
  it("records how the turn answered for any interactive turn and logs a failure", async () => {
    const deps = dependencies();
    await recordTurnResponseKind(external, "silent", deps);
    expect(deps.recordResponseKind).toHaveBeenCalledWith(identity, "silent", versions);
    await recordTurnResponseKind(
      context({ familyId: "f1", groupType: "external", scheduledRunId: "r1" }),
      "text",
      deps,
    );
    expect(deps.recordResponseKind).toHaveBeenCalledTimes(1);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await recordTurnResponseKind(
      external,
      "text",
      dependencies({ recordResponseKind: vi.fn().mockRejectedValue(new Error("db")) }),
    );
    expect(error.mock.calls.at(-1)?.[0]).toContain("AGENT_TURN_EVALUATION_RESPONSE_KIND_FAILED");
  });
});
