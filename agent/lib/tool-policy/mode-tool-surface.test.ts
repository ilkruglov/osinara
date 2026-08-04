/**
 * Mode-scoped tool surface tests.
 *
 * Constructs covered:
 * - Each trust zone emits exactly its own application tools and nothing from another zone.
 * - An external group emits only granted capabilities plus fail-closed framework denials.
 * - Granted capabilities re-check the live policy at execution and stay action-level for memory.
 * - HITL approval configuration survives dynamic emission.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it } from "vitest";

import {
  FAMILY_ONLY_TOOL_NAMES,
  PRIVATE_ONLY_TOOL_NAMES,
  TRUSTED_MODE_TOOL_NAMES,
  buildModeToolSurface,
} from "./mode-tool-surface.js";
import {
  EXTERNAL_GROUP_TOOL_NAMES,
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
  type ExternalGroupToolName,
} from "./group-tool-catalog.js";

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

describe("trusted mode tool surfaces", () => {
  it("gives a private chat the shared tools plus owner administration only", () => {
    expect(names({ environment: "private" })).toEqual(
      [...TRUSTED_MODE_TOOL_NAMES, ...PRIVATE_ONLY_TOOL_NAMES].sort(),
    );
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
  it("emits nothing but framework denials without a grant", () => {
    expect(names({ capabilities: new Set(), environment: "external" })).toEqual(
      [...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, "load_skill"].sort(),
    );
  });

  it("keeps native workspace file tools untouched in every isolated group workspace", () => {
    const surface = buildModeToolSurface({ capabilities: new Set(), environment: "external" });

    for (const nativeTool of ["glob", "grep", "read_file", "write_file"]) {
      expect(surface).not.toHaveProperty(nativeTool);
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

    for (const emitted of names({ capabilities: new Set(), environment: "external" })) {
      expect(applicationNames.has(emitted) && !grantable.has(emitted)).toBe(false);
    }
  });

  it("emits a granted capability and leaves allowed provider search native", () => {
    expect(names({ capabilities: new Set(["remember"]), environment: "external" }))
      .toContain("remember");
    expect(names({ capabilities: new Set(["web_search"]), environment: "external" }))
      .not.toContain("web_search");
    expect(names({ capabilities: new Set(["web_fetch"]), environment: "external" }))
      .toContain("web_fetch");
  });

  it("surfaces constrained group file removal only when explicitly allowed", () => {
    expect(names({ capabilities: new Set(), environment: "external" }))
      .not.toContain("remove_group_file");
    expect(names({ capabilities: new Set(["remove_group_file"]), environment: "external" }))
      .toContain("remove_group_file");
  });

  it("denies every framework built-in an external group must not reach", async () => {
    const surface = buildModeToolSurface({ capabilities: new Set(), environment: "external" });

    for (const toolName of ["ask_question", "bash", "todo", "web_fetch"]) {
      await expect(
        surface[toolName]!.execute({}, {} as never),
        `${toolName} must be denied`,
      ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
    }
  });

  it("re-checks the live policy when a granted capability executes", async () => {
    const surface = buildModeToolSurface({ capabilities: new Set(["remember"]), environment: "external" });
    const revoked = { session: { auth: externalAuth([]) } } as never;

    await expect(surface.remember!.execute({}, revoked)).rejects.toThrowError(
      /AGENT_GROUP_TOOL_FORBIDDEN/,
    );
  });

  it("enforces action-level capabilities inside manage_memory", async () => {
    const surface = buildModeToolSurface({
      capabilities: new Set(["manage_memory.undo"]),
      environment: "external",
    });
    const context = { session: { auth: externalAuth(["manage_memory.undo"]) } } as never;

    expect(surface).toHaveProperty("manage_memory");
    await expect(
      surface.manage_memory!.execute(
        { action: "delete", id: "00000000-0000-4000-8000-000000000001" },
        context,
      ),
    ).rejects.toThrowError(/AGENT_GROUP_TOOL_FORBIDDEN/);
  });

  it("denies every capability when the trusted snapshot is corrupt", () => {
    expect(names({
      capabilities: new Set(["unknown_tool"] as unknown as ExternalGroupToolName[]),
      environment: "external",
    })).toEqual([...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS, "load_skill"].sort());
  });
});
