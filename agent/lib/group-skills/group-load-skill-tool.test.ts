/**
 * Execution-time external-group skill authorization tests.
 *
 * Constructs covered:
 * - The Eve loader runs only for a safe skill present in the current live group policy.
 * - Revoked, unknown and malformed requests fail before native skill loading.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import { createExternalGroupLoadSkillTool } from "./group-load-skill-tool.js";

function context(): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes: { groupId: "group-1" },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
      },
    },
  } as unknown as ToolContext;
}

describe("external group load_skill", () => {
  it("delegates only after a live grant check", async () => {
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set(["pohuy"]));
    const tool = createExternalGroupLoadSkillTool({ executeNative, loadGroupSkillAllowlist });

    await expect(tool.execute({ skill: "pohuy" }, context())).resolves.toEqual({ loaded: true });
    expect(loadGroupSkillAllowlist).toHaveBeenCalledWith("group-1");
    expect(executeNative).toHaveBeenCalledOnce();
  });

  it("denies a revoked grant and an unknown skill before delegation", async () => {
    const executeNative = vi.fn();
    const loadGroupSkillAllowlist = vi.fn().mockResolvedValue(new Set());
    const tool = createExternalGroupLoadSkillTool({ executeNative, loadGroupSkillAllowlist });

    await expect(tool.execute({ skill: "pohuy" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    await expect(tool.execute({ skill: "unknown" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(executeNative).not.toHaveBeenCalled();
  });
});
