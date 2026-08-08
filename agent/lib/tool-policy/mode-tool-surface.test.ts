/**
 * Mode-scoped tool surface tests.
 *
 * Constructs covered:
 * - Each trust zone emits exactly its own application tools and nothing from another zone.
 * - An external group emits guarded file tools, granted capabilities, and framework denials.
 * - Granted capabilities re-check the live policy at execution and stay action-level for memory.
 * - HITL approval configuration survives dynamic emission.
 */
import type { SessionAuth } from "eve/context";
import type { SkillDefinition } from "eve/skills";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import {
  FAMILY_ONLY_TOOL_NAMES,
  PRIVATE_ONLY_TOOL_NAMES,
  TRUSTED_MODE_TOOL_NAMES,
  buildModeToolSurface,
} from "./mode-tool-surface.js";
import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  EXTERNAL_GROUP_TOOL_NAMES,
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

function names(input: Parameters<typeof buildModeToolSurface>[0]): string[] {
  return Object.keys(buildModeToolSurface(input)).sort();
}

const POHUY_SKILL = { description: "pohuy", markdown: "# pohuy" } as SkillDefinition;

function externalAuth(toolAllowlist: readonly string[]): SessionAuth {
  return {
    current: {
      attributes: {
        familyId: "family-1",
        groupId: "group-1",
        groupType: "external",
        role: "external",
        toolAllowlist,
      },
      authenticator: "telegram",
      principalId: "telegram:101",
      principalType: "user",
    },
    initiator: null,
  };
}

describe("trusted mode tool surfaces", () => {
  it("gives a private chat the shared tools plus owner administration only", () => {
    expect(names({ environment: "private" })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES].sort(),
    );
  });

  it("exposes R3 profile policy and provenance only in the intended trust zones", () => {
    const privateNames = names({ environment: "private" });
    const familyNames = names({ environment: "family" });
    const externalNames = names({ capabilities: new Set(), environment: "external", skills: {} });

    expect(privateNames).toEqual(expect.arrayContaining([
      "get_memory_source",
      "list_memory_threads",
      "manage_memory_approval",
      "manage_memory_thread",
      "manage_profile_projection",
      "read_memory_thread",
      "read_profile_view",
      "search_memory_threads",
    ]));
    expect(familyNames).toEqual(expect.arrayContaining([
      "list_memory_threads",
      "manage_memory_approval",
      "manage_memory_thread",
      "read_memory_thread",
      "read_profile_view",
      "search_memory_threads",
    ]));
    expect(familyNames).not.toContain("get_memory_source");
    expect(externalNames).toEqual(expect.arrayContaining([
      "manage_memory_approval",
      "read_profile_view",
    ]));
  });

  it("gives a family group the shared tools plus group history and attachments only", () => {
    expect(names({ environment: "family" })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES].sort(),
    );
  });

  it("never exposes another zone's tools", () => {
    const privateNames = names({ environment: "private" });
    const familyNames = names({ environment: "family" });

    for (const familyOnly of FAMILY_ONLY_TOOL_NAMES) {
      expect(privateNames, `private must not expose ${familyOnly}`).not.toContain(familyOnly);
    }
    for (const privateOnly of PRIVATE_ONLY_TOOL_NAMES) {
      expect(familyNames, `family must not expose ${privateOnly}`).not.toContain(privateOnly);
    }
  });

  it("emits no denial stubs in a trusted zone", () => {
    for (const environment of ["private", "family"] as const) {
      for (const denied of FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS) {
        expect(names({ environment }), `${environment} must not override ${denied}`)
          .not.toContain(denied);
      }
    }
  });

  it("keeps HITL approval configuration after dynamic emission", () => {
    const surface = buildModeToolSurface({ environment: "private" });

    for (const toolName of ["manage_reminder", "manage_agent_schedule", "manage_family_invitation"]) {
      expect(
        (surface[toolName] as unknown as { approval?: unknown }).approval,
        `${toolName} must keep its approval policy`,
      ).toBeDefined();
    }
  });
});

