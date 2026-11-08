/**
 * Delegation guidance per turn.
 *
 * Constructs covered:
 * - A trusted interactive root turn receives the orchestration rules.
 * - A whisper receives none: its `agent` delegation is refused like every acting tool.
 */
import { describe, expect, it } from "vitest";

import delegation from "../../instructions/delegation.js";

function resolve(attributes: Record<string, unknown>) {
  return delegation.events["turn.started"]?.(
    {} as never,
    {
      channel: { kind: "telegram" },
      messages: [],
      session: {
        auth: {
          current: {
            attributes,
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "s-1",
      },
    } as never,
  );
}

describe("delegation instructions", () => {
  it("guides delegation in a trusted family group", async () => {
    expect(await resolve({ groupType: "family_private", memoryScopes: ["family"] })).not.toBeNull();
  });

  it("gives a whisper no delegation guidance", async () => {
    expect(
      await resolve({
        groupType: "family_private",
        memoryScopes: ["family"],
        telegramWhisper: "true",
      }),
    ).toBeNull();
  });
});
