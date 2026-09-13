/** The same search executor is reachable in trusted chats and live-authorized external groups. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import { AppError } from "../app-error.js";

const policy = vi.hoisted(() => ({
  loadCurrentExternalGroupCapabilities: vi.fn(),
  authorizeCurrentExternalGroupCapability: vi.fn(),
}));
vi.mock("../tool-policy/external-group-live-policy.js", () => policy);
import { buildModeToolSurface } from "../tool-policy/mode-tool-surface.js";
import { buildMemoryReviewToolSurface } from "../memory-review/memory-review-tool-surface.js";

function context(environment: "private" | "family" | "external", attributes = {}): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    session: { id: "search-session", turn: { id: crypto.randomUUID() }, auth: { initiator: null, current: {
      authenticator: "telegram", principalId: "user-1", principalType: "user",
      attributes: {
        familyId: "family-1", role: environment === "external" ? "external" : "owner",
        telegramActorId: "101", telegramActorKind: "telegram_user", telegramUserId: "101",
        telegramChatType: environment === "private" ? "private" : "supergroup",
        memoryScopes: environment === "private" ? ["personal", "family"] : [environment === "family" ? "family" : "group"],
        ...(environment === "private" ? {} : { groupId: "group-1", groupType: environment === "family" ? "family_private" : "external" }),
        toolAllowlist: ["web_search"], ...attributes,
      },
    } } },
  } as unknown as ToolContext;
}
const searchResponse = {
  type: "message", content: [
    { type: "server_tool_use", name: "web_search", id: "s1" },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://eve.dev/docs", title: "Eve" }] },
  ],
};
const fetch = vi.fn(async () => Response.json(searchResponse));
beforeEach(() => {
  vi.clearAllMocks();
  policy.loadCurrentExternalGroupCapabilities.mockResolvedValue(new Set(["web_search"]));
  policy.authorizeCurrentExternalGroupCapability.mockResolvedValue(undefined);
  vi.stubEnv("MODEL_API_KEY", "test-deepseek-key");
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("web_search execution surface", () => {
  it.each(["private", "family", "external"] as const)("executes a real function definition in %s mode", async (environment) => {
    const surface = environment === "external"
      ? buildModeToolSurface({ environment, capabilities: new Set(["web_search"]) })
      : buildModeToolSurface({ environment });
    await expect(surface.web_search!.execute({ query: "Eve documentation", maxResults: 5 }, context(environment)))
      .resolves.toMatchObject({ results: [{ title: "Eve", url: "https://eve.dev/docs" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    if (environment === "external") expect(policy.authorizeCurrentExternalGroupCapability)
      .toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" }, "web_search");
  });

  it("rechecks a grant revoked after the descriptor was built", async () => {
    const surface = buildModeToolSurface({ environment: "external", capabilities: new Set(["web_search"]) });
    policy.authorizeCurrentExternalGroupCapability.mockRejectedValue(new AppError("AGENT_GROUP_TOOL_FORBIDDEN", "Отозвано"));
    await expect(surface.web_search!.execute({ query: "test", maxResults: 5 }, context("external")))
      .rejects.toThrow(/AGENT_GROUP_TOOL_FORBIDDEN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["no-grant", "scheduled", "review"])("blocks search without network in %s mode", async (mode) => {
    const surface = mode === "review" ? buildMemoryReviewToolSurface()
      : buildModeToolSurface({ environment: "external", capabilities: new Set(mode === "no-grant" ? [] : ["web_search"]), scheduledRun: mode === "scheduled" });
    await expect(surface.web_search!.execute({ query: "test", maxResults: 5 }, context("external")))
      .rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a trusted descriptor from executing during a later silent review", async () => {
    const surface = buildModeToolSurface({ environment: "private" });
    await expect(surface.web_search!.execute({ query: "test", maxResults: 5 }, context("private", { memoryReviewMode: "background" })))
      .rejects.toThrow(/AGENT_WEB_SEARCH_FORBIDDEN/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
