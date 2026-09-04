/**
 * Execution-time external-group skill authorization tests.
 *
 * Constructs covered:
 * - Removed custom skills, unknown names and malformed requests fail before native loading.
 * - The capability-coupled `imagegen` skill additionally requires its active model provider.
 * - Analyst knowledge skills open only with the live `web_search` grant.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

// The imagegen cases below describe the Codex-subscription runtime; the direct-provider denial has
// its own suite because the provider gate resolves once at module load.
vi.mock("../image-generation/image-generation-availability.js", () => ({
  IMAGE_GENERATION_AVAILABLE: true,
}));

import { createExternalGroupLoadSkillTool } from "./group-load-skill-tool.js";

function context(): ToolContext {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            familyId: "family-1",
            groupId: "group-1",
            groupType: "external",
            role: "external",
          },
          authenticator: "telegram",
          principalId: "user-1",
          principalType: "user",
        },
      },
    },
  } as unknown as ToolContext;
}

describe("external group load_skill", () => {
  it("does not resurrect a removed custom skill from a stale grant", async () => {
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const authorizeImageGeneration = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      authorizeKnowledgeSkills: vi.fn(),
      executeNative,
    });

    await expect(tool.execute({ skill: "pohuy" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(executeNative).not.toHaveBeenCalled();
    expect(authorizeImageGeneration).not.toHaveBeenCalled();
  });

  it("loads imagegen only after the live generate_image capability check", async () => {
    const authorizeImageGeneration = vi.fn().mockResolvedValue(undefined);
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      authorizeKnowledgeSkills: vi.fn(),
      executeNative,
    });

    await expect(tool.execute({ skill: "imagegen" }, context())).resolves.toEqual({ loaded: true });
    expect(authorizeImageGeneration).toHaveBeenCalledWith(expect.anything());
  });

  it("does not load imagegen when the live capability check rejects", async () => {
    const authorizeImageGeneration = vi.fn().mockRejectedValue(
      new Error("AGENT_GROUP_TOOL_FORBIDDEN"),
    );
    const executeNative = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration,
      authorizeKnowledgeSkills: vi.fn(),
      executeNative,
    });

    await expect(tool.execute({ skill: "imagegen" }, context()))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("loads an analyst skill only after the live web_search grant check", async () => {
    const authorizeKnowledgeSkills = vi.fn().mockResolvedValue(undefined);
    const executeNative = vi.fn().mockResolvedValue({ loaded: true });
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration: vi.fn(),
      authorizeKnowledgeSkills,
      executeNative,
    });

    await expect(tool.execute({ skill: "auto-analyst" }, context())).resolves.toEqual({ loaded: true });
    await expect(tool.execute({ skill: "policy-finance-analyst" }, context()))
      .resolves.toEqual({ loaded: true });
    expect(authorizeKnowledgeSkills).toHaveBeenCalledTimes(2);
  });

  it("keeps an analyst skill closed when the research grant is revoked", async () => {
    const executeNative = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration: vi.fn(),
      authorizeKnowledgeSkills: vi.fn().mockRejectedValue(new Error("AGENT_GROUP_TOOL_FORBIDDEN")),
      executeNative,
    });

    await expect(tool.execute({ skill: "auto-analyst" }, context()))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("denies a revoked grant and an unknown skill before delegation", async () => {
    const executeNative = vi.fn();
    const tool = createExternalGroupLoadSkillTool({
      authorizeImageGeneration: vi.fn(),
      authorizeKnowledgeSkills: vi.fn(),
      executeNative,
    });

    await expect(tool.execute({ skill: "pohuy" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    await expect(tool.execute({ skill: "unknown" }, context())).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(executeNative).not.toHaveBeenCalled();
  });
});
