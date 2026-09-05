/**
 * Reflection and signal handler tests.
 *
 * Constructs covered:
 * - Parsing keeps only valid categories and priorities and drops tools or codes the evidence
 *   never named; malformed output is an empty list.
 * - The rate limiter admits N per family per hour.
 * - Handlers reflect on a failed tool in an external group, skip a quiet turn, skip review
 *   sessions, and record items with the fingerprint.
 */
import type { SessionAuth } from "eve/context";
import { describe, expect, it, vi } from "vitest";

import { createImprovementSignalHandlers } from "./improvement-signals.js";
import { createReflectionRateLimiter, parseReflection } from "./reflection.js";
import type { TurnEvidence } from "./turn-evidence.js";

const evidence: TurnEvidence = {
  failedTools: [{ code: "AGENT_IMAGE_PROVIDER_FAILED", message: "упал", toolName: "generate_image" }],
  stepCount: 2,
  toolNames: ["generate_image", "remember"],
  turnFailure: null,
};

describe("parseReflection", () => {
  it("keeps valid items and strips tools and codes absent from the evidence", () => {
    const items = parseReflection(JSON.stringify({ items: [
      { category: "tool_error", errorCode: "AGENT_IMAGE_PROVIDER_FAILED", priority: "high", summary: "Провайдер картинок падает", toolName: "generate_image" },
      { category: "workflow", errorCode: "MADE_UP", priority: "low", summary: "Лишний вызов", toolName: "bash" },
      { category: "nonsense", priority: "low", summary: "x" },
      { category: "prompt", priority: "urgent", summary: "x" },
    ] }), evidence);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ errorCode: "AGENT_IMAGE_PROVIDER_FAILED", toolName: "generate_image" });
    expect(items[1]).toMatchObject({ errorCode: null, toolName: null });
  });

  it("returns an empty list for prose or broken JSON", () => {
    expect(parseReflection("Ничего примечательного", evidence)).toEqual([]);
    expect(parseReflection("{\"items\": [", evidence)).toEqual([]);
  });
});

describe("createReflectionRateLimiter", () => {
  it("admits the hourly budget and refuses the rest until the window slides", () => {
    const limiter = createReflectionRateLimiter(2);
    const now = new Date("2026-09-05T12:00:00Z");
    expect(limiter.admit("f", now)).toBe(true);
    expect(limiter.admit("f", now)).toBe(true);
    expect(limiter.admit("f", now)).toBe(false);
    expect(limiter.admit("g", now)).toBe(true);
    expect(limiter.admit("f", new Date(now.getTime() + 3_600_001))).toBe(true);
  });
});

function ctx(attributes: Record<string, unknown>, channelKind = "channel:telegram") {
  return {
    channel: { kind: channelKind },
    session: {
      auth: { current: { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" }, initiator: null } as unknown as SessionAuth,
      id: "eve-1",
    },
  };
}

describe("createImprovementSignalHandlers", () => {
  it("reflects on a failed tool in an external group and records the item", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const record = vi.fn().mockResolvedValue({ recurred: false });
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ items: [
      { category: "tool_error", errorCode: "AGENT_IMAGE_PROVIDER_FAILED", priority: "medium", summary: "Провайдер картинок падает", toolName: "generate_image" },
    ] }));
    const handlers = createImprovementSignalHandlers({ generate, record });
    const context = ctx({ familyId: "family-1", groupType: "external", telegramChatType: "supergroup" });

    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "generate_image" }], turnId: "t1" } }, context);
    handlers.actionResult({ data: { error: { code: "AGENT_IMAGE_PROVIDER_FAILED", message: "упал" }, result: { callId: "c1", kind: "tool-result", toolName: "generate_image" }, status: "failed", turnId: "t1" } }, context);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toContain("\"chatKind\":\"external\"");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      category: "tool_error",
      familyId: "family-1",
      priority: "medium",
      summary: "Провайдер картинок падает",
    }));
    expect(record.mock.calls[0]?.[0].evidence).toMatchObject({ eveSessionId: "eve-1", eveTurnId: "t1", toolName: "generate_image" });
  });

  it("stays quiet for a light turn and for a silent memory review", async () => {
    const record = vi.fn();
    const generate = vi.fn();
    const handlers = createImprovementSignalHandlers({ generate, record });
    const context = ctx({ familyId: "family-1", telegramChatType: "private" });
    handlers.actionsRequested({ data: { actions: [{ callId: "c1", kind: "tool-call", toolName: "remember" }], turnId: "t1" } }, context);
    await handlers.turnCompleted({ data: { turnId: "t1" } }, context);

    const review = ctx({ familyId: "family-1", memoryReviewBatchId: "batch-1", memoryReviewMode: "background", telegramChatType: "private" });
    handlers.actionsRequested({ data: { actions: [{ callId: "c2", kind: "tool-call", toolName: "remember" }], turnId: "t2" } }, review);
    handlers.actionResult({ data: { error: { code: "X", message: "" }, result: { callId: "c2", kind: "tool-result", toolName: "remember" }, status: "failed", turnId: "t2" } }, review);
    await handlers.turnCompleted({ data: { turnId: "t2" } }, review);

    expect(generate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
