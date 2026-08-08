/**
 * Turn-scoped prompt block resolution tests.
 *
 * Constructs covered:
 * - Eve retains a previous turn's block when a resolver throws, so resolvers must never throw.
 * - An unresolvable environment produces an explicit fail-closed block, not a stale one.
 * - A failed external capability lookup degrades to an empty allowlist, matching execution policy.
 * - Unavailable memory is disclosed instead of looking like an empty result set.
 */
import type { SessionAuth, SessionAuthContext } from "eve/context";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  createMemoryBlockResolver,
  createModeBlockResolver,
  createPreferenceBlockResolver,
} from "./turn-blocks.js";

const createProfile = vi.fn();

function auth(attributes: SessionAuthContext["attributes"]): SessionAuth {
  return {
    current: {
      attributes,
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user",
    },
    initiator: null,
  };
}

function context(sessionAuth: SessionAuth, messages: readonly ModelMessage[] = []) {
  return { messages, session: { auth: sessionAuth, id: "session-1" } };
}

const privateAuth = auth({
  memoryScopes: ["personal", "family"],
  telegramChatType: "private",
});

const externalAuth = auth({
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  memoryScopes: ["group"],
  role: "external",
  telegramChatType: "supergroup",
  telegramUserId: "101",
  toolAllowlist: ["remember"],
});

describe("mode block resolution", () => {
  it("resolves the verified profile for a trusted conversation", async () => {
    const resolve = createModeBlockResolver({ loadCapabilities: vi.fn(), loadSkills: vi.fn() });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain("# Текущий режим: личный чат");
  });

  it("returns an explicit fail-closed block instead of throwing on invalid auth", async () => {
    const resolve = createModeBlockResolver({ loadCapabilities: vi.fn(), loadSkills: vi.fn() });

    const markdown = await resolve(context({ current: null, initiator: null }));

    expect(markdown).toContain("AGENT_CONVERSATION_ENVIRONMENT_INVALID");
    expect(markdown).toContain("<current_conversation_environment>");
    expect(markdown).not.toContain("# Текущий режим: личный чат");
  });

  it("degrades to an empty allowlist when the live capability lookup fails", async () => {
    const loadCapabilities = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const resolve = createModeBlockResolver({ loadCapabilities, loadSkills: vi.fn().mockResolvedValue(new Set()) });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("<external_group_capabilities>");
    expect(markdown).not.toContain("`remember`");
  });

  it("omits a capability revoked from the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set<ExternalGroupToolName>());
    const resolve = createModeBlockResolver({ loadCapabilities, loadSkills: vi.fn().mockResolvedValue(new Set()) });

    const markdown = await resolve(context(externalAuth));

    expect(loadCapabilities).toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" });
    expect(markdown).not.toContain("`remember`");
  });

  it("intersects the verified snapshot with the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(
      new Set<ExternalGroupToolName>(["remember", "web_fetch"]),
    );
    const resolve = createModeBlockResolver({ loadCapabilities, loadSkills: vi.fn().mockResolvedValue(new Set()) });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("`remember`");
    expect(markdown).not.toContain("`web_fetch`");
  });

  it("matches the external skill prompt to the current persisted grants", async () => {
    const loadSkills = vi.fn().mockResolvedValue(new Set(["pohuy"]));
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockResolvedValue(new Set()),
      loadSkills,
    });

    const markdown = await resolve(context(externalAuth));

    expect(loadSkills).toHaveBeenCalledWith("group-1");
    expect(markdown).toContain("`load_skill` с `skill=pohuy`");
  });
});

describe("memory block resolution", () => {
  const authorization = {
    familyId: "family-1",
    groupId: null,
    role: "owner" as const,
    scopes: ["personal" as const, "family" as const],
    telegramUserId: "101",
    userId: "user-1",
  };

  it("returns retrieved records for an authorized turn", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile,
      retrieve: vi.fn().mockResolvedValue({
        memories: [],
        retrievedClaimIds: [],
        threads: { threads: [], totalCharacters: 0 },
      }),
    });

    const markdown = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
    );

    expect(markdown).toContain("активный pipeline текущей реализации");
  });

  it("returns no block when the turn carries no user text", async () => {
    const retrieve = vi.fn();
    const resolve = createMemoryBlockResolver({ authorize: () => authorization, createProfile, retrieve });

    expect(await resolve(context(privateAuth))).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("discloses unavailable memory instead of throwing on authorization failure", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      createProfile,
      retrieve: vi.fn(),
    });

    const markdown = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
    );

    expect(markdown).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(markdown).not.toContain("активный pipeline текущей реализации");
  });

  it("discloses unavailable memory instead of throwing on retrieval failure", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile,
      retrieve: vi.fn().mockRejectedValue(new Error("embedding service down")),
    });

    const markdown = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
    );

    expect(markdown).toContain("AGENT_MEMORY_UNAVAILABLE");
  });

  it("builds the same-turn profile from verified signals and retrieval-related claim identities", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      memories: [],
      retrievedClaimIds: ["claim-related"],
      threads: { threads: [], totalCharacters: 0 },
    });
    const profile = vi.fn().mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z",
      profileViewRef: "view_11111111111111111111111111111111",
      subjects: [{
        claims: [],
        label: "Пётр",
        priority: "retrieval_related",
        subjectRef: "subj_11111111111111111111111111111111",
        totalCharacters: 0,
      }],
      totalCharacters: 0,
    });
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile: profile,
      retrieve,
    });
    const telegramAuth = auth({
      memoryScopes: ["personal", "family"],
      telegramConversationId: "conversation-1",
      telegramProfileMentionUserIds: ["202"],
      telegramProfileReplyUserId: "203",
      telegramProfileReplyTimelineSequence: "44",
      telegramTurnStartedAt: "2026-08-08T10:00:00.000Z",
      telegramUserId: "101",
    });

    const markdown = await resolve(
      context(telegramAuth, [{ content: "что любит Пётр?", role: "user" }] as ModelMessage[]),
    );

    expect(profile).toHaveBeenCalledWith(authorization, {
      conversationId: "conversation-1",
      currentTelegramUserId: "101",
      explicitMentionTelegramUserIds: ["202"],
      now: new Date("2026-08-08T10:00:00.000Z"),
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
      retrievalClaimIds: ["claim-related"],
    });
    expect(markdown).toContain("<verified_profile_view");
    expect(markdown).toContain('"priority":"retrieval_related"');
  });
});

describe("preference block resolution", () => {
  it("renders stored presentation preferences", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => ({
        familyId: "family-1",
        groupId: null,
        role: "owner" as const,
        scopes: ["personal" as const],
        telegramUserId: "101",
        userId: "user-1",
      }),
      list: vi.fn().mockResolvedValue([{
        key: "agent.behavior.tone",
        scope: "personal",
        updatedAt: "2026-08-01T00:00:00.000Z",
        value: "warm",
      }]),
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain("тёплый и доброжелательный тон");
  });

  it("clears the block instead of throwing when preferences cannot be read", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      list: vi.fn(),
    });

    expect(await resolve(context(privateAuth))).toBeNull();
  });
});
