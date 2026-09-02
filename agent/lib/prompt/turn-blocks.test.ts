/**
 * Turn-scoped prompt block resolution tests.
 *
 * Constructs covered:
 * - Eve retains a previous turn's block when a resolver throws, so resolvers must never throw.
 * - An unresolvable environment produces an explicit fail-closed block, not a stale one.
 * - A failed external capability lookup degrades to an empty allowlist, matching execution policy.
 * - Scheduled-history instructions require the same successful application-core policy lookup.
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
const TEST_TURN_ID = "turn-1";

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

function context(
  sessionAuth: SessionAuth,
  messages: readonly ModelMessage[] = [],
  channelKind = "telegram",
) {
  return { channel: { kind: channelKind }, messages, session: { auth: sessionAuth, id: "session-1" } };
}

const privateAuth = auth({
  memoryScopes: ["personal", "family"],
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatType: "private",
  telegramUserId: "101",
});

const externalAuth = auth({
  familyId: "family-1",
  groupId: "group-1",
  groupType: "external",
  memoryScopes: ["group"],
  role: "external",
  telegramActorId: "101",
  telegramActorKind: "telegram_user",
  telegramChatType: "supergroup",
  telegramUserId: "101",
  toolAllowlist: ["remember"],
});

const channelAuth: SessionAuth = {
  current: {
    attributes: {
      familyId: "family-1",
      groupId: "group-1",
      groupType: "external",
      memoryScopes: ["group"],
      role: "external",
      telegramActorId: "-1001783384254",
      telegramActorKind: "telegram_channel",
      telegramChatType: "supergroup",
      toolAllowlist: ["remember"],
    },
    authenticator: "telegram",
    principalId: "telegram-channel:-1001783384254",
    principalType: "service",
  },
  initiator: null,
};

const reactionPolicy = vi.fn().mockResolvedValue(null);

describe("mode block resolution", () => {
  it("resolves the verified profile for a trusted conversation", async () => {
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn(),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain("# Текущий режим: личный чат");
  });

  it("returns an explicit fail-closed block instead of throwing on invalid auth", async () => {
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn(),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context({ current: null, initiator: null }));

    expect(markdown).toContain("AGENT_CONVERSATION_ENVIRONMENT_INVALID");
    expect(markdown).toContain("<current_conversation_environment>");
    expect(markdown).not.toContain("# Текущий режим: личный чат");
  });

  it("degrades to an empty allowlist when the live capability lookup fails", async () => {
    const loadCapabilities = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("<external_group_capabilities>");
    expect(markdown).not.toContain("`remember`");
  });

  it("omits scheduled-history instructions when application-core policy lookup fails", async () => {
    const current = auth({
      ...externalAuth.current!.attributes,
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    });
    const scheduledAuth = { ...current, initiator: current.current };
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockRejectedValue(new Error("database unavailable")),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(scheduledAuth));

    expect(markdown).not.toContain("read_scheduled_group_history");
  });

  it("includes scheduled-history instructions after application-core policy resolves", async () => {
    const current = auth({
      ...externalAuth.current!.attributes,
      scheduledGroupHistory: "enabled",
      scheduledRunId: "run-1",
    });
    const scheduledAuth = { ...current, initiator: current.current };
    const resolve = createModeBlockResolver({
      loadCapabilities: vi.fn().mockResolvedValue(new Set()),
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(scheduledAuth));

    expect(markdown).toContain("read_scheduled_group_history");
  });

  it("omits a capability revoked from the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set<ExternalGroupToolName>());
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(externalAuth));

    expect(loadCapabilities).toHaveBeenCalledWith({ familyId: "family-1", groupId: "group-1" });
    expect(markdown).not.toContain("`remember`");
  });

  it("intersects the verified snapshot with the current database policy", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(
      new Set<ExternalGroupToolName>(["remember", "web_fetch"]),
    );
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(externalAuth));

    expect(markdown).toContain("`remember`");
    expect(markdown).not.toContain("`web_fetch`");
  });

  it("does not describe human capabilities or skills to a channel actor", async () => {
    const loadCapabilities = vi.fn().mockResolvedValue(new Set(["remember"]));
    const resolve = createModeBlockResolver({
      loadCapabilities,
      loadReactionPolicy: reactionPolicy,
    });

    const markdown = await resolve(context(channelAuth));

    expect(loadCapabilities).not.toHaveBeenCalled();
    // The text-only channel surface must not gain a reaction it could apply to a channel post.
    expect(reactionPolicy).not.toHaveBeenCalled();
    expect(markdown).not.toContain("## Реакция вместо сообщения");
    expect(markdown).not.toContain("`remember`");
    expect(markdown).not.toContain("`load_skill`");
  });
});

describe("memory block resolution", () => {
  const authorization = {
    familyId: "family-1",
    groupId: null,
    role: "owner" as const,
    scopes: ["personal" as const, "family" as const],
    telegramActorId: "101",
    telegramActorKind: "telegram_user" as const,
    telegramUserId: "101",
    userId: "user-1",
  };

  it("returns retrieved records as a user-role block so the system prefix stays cacheable", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile,
      retrieve: vi.fn().mockResolvedValue({
        memories: [{ content: "Любит гречку", memoryRef: "mem_1" }],
        retrievedClaimIds: [],
        threads: { threads: [], totalCharacters: 0 },
      }),
    });

    const block = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(block?.role).toBe("user");
    expect(block?.markdown).toContain("<retrieved_long_term_memory>");
    expect(block?.markdown).toContain("Любит гречку");
    // The pipeline explanation lives once in the permanent instructions, not in every turn.
    expect(block?.markdown).not.toContain("активный pipeline");
  });

  it("returns no block when the turn carries no user text", async () => {
    const retrieve = vi.fn();
    const resolve = createMemoryBlockResolver({ authorize: () => authorization, createProfile, retrieve });

    expect(await resolve(context(privateAuth), TEST_TURN_ID)).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("skips retrieval and profile creation for a subagent turn", async () => {
    const retrieve = vi.fn();
    const profile = vi.fn();
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile: profile,
      retrieve,
    });

    const block = await resolve(
      context(privateAuth, [{ content: "исследуй тему", role: "user" }] as ModelMessage[], "subagent"),
      TEST_TURN_ID,
    );

    expect(block).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
  });

  it("discloses unavailable memory as a system block instead of throwing on authorization failure", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      createProfile,
      retrieve: vi.fn(),
    });

    const block = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(block?.role).toBe("system");
    expect(block?.markdown).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(block?.markdown).not.toContain("<retrieved_long_term_memory>");
  });

  it("discloses unavailable memory instead of throwing on retrieval failure", async () => {
    const resolve = createMemoryBlockResolver({
      authorize: () => authorization,
      createProfile,
      retrieve: vi.fn().mockRejectedValue(new Error("embedding service down")),
    });

    const block = await resolve(
      context(privateAuth, [{ content: "что купить?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );

    expect(block?.markdown).toContain("AGENT_MEMORY_UNAVAILABLE");
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

    const block = await resolve(
      context(telegramAuth, [{ content: "что любит Пётр?", role: "user" }] as ModelMessage[]),
      TEST_TURN_ID,
    );
    const markdown = block?.markdown;

    expect(profile).toHaveBeenCalledWith(authorization, {
      conversationId: "conversation-1",
      currentTelegramUserId: "101",
      explicitMentionTelegramUserIds: ["202"],
      now: new Date("2026-08-08T10:00:00.000Z"),
      provenance: { sessionId: "session-1", turnId: TEST_TURN_ID },
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
      retrievalClaimIds: ["claim-related"],
    });
    expect(markdown).toContain("<verified_profile_view");
    expect(markdown).toContain('"priority":"retrieval_related"');
  });
});

describe("preference block resolution", () => {
  it("renders the one user-managed prompt of the current chat", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => ({
        conversationId: "conversation-1",
        sourceSequence: "1",
        telegramUserId: "101",
        timelineEntryId: "entry-1",
      }),
      get: vi.fn().mockResolvedValue({
        content: "Не добавляй шутки.",
        revision: 2,
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    });

    const markdown = await resolve(context(privateAuth));

    expect(markdown).toContain('<chat_operational_instructions revision="2">');
    expect(markdown).toContain("Не добавляй шутки.");
  });

  it("clears the block instead of throwing when preferences cannot be read", async () => {
    const resolve = createPreferenceBlockResolver({
      authorize: () => {
        throw new Error("AGENT_MEMORY_CONTEXT_INVALID: нет области памяти");
      },
      get: vi.fn(),
    });

    expect(await resolve(context(privateAuth))).toBeNull();
  });
});
