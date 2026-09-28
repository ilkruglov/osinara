/**
 * Mode-scoped tool surface tests: external groups.
 *
 * Constructs covered:
 * - An external group emits guarded file tools, granted capabilities, and framework denials.
 * - Granted capabilities re-check the live policy at execution and stay action-level for memory.
 * - Native subagents stay unavailable externally.
 * Trusted zones live in `mode-tool-surface.trusted.test.ts`.
 */
import type { SessionAuth } from "eve/context";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

// The trusted matrix under test includes the Google tools, which exist only with OAuth credentials.
vi.mock("../google-workspace/google-workspace-availability.js", () => ({
  GOOGLE_WORKSPACE_AVAILABLE: true,
}));
vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import { FAMILY_ONLY_TOOL_NAMES, PRIVATE_ONLY_TOOL_NAMES, TRUSTED_MODE_TOOL_NAMES, buildModeToolSurface } from "./mode-tool-surface.js";

import { ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, EXTERNAL_GROUP_TOOL_NAMES, FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, type ExternalGroupToolName } from "./group-tool-catalog.js";

function names(input: Parameters<typeof buildModeToolSurface>[0]): string[] {
  return Object.keys(buildModeToolSurface(input)).sort();
}

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

describe("external group tool surface", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
    authorizeCurrentExternalGroupCapability.mockReset();
    authorizeCurrentExternalGroupCapability.mockImplementation(async (identity, capability) => {
      const allowed = await loadCurrentExternalGroupCapabilities(identity);
      if (!allowed.has(capability)) throw new Error("AGENT_GROUP_TOOL_FORBIDDEN");
    });
  });

  it("emits only guarded baseline tools and framework denials without a grant", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).toEqual(
      [...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, "load_skill", "manage_behavior_preference", "read_profile_view"].sort(),
    );
  });

  it("denies native child delegation in every interactive external group", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    expect(surface).toHaveProperty("agent");
    await expect(surface.agent!.execute({ message: "Run a long task" }, {} as never))
      .rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
  });

  it("keeps the fail-closed load_skill wrapper without the image capability and denies it in scheduled runs", async () => {
    const interactive = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    }).load_skill!;
    const scheduled = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
      scheduledRun: true,
    }).load_skill!;

    // The wrapper refuses a reserved static name before any lookup, so no database is needed.
    await expect(interactive.execute({ skill: "gws-gmail" }, {} as never)).rejects.toThrowError(
      /AGENT_GROUP_SKILL_FORBIDDEN/u,
    );
    expect(interactive.description).not.toMatch(/недоступен/iu);
    expect(scheduled.description).toMatch(/недоступен/iu);
  });

  it("overrides native workspace file tools only in the external group surface", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    for (const nativeTool of ["glob", "grep", "read_file", "write_file"] as const) {
      expect(surface).toHaveProperty(nativeTool);
      // Trusted zones keep the framework's own tool; only the external group gets a guarded one.
      for (const environment of ["private", "family"] as const) {
        expect(buildModeToolSurface({ environment })[nativeTool]?.description)
          .not.toBe(surface[nativeTool]!.description);
      }
    }
    expect(surface).toHaveProperty("bash");
  });

  it("emits no application tool outside the effective allowlist", () => {
    const applicationNames = new Set([...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES, ...FAMILY_ONLY_TOOL_NAMES]);
    const grantable = new Set<string>(EXTERNAL_GROUP_TOOL_NAMES.map((name) => name.replace(/\..*$/u, "")));
    const alwaysExternal = new Set(["manage_behavior_preference", "read_profile_view"]);

    for (const emitted of names({
      capabilities: new Set(),
      environment: "external",
    })) {
      expect(applicationNames.has(emitted) && !grantable.has(emitted) && !alwaysExternal.has(emitted)).toBe(false);
    }
  });

  it("emits local search only for trusted modes and an interactive external grant", () => {
    expect(
      names({
        capabilities: new Set(["remember"]),
        environment: "external",
      }),
    ).toContain("remember");
    expect(names({ capabilities: new Set(), environment: "external" })).toContain("web_search");
    expect(names({ environment: "private" })).toContain("web_search");
    expect(names({ environment: "family" })).toContain("web_search");
    const granted = buildModeToolSurface({ capabilities: new Set(["web_search"]), environment: "external" });
    expect(granted.web_search?.inputSchema).toBeInstanceOf(z.ZodObject);
    expect((granted.web_search!.inputSchema as z.ZodObject).safeParse({ query: "Eve documentation" }).success).toBe(true);
    expect((granted.web_search!.inputSchema as z.ZodObject).safeParse({}).success).toBe(false);
    expect(names({ capabilities: new Set(["web_search"]), environment: "external", scheduledRun: true } as never)).toContain("web_search");
    expect(
      names({
        capabilities: new Set(["web_fetch"]),
        environment: "external",
      }),
    ).toContain("web_fetch");
  });

  it("surfaces constrained group file removal only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).not.toContain("remove_group_file");
    expect(
      names({
        capabilities: new Set(["remove_group_file"]),
        environment: "external",
      }),
    ).toContain("remove_group_file");
  });

  it("surfaces Telegram text attachment import only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).not.toContain("import_telegram_attachment");
    expect(
      names({
        capabilities: new Set(["import_telegram_attachment"]),
        environment: "external",
      }),
    ).toContain("import_telegram_attachment");
  });

  it("keeps external tool descriptions free of artificial punctuation", () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(EXTERNAL_GROUP_TOOL_NAMES),
      environment: "external",
    });
    const descriptions = Object.values(surface)
      .map(({ description }) => description)
      .join("\n");

    expect(descriptions).not.toMatch(/[—–«»]/u);
  });

  it("denies Telegram attachment import after its external capability is revoked", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["import_telegram_attachment"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["import_telegram_attachment"]) },
    } as never;

    await expect(
      surface.import_telegram_attachment!.execute(
        {
          attachmentId: "00000000-0000-4000-8000-000000000099",
        },
        staleContext,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it("denies every framework built-in an external group must not reach", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(),
      environment: "external",
    });

    for (const toolName of ["agent", "ask_question", "bash", "todo", "web_fetch"]) {
      await expect(surface[toolName]!.execute({}, {} as never), `${toolName} must be denied`).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    }
  });

  it("denies a capability revoked after descriptor resolution despite a stale auth grant", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remember"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remember"]) },
    } as never;

    await expect(surface.remember!.execute({}, staleContext)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it.each(["deleted", "retyped"])("denies a descriptor resolved before the group is %s", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["send_workspace_file"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["send_workspace_file"]) },
    } as never;

    // The live repository represents both a missing row and a non-external row as deny-all.
    loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set());

    await expect(surface.send_workspace_file!.execute({}, staleContext)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("fails closed when execution-time policy lookup fails", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["remember"]),
      environment: "external",
    });
    const staleContext = {
      session: { auth: externalAuth(["remember"]) },
    } as never;
    loadCurrentExternalGroupCapabilities.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(surface.remember!.execute({}, staleContext)).rejects.toMatchObject({
      contract: {
        code: "AGENT_TOOL_DEPENDENCY_FAILED",
        retryable: false,
        sideEffectStatus: "unknown",
      },
    });
  });

  it("enforces action-level capabilities inside manage_memory", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory.undo"]),
      environment: "external",
    });
    const context = {
      session: { auth: externalAuth(["manage_memory.undo"]) },
    } as never;
    loadCurrentExternalGroupCapabilities.mockResolvedValueOnce(new Set(["manage_memory.undo"]));

    expect(surface).toHaveProperty("manage_memory");
    const schema = surface.manage_memory!.inputSchema as z.ZodType;
    expect(schema.safeParse({ action: "undo", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success)
      .toBe(true);
    expect(schema.safeParse({ action: "delete", memoryRef: "mem_0123456789abcdef0123456789abcdef" }).success)
      .toBe(false);
    expect(surface.manage_memory!.description).toContain('"action":"undo"');
    expect(surface.manage_memory!.description).not.toContain('"action":"edit"');
    expect(surface.manage_memory!.description).not.toContain('"action":"delete"');
    await expect(surface.manage_memory!.execute({ action: "delete", id: "00000000-0000-4000-8000-000000000001" }, context)).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("keeps memory-thread lifecycle action-level and re-checks the live external policy", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory_thread.complete"]),
      environment: "external",
    });
    const revoked = { session: { auth: externalAuth([]) } } as never;

    expect(surface).toHaveProperty("manage_memory_thread");
    await expect(
      surface.manage_memory_thread!.execute(
        {
          action: "complete",
          authority: "current_user_statement",
          sourceEntryRefs: ["entry_0123456789abcdef0123456789abcdef"],
          threadRef: "thread_0123456789abcdef0123456789abcdef",
        },
        revoked,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/u);
  });

  it("denies every capability when the trusted snapshot is corrupt", () => {
    expect(
      names({
        capabilities: new Set(["unknown_tool"] as unknown as ExternalGroupToolName[]),
        environment: "external",
      }),
    ).toEqual([...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES, ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, "load_skill", "manage_behavior_preference", "read_profile_view"].sort());
  });

  it("exposes only group scope in external shared-tool schemas and descriptions", () => {
    const external = buildModeToolSurface({
      capabilities: new Set(["inspect_workspace_image", "list_memories", "list_memory_threads", "remember", "send_workspace_file", "send_workspace_image"]),
      environment: "external",
    });

    const inputs = {
      inspect_workspace_image: {
        path: "image.png",
        question: "Что изображено?",
      },
      list_memories: {},
      list_memory_threads: {},
      remember: {
        basis: "agent_inferred",
        content: "Проверка",
        kind: "fact",
        sensitivity: "normal",
        subject: { kind: "current_author" },
      },
      send_workspace_file: { path: "result.pdf" },
      send_workspace_image: { path: "poster.png" },
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

    const trustedRemember = buildModeToolSurface({
      environment: "private",
    }).remember!;
    const trustedSchema = trustedRemember.inputSchema as z.ZodType;
    expect(
      trustedSchema.safeParse({
        basis: "agent_inferred",
        content: "Проверка",
        kind: "fact",
        scope: "personal",
        sensitivity: "normal",
        subject: { kind: "current_author" },
      }).success,
    ).toBe(true);
  });
});
