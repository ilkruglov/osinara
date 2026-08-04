/**
 * Group skill policy tests.
 *
 * Constructs covered:
 * - The code-reviewed external catalog rejects unknown and duplicate persisted grants.
 * - Private chats see safe skills while groups receive only their live persisted allowlist.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

import {
  GROUP_SAFE_SKILL_NAMES,
  parseGroupSkillAllowlist,
} from "./group-skill-catalog.js";
import { createConversationSkillResolver } from "./group-skill-resolver.js";

function auth(environment: "external" | "family" | "private"): SessionAuth {
  const group = environment !== "private";
  const caller = {
    attributes: {
      ...(group ? { groupId: "00000000-0000-4000-8000-000000000041" } : {}),
      ...(group ? { groupType: environment === "external" ? "external" : "family_private" } : {}),
      memoryScopes: environment === "private"
        ? ["personal", "family"]
        : [environment === "external" ? "group" : "family"],
      telegramChatType: group ? "group" : "private",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

describe("group skill policy", () => {
  it("starts with only the reviewed pohuy skill and rejects corrupt persisted lists", () => {
    expect(GROUP_SAFE_SKILL_NAMES).toEqual(["pohuy"]);
    expect(parseGroupSkillAllowlist(["pohuy"])).toEqual(new Set(["pohuy"]));
    expect(parseGroupSkillAllowlist(["unknown"])).toBeNull();
    expect(parseGroupSkillAllowlist(["pohuy", "pohuy"])).toBeNull();
  });

  it("re-resolves current group grants without requiring a new session", async () => {
    const loadGroupSkillAllowlist = vi.fn()
      .mockResolvedValueOnce(new Set(["pohuy"]))
      .mockResolvedValueOnce(new Set());
    const resolve = createConversationSkillResolver({ loadGroupSkillAllowlist });

    await expect(resolve(auth("external"))).resolves.toHaveProperty("pohuy");
    await expect(resolve(auth("external"))).resolves.toEqual({});
    expect(loadGroupSkillAllowlist).toHaveBeenCalledTimes(2);
  });

  it("keeps safe skills available in private chat without a group database lookup", async () => {
    const loadGroupSkillAllowlist = vi.fn();
    const resolve = createConversationSkillResolver({ loadGroupSkillAllowlist });

    await expect(resolve(auth("private"))).resolves.toHaveProperty("pohuy");
    expect(loadGroupSkillAllowlist).not.toHaveBeenCalled();
  });
});
