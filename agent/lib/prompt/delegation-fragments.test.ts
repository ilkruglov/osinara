/**
 * Native child-agent orchestration prompt tests.
 *
 * Constructs covered:
 * - Root sessions receive bounded delegation criteria and a self-contained task-envelope contract.
 * - Durable-memory decisions stay with the root even when other trust-zone tools are inherited.
 * - Child copies receive no root-only orchestration guidance.
 */
import { describe, expect, it } from "vitest";

import delegationInstructions from "../../instructions/delegation.js";
import { ORCHESTRATOR_DELEGATION_RULES } from "./delegation-fragments.js";

function resolveDelegation(
  channelKind: "subagent" | "telegram",
  attributes: Record<string, unknown>,
) {
  return delegationInstructions.events["turn.started"]?.({} as never, {
    channel: { kind: channelKind },
    messages: [],
    session: {
      auth: {
        current: {
          attributes,
          authenticator: "telegram",
          principalId: "telegram:101",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } as never);
}

describe("native delegation prompt", () => {
  it("requires a complete task envelope and bounded fan-out", () => {
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("`agent`");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("не более трёх");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("роль");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("критерии готовности");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("outputSchema");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("не видит историю");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("root-owned `remember`");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("основной чат-агент");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("короткую отбивку");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("не обещай срок");
  });

  it("gives every root trust zone guidance but prevents recursive child delegation", () => {
    const trusted = { memoryScopes: ["personal", "family"], telegramChatType: "private" };
    const external = {
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
    };

    expect(resolveDelegation("telegram", trusted)).toMatchObject({
      markdown: ORCHESTRATOR_DELEGATION_RULES,
    });
    expect(resolveDelegation("subagent", trusted)).toBeNull();
    expect(resolveDelegation("telegram", external)).toMatchObject({
      markdown: ORCHESTRATOR_DELEGATION_RULES,
    });
  });
});
