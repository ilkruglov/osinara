/**
 * Trusted subagent orchestration prompt tests.
 *
 * Constructs covered:
 * - Root sessions receive bounded delegation criteria and a self-contained task-envelope contract.
 * - Child sessions receive worker-only rules that forbid recursive delegation and final delivery.
 */
import { describe, expect, it } from "vitest";

import delegationInstructions from "../../instructions/delegation.js";
import {
  ORCHESTRATOR_DELEGATION_RULES,
  SUBAGENT_WORKER_RULES,
} from "./delegation-fragments.js";

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

describe("trusted delegation prompt", () => {
  it("requires a complete task envelope and bounded fan-out", () => {
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("`task_worker`");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("не более трёх");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("роль");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("критерии готовности");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("outputSchema");
    expect(ORCHESTRATOR_DELEGATION_RULES).toContain("не видит историю");
  });

  it("keeps user-visible and mutating completion at the parent", () => {
    expect(SUBAGENT_WORKER_RULES).toMatch(/не запускай других сабагентов/iu);
    expect(SUBAGENT_WORKER_RULES).toMatch(/не отправляй файлы в Telegram/iu);
    expect(SUBAGENT_WORKER_RULES).toMatch(/не изменяй память/iu);
    expect(SUBAGENT_WORKER_RULES).toContain("верни оркестратору");
  });

  it("selects root and worker roles only inside trusted modes", async () => {
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
    expect(resolveDelegation("telegram", external)).toBeNull();
  });
});
