/**
 * Group skill policy tests.
 *
 * Constructs covered:
 * - Trusted skills are session-stable while external imagegen follows the turn capability snapshot.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));
vi.mock("../google-workspace/google-workspace-availability.js", () => ({
  GOOGLE_WORKSPACE_AVAILABLE: true,
}));

import { TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES } from "./trusted-google-workspace-skills.js";
import {
  resolveExternalTurnSkills,
  resolveTrustedSessionSkills,
} from "./group-skill-resolver.js";

function auth(
  environment: "external" | "family" | "private",
  toolAllowlist: string[] = [],
): SessionAuth {
  const group = environment !== "private";
  const caller = {
    attributes: {
      ...(group ? { groupId: "00000000-0000-4000-8000-000000000041" } : {}),
      ...(group ? { groupType: environment === "external" ? "external" : "family_private" } : {}),
      memoryScopes: environment === "private"
        ? ["personal", "family"]
        : [environment === "external" ? "group" : "family"],
      ...(group ? { toolAllowlist } : {}),
      telegramActorId: "101",
      telegramActorKind: "telegram_user",
      telegramChatType: group ? "group" : "private",
      telegramUserId: "101",
    },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { current: caller, initiator: caller } as SessionAuth;
}

describe("group skill policy", () => {
  it("does not resurrect a removed skill from an external auth snapshot", () => {
    const external = auth("external");
    Object.assign(external.current!.attributes, { skillAllowlist: ["pohuy"] });
    expect(resolveExternalTurnSkills(external)).toEqual({});
  });

  it("keeps trusted skills available in a private session", () => {
    const skills = resolveTrustedSessionSkills(auth("private"));
    expect(skills).toHaveProperty("imagegen");
    expect(skills).not.toHaveProperty("pohuy");
    expect(resolveTrustedSessionSkills(auth("private"), { subagent: true }))
      .not.toHaveProperty("imagegen");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) expect(skills).toHaveProperty(name);
  });

  it("ties external imagegen instructions to the generate_image capability", () => {
    expect(resolveExternalTurnSkills(auth("external", ["generate_image"])))
      .toHaveProperty("imagegen");
    expect(resolveExternalTurnSkills(auth("external", ["generate_image"]), {
      scheduledRun: true,
    })).not.toHaveProperty("imagegen");
    expect(resolveExternalTurnSkills(auth("external", ["generate_image"]), {
      subagent: true,
    })).not.toHaveProperty("imagegen");
    expect(resolveExternalTurnSkills(auth("external"))).not.toHaveProperty("imagegen");
  });

  it("does not advertise trusted-only Google Workspace skills to an external group", () => {
    const skills = resolveExternalTurnSkills(auth("external"));

    expect(skills).not.toHaveProperty("pohuy");
    for (const name of TRUSTED_GOOGLE_WORKSPACE_SKILL_NAMES) {
      expect(skills).not.toHaveProperty(name);
    }
  });
});