describe("external group tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(
      async (identity, capability) => {
        const allowed = await loadCurrentExternalGroupCapabilities(identity);
        if (!allowed.has(capability)) throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
      },
    );
  });

  it("emits only guarded baseline tools and framework denials without a grant", () => {
    expect(names({ capabilities: new Set(), environment: "external", skills: {} })).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
        "load_skill",
        "manage_memory_approval",
        "read_profile_view",
      ].sort(),
    );
  });

  it("makes load_skill executable only when the current turn has a granted skill", async () => {
    const denied = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
      skills: {},
    }).load_skill!;
    const granted = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
      skills: { pohuy: POHUY_SKILL },
    }).load_skill!;

    await expect(denied.execute({}, {} as never)).rejects.toThrowError(
      /AGENT_GROUP_TOOL_FORBIDDEN/u,
    );
    expect(denied.description).toMatch(/недоступен/iu);
    expect(granted.description).toMatch(/available skill/iu);
  });

  it("overrides native workspace file tools only in the external group surface", () => {
    const surface = buildModeToolSurface({ capabilities: new Set(), environment: "external", skills: {} });

    for (const nativeTool of ["glob", "grep", "read_file", "write_file"]) {
      expect(surface).toHaveProperty(nativeTool);
      expect(buildModeToolSurface({ environment: "private" })).not.toHaveProperty(nativeTool);
      expect(buildModeToolSurface({ environment: "family" })).not.toHaveProperty(nativeTool);
    }
    expect(surface).toHaveProperty("bash");
  });

  it("emits no application tool outside the effective allowlist", () => {
    const applicationNames = new Set([
      ...TRUSTED_MODE_TOOL_NAMES,
      ...PRIVATE_ONLY_TOOL_NAMES,
      ...FAMILY_ONLY_TOOL_NAMES,
    ]);
    const grantable = new Set<string>([
      ...EXTERNAL_GROUP_TOOL_NAMES.map((name) => name.replace(/\..*$/u, "")),
    ]);
    const alwaysExternal = new Set(["manage_memory_approval", "read_profile_view"]);

    for (const emitted of names({ capabilities: new Set(), environment: "external", skills: {} })) {
      expect(
        applicationNames.has(emitted) && !grantable.has(emitted) && !alwaysExternal.has(emitted),
      ).toBe(false);
    }
  });

  it("emits a granted capability but always denies provider-native search", () => {
    expect(names({ capabilities: new Set(["remember"]), environment: "external", skills: {} }))
      .toContain("remember");
    expect(names({ capabilities: new Set(), environment: "external", skills: {} }))
      .toContain("web_search");
    expect(names({ capabilities: new Set(["web_fetch"]), environment: "external", skills: {} }))
      .toContain("web_fetch");
  });

  it("surfaces constrained group file removal only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external", skills: {} }))
      .not.toContain("remove_group_file");
    expect(names({ capabilities: new Set(["remove_group_file"]), environment: "external", skills: {} }))
      .toContain("remove_group_file");
  });

  it("denies every framework built-in an external group must not reach", async () => {
    const surface = buildModeToolSurface({ capabilities: new Set(), environment: "external", skills: {} });

    for (const toolName of ["ask_question", "bash", "todo", "web_fetch"]) {
      await expect(
        surface[toolName]!.execute({}, {} as never),
        `${toolName} must be denied`,
      ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    }
  });

  it("denies a capability revoked after descriptor resolution despite a stale auth grant", async () => {
    const surface = buildModeToolSurface({ capabilities: new Set(["remember"]), environment: "external", skills: {} });
    const staleContext = { session: { auth: externalAuth(["remember"]) } } as never;

    await expect(surface.remember!.execute({}, staleContext)).rejects.toThrowError(
      /AGENT_GROUP_TOOL_FORBIDDEN/,
    );
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it.each(["deleted", "retyped"])(
    "denies a descriptor resolved before the group is %s",
    async () => {
      const surface = buildModeToolSurface({
        capabilities: new Set(["send_workspace_file"]),
        environment: "external",
        skills: {},
      });
      const staleContext = {
        session: { auth: externalAuth(["send_workspace_file"]) },
      } as never;

      // The live repository represents both a missing row and a non-external row as deny-all.
      loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set());

      await expect(surface.send_workspace_file!.execute({}, staleContext)).rejects.toThrowError(
        /AGENT_GROUP_TOOL_FORBIDDEN/,
      );
    },
  );

  it("fails closed when execution-time policy lookup fails", async () => {
    const surface = buildModeToolSurface({ capabilities: new Set(["remember"]), environment: "external", skills: {} });
    const staleContext = { session: { auth: externalAuth(["remember"]) } } as never;
    loadCurrentExternalGroupCapabilities.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(surface.remember!.execute({}, staleContext)).rejects.toThrowError(
      /database unavailable/,
    );
  });

  it("enforces action-level capabilities inside manage_memory", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory.undo"]),
      environment: "external",
      skills: {},
    });
    const context = { session: { auth: externalAuth(["manage_memory.undo"]) } } as never;
    loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set(["manage_memory.undo"]));

    expect(surface).toHaveProperty("manage_memory");
    await expect(
      surface.manage_memory!.execute(
        { action: "delete", id: "00000000-0000-4000-8000-000000000001" },
        context,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("keeps memory-thread lifecycle action-level and re-checks the live external policy", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory_thread.complete"]),
      environment: "external",
      skills: {},
    });
    const revoked = { session: { auth: externalAuth([]) } } as never;

    expect(surface).toHaveProperty("manage_memory_thread");
    await expect(surface.manage_memory_thread!.execute({
      action: "complete",
      authority: "current_user_statement",
      sourceEntryRefs: ["entry_0123456789abcdef0123456789abcdef"],
      threadRef: "thread_0123456789abcdef0123456789abcdef",
    }, revoked)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
  });

  it("denies every capability when the trusted snapshot is corrupt", () => {
    expect(names({
      capabilities: new Set(["unknown_tool"] as unknown as ExternalGroupToolName[]),
      environment: "external",
      skills: {},
    })).toEqual([
      ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
      ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      "load_skill",
      "manage_memory_approval",
      "read_profile_view",
    ].sort());
  });

  it("exposes only group scope in external shared-tool schemas and descriptions", () => {
    const external = buildModeToolSurface({
      capabilities: new Set([
        "inspect_workspace_image",
        "list_memories",
        "list_memory_threads",
        "remember",
        "send_workspace_file",
      ]),
      environment: "external",
      skills: {},
    });

    const inputs = {
      inspect_workspace_image: { path: "image.png", question: "Что изображено?" },
      list_memories: {},
      list_memory_threads: {},
      remember: {
        content: "Проверка",
        kind: "fact",
        sensitivity: "normal",
      },
      send_workspace_file: { path: "result.pdf", presentation: "document" },
    } as const;
    for (const [toolName, input] of Object.entries(inputs)) {
      const tool = external[toolName]!;
      const schema = tool.inputSchema as z.ZodType;
      expect(schema.safeParse({ ...input, scope: "group" }).success, toolName).toBe(true);
      expect(schema.safeParse({ ...input, scope: "personal" }).success, toolName).toBe(false);
      expect(schema.safeParse({ ...input, scope: "family" }).success, toolName).toBe(false);
      expect(tool.description, toolName).not.toMatch(/personal|family/iu);
      expect(tool.description, toolName).toMatch(/group|групп/iu);
    }

    const trustedRemember = buildModeToolSurface({ environment: "private" }).remember!;
    const trustedSchema = trustedRemember.inputSchema as z.ZodType;
    expect(trustedSchema.safeParse({
      content: "Проверка",
      kind: "fact",
      scope: "personal",
      sensitivity: "normal",
    }).success).toBe(true);
  });
});
