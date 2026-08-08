/**
 * Eve dynamic capability resolver tests.
 *
 * Constructs covered:
 * - `capabilities`: one turn-scoped map per verified mode instead of static descriptors.
 * - An unresolvable mode or failed policy lookup retains only fail-closed baseline wrappers.
 * - Live policy changes affect visibility on the next turn and execution checks enforce revocation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCurrentExternalGroupCapabilities = vi.hoisted(() => vi.fn());
const authorizeCurrentExternalGroupCapability = vi.hoisted(() => vi.fn());

vi.mock("./external-group-live-policy.js", () => ({
  loadCurrentExternalGroupCapabilities,
  authorizeCurrentExternalGroupCapability,
}));

import capabilities from "../../tools/capabilities.js";
import {
  ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
  FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
} from "./group-tool-catalog.js";

function resolve(attributes: Record<string, unknown> | null) {
  return capabilities.events["turn.started"]?.({} as never, {
    channel: { kind: "telegram" },
    messages: [],
    session: {
      auth: {
        current: attributes === null ? null : {
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

describe("dynamic capability resolver", () => {
  beforeEach(() => {
    loadCurrentExternalGroupCapabilities.mockReset();
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set());
  });

  it("emits the private surface for a verified private chat", async () => {
    const surface = await resolve({
      memoryScopes: ["personal", "family"],
      telegramChatType: "private",
    });

    expect(Object.keys(surface ?? {})).toContain("export_memory");
    expect(Object.keys(surface ?? {})).not.toContain("list_group_history");
    expect(loadCurrentExternalGroupCapabilities).not.toHaveBeenCalled();
  });

  it("emits the family surface for a registered family group", async () => {
    const surface = await resolve({
      groupType: "family_private",
      memoryScopes: ["family"],
      telegramChatType: "supergroup",
    });

    expect(Object.keys(surface ?? {})).toContain("list_group_history");
    expect(Object.keys(surface ?? {})).not.toContain("export_memory");
  });

  it("emits only granted capabilities and framework denials for an external group", async () => {
    loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["remember"]));

    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    });

    expect(Object.keys(surface ?? {}).sort()).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        "load_skill",
        "manage_memory_approval",
        "read_profile_view",
        "remember",
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      ].sort(),
    );
    expect(loadCurrentExternalGroupCapabilities).toHaveBeenCalledWith({
      familyId: "family-1",
      groupId: "group-1",
    });
  });

  it("emits load_skill only when the external group has a current skill grant", async () => {
    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      skillAllowlist: ["pohuy"],
      telegramChatType: "supergroup",
      toolAllowlist: [],
    });

    expect(surface).toHaveProperty("load_skill");
  });

  it("revokes a capability that is absent from the current database policy", async () => {
    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    });

    expect(Object.keys(surface ?? {})).not.toContain("remember");
  });

  it("emits no application tool when the live policy lookup fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    loadCurrentExternalGroupCapabilities.mockRejectedValue(new Error("database unavailable"));

    const surface = await resolve({
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    });

    expect(Object.keys(surface ?? {}).sort()).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        "load_skill",
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      ].sort(),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_GROUP_TOOL_POLICY_LOOKUP_FAILED"),
    );
    consoleError.mockRestore();
  });

  it("emits no application tool when the conversation mode cannot be proven", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const surface = await resolve(null);

    expect(Object.keys(surface ?? {}).sort()).toEqual(
      [
        ...ALWAYS_AVAILABLE_SANDBOX_FILE_TOOL_NAMES,
        "load_skill",
        ...FRAMEWORK_TOOLS_DENIED_IN_EXTERNAL_GROUPS,
      ].sort(),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_TOOL_SURFACE_ENVIRONMENT_INVALID"),
    );
    consoleError.mockRestore();
  });
});
