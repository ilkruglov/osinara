/**
 * Exchange metrics tests.
 *
 * Constructs covered:
 * - A trigger that replies to Mia is `reply_to_mia`, an addressed message is `addressed`.
 * - The reply chain depth counts Mia's messages along the chain; the same-author run counts Mia's
 *   consecutive latest replies to the triggering person and stops at a reply to someone else.
 * - The messages Mia just sent for this turn are not part of the measured exchange.
 * - An unknown trigger or a trigger authored by Mia yields nothing.
 */
import { describe, expect, it } from "vitest";

import { measureTurnExchange, type ExchangeEntry } from "./turn-exchange-metrics.js";

function entry(input: Partial<ExchangeEntry> & { seq: number }): ExchangeEntry {
  const mia = input.actorKind === "agent_self";
  return {
    actorId: mia ? "agent" : (input.actorId ?? "telegram:1"),
    actorKind: input.actorKind ?? "user",
    entryId: `e${input.seq}`,
    replyToSequenceId: input.replyToSequenceId ?? null,
    sequenceId: String(input.seq),
    telegramMessageId: String(1000 + input.seq),
  };
}

const vadim = { actorId: "telegram:1" };
const yuri = { actorId: "telegram:2" };

describe("measureTurnExchange", () => {
  it("measures the chain depth and the run of replies to the same person", () => {
    const entries = [
      entry({ ...vadim, seq: 1 }),
      entry({ actorKind: "agent_self", replyToSequenceId: "1", seq: 2 }),
      entry({ ...vadim, replyToSequenceId: "2", seq: 3 }),
      entry({ actorKind: "agent_self", replyToSequenceId: "3", seq: 4 }),
      entry({ ...yuri, seq: 5 }),
      entry({ ...vadim, replyToSequenceId: "4", seq: 6 }),
      entry({ actorKind: "agent_self", replyToSequenceId: "6", seq: 7 }),
      entry({ ...vadim, replyToSequenceId: "7", seq: 8 }),
    ];

    expect(measureTurnExchange({ entries, ownMessageIds: [], triggeringEntryId: "e8" })).toEqual({
      replyChainDepth: 3,
      sameAuthorRun: 3,
      triggerKind: "reply_to_mia",
    });
    // Mia's last reply went to Yuri: the run for Vadim is over even though he replied to her.
    const switched = [
      ...entries.slice(0, 7),
      entry({ actorKind: "agent_self", replyToSequenceId: "5", seq: 9 }),
      entries[7]!,
    ];
    expect(
      measureTurnExchange({ entries: switched, ownMessageIds: [], triggeringEntryId: "e8" })
        ?.sameAuthorRun,
    ).toBe(0);
  });

  it("recognises an addressed trigger and leaves out the messages Mia just sent", () => {
    const entries = [
      entry({ ...yuri, seq: 1 }),
      entry({ actorKind: "agent_self", replyToSequenceId: "1", seq: 2 }),
      entry({ ...vadim, seq: 3 }),
      // Sent for this very turn: counting it would make every turn a run of one.
      entry({ actorKind: "agent_self", replyToSequenceId: "3", seq: 4 }),
    ];

    expect(
      measureTurnExchange({ entries, ownMessageIds: ["1004"], triggeringEntryId: "e3" }),
    ).toEqual({ replyChainDepth: 0, sameAuthorRun: 0, triggerKind: "addressed" });
  });

  it("yields nothing without the trigger or for a trigger authored by Mia", () => {
    const entries = [entry({ actorKind: "agent_self", seq: 1 })];
    expect(measureTurnExchange({ entries, ownMessageIds: [], triggeringEntryId: "e1" })).toBeNull();
    expect(measureTurnExchange({ entries, ownMessageIds: [], triggeringEntryId: "e9" })).toBeNull();
  });
});
