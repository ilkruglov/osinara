/**
 * Telegram turn memory context tests.
 *
 * Constructs covered:
 * - Retrieved records become delivery context, so the system prefix stays byte-stable per chat.
 * - Memory authorization derives from verified access and actor, never from message text.
 * - The same-turn profile view binds to the application session and timeline entry.
 * - Failures degrade to an explicit unavailability notice instead of failing the turn.
 */
import { describe, expect, it, vi } from "vitest";

import { createTelegramMemoryContextBuilder } from "./telegram-turn-memory-context.js";

const access = {
  familyId: "family-1",
  groupId: null,
  memoryScopes: ["personal", "family"] as Array<"family" | "group" | "personal">,
  role: "owner" as const,
  userId: "user-1",
};

function input(overrides: Partial<Parameters<ReturnType<typeof createTelegramMemoryContextBuilder>>[0]> = {}) {
  return {
    access,
    actor: { id: "101", kind: "telegram_user" as const },
    applicationSessionId: "app-session-1",
    conversationId: "conversation-1",
    explicitMentionTelegramUserIds: [],
    query: "что купить?",
    replyTelegramUserId: null,
    replyTimelineSequence: null,
    timelineEntryId: "entry-1",
    turnStartedAt: new Date("2026-08-08T10:00:00.000Z"),
    ...overrides,
  };
}

const emptyRetrieval = { memories: [], retrievedClaimIds: [], threads: { threads: [], totalCharacters: 0 } };

describe("createTelegramMemoryContextBuilder", () => {
  it("returns retrieved records as one context block", async () => {
    const retrieve = vi.fn().mockResolvedValue({
      ...emptyRetrieval,
      memories: [{ content: "Любит гречку", memoryRef: "mem_1" }],
    });
    const build = createTelegramMemoryContextBuilder({ createProfile: vi.fn().mockResolvedValue(null), retrieve });

    const blocks = await build(input());

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("<retrieved_long_term_memory>");
    expect(blocks[0]).toContain("Любит гречку");
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: "family-1",
        groupId: null,
        role: "owner",
        scopes: ["personal", "family"],
        telegramActorId: "101",
        telegramActorKind: "telegram_user",
        telegramUserId: "101",
        userId: "user-1",
      }),
      "что купить?",
      [],
    );
  });

  it("appends the pending repeat-task hint once and after the memory block", async () => {
    const takeSkillHint = vi.fn().mockResolvedValue({ stepCount: 5, toolNames: ["web_search", "generate_image"] });
    const build = createTelegramMemoryContextBuilder({
      createProfile: vi.fn().mockResolvedValue(null),
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
      takeSkillHint,
    });

    const blocks = await build(input());

    expect(takeSkillHint).toHaveBeenCalledWith("conversation-1");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain("5 шагов инструментов: web_search, generate_image");
    expect(blocks[1]).toContain("предложи сохранить её как навык");
  });

  it("adds nothing when the message carries no text", async () => {
    const retrieve = vi.fn();
    const build = createTelegramMemoryContextBuilder({ createProfile: vi.fn(), retrieve });

    expect(await build(input({ query: "   " }))).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("binds the same-turn profile view to the application session and timeline entry", async () => {
    const retrieve = vi.fn().mockResolvedValue({ ...emptyRetrieval, retrievedClaimIds: ["claim-related"] });
    const createProfile = vi.fn().mockResolvedValue({
      generatedAt: "2026-08-08T10:00:00.000Z",
      profileViewRef: "view_11111111111111111111111111111111",
      subjects: [],
      totalCharacters: 0,
    });
    const build = createTelegramMemoryContextBuilder({ createProfile, retrieve });

    const blocks = await build(input({
      explicitMentionTelegramUserIds: ["202"],
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
    }));

    expect(createProfile).toHaveBeenCalledWith(expect.objectContaining({ familyId: "family-1" }), {
      conversationId: "conversation-1",
      currentTelegramUserId: "101",
      explicitMentionTelegramUserIds: ["202"],
      now: new Date("2026-08-08T10:00:00.000Z"),
      provenance: { sessionId: "app-session-1", turnId: "entry-1" },
      replyTelegramUserId: "203",
      replyTimelineSequence: "44",
      retrievalClaimIds: ["claim-related"],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("<verified_profile_view");
    expect(blocks[1]).toContain("<retrieved_long_term_memory>");
  });

  it("creates no profile view for a channel actor", async () => {
    const createProfile = vi.fn();
    const build = createTelegramMemoryContextBuilder({
      createProfile,
      retrieve: vi.fn().mockResolvedValue(emptyRetrieval),
    });

    const blocks = await build(input({
      access: { ...access, groupId: "group-1", memoryScopes: ["group"], role: "external", userId: null },
      actor: { id: "-1001783384254", kind: "telegram_channel" },
    }));

    expect(createProfile).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
  });

  it("discloses unavailable memory instead of failing the turn when retrieval breaks", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const build = createTelegramMemoryContextBuilder({
      createProfile: vi.fn(),
      retrieve: vi.fn().mockRejectedValue(new Error("embedding service down")),
    });

    const blocks = await build(input());

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("AGENT_MEMORY_UNAVAILABLE");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AGENT_MEMORY_UNAVAILABLE"));
    log.mockRestore();
  });
});
