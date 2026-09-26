/**
 * Resumed-turn auth after a Telegram approval.
 *
 * Constructs covered:
 * - The requesting turn's context (sandbox session, timeline position, visible entries, turn
 *   start) is restored from the approval row; the session's thread is the sandbox fallback.
 * - Policy attributes come only from the fresh database read: a stored role, scope or allowlist
 *   never survives into the resumed auth.
 * - `retainTurnAttributes` keeps exactly the context keys and drops everything else.
 */
import { describe, expect, it, vi } from "vitest";

import { type ApprovalAuthRow, resolveCurrentApprovalAuth, retainTurnAttributes } from "./approval-auth.js";

const row: ApprovalAuthRow = {
  application_session_id: "app-1", eve_session_id: "wrun_1", expected_telegram_user_id: "104", family_id: "fam-1", group_id: null, owner_user_id: "user-1",
  scope: "personal", telegram_chat_id: "104", telegram_chat_type: "private", telegram_conversation_id: "conv-1", telegram_message_id: "55",
  telegram_message_thread_id: null, telegram_timeline_entry_id: "entry-1", thread_id: "thread-1",
  turn_attributes: { memoryScopes: ["group"], role: "owner", sandboxSessionId: "thread-0", telegramTimelineSequence: "412", telegramTimelineVisibleEntryIds: ["entry-0", "entry-1"], telegramTurnStartedAt: "2026-09-26T08:50:00.000Z", toolAllowlist: ["bash"] },
};

function client() {
  return { query: vi.fn(async () => ({ rowCount: 1, rows: [{ family_id: "fam-1", role: "member", user_id: "user-1" }] })) } as never;
}

describe("resolveCurrentApprovalAuth", () => {
  it("restores the requesting turn's context under freshly read policy", async () => {
    const auth = await resolveCurrentApprovalAuth(client(), row);
    expect(auth?.attributes).toMatchObject({
      applicationSessionId: "app-1", memoryScopes: ["personal", "family"], role: "member", sandboxSessionId: "thread-0",
      telegramConversationId: "conv-1", telegramTimelineEntryId: "entry-1", telegramTimelineSequence: "412",
      telegramTimelineVisibleEntryIds: ["entry-0", "entry-1"], telegramTurnStartedAt: "2026-09-26T08:50:00.000Z",
    });
    expect(auth?.attributes).not.toHaveProperty("toolAllowlist");
  });

  it("falls back to the session's thread as the sandbox when no snapshot was kept", async () => {
    const auth = await resolveCurrentApprovalAuth(client(), { ...row, turn_attributes: null });
    expect(auth?.attributes.sandboxSessionId).toBe("thread-1");
    expect(auth?.attributes).not.toHaveProperty("telegramTimelineSequence");
  });
});

describe("retainTurnAttributes", () => {
  it("keeps context keys only", () => {
    expect(retainTurnAttributes({ role: "owner", sandboxSessionId: "s", telegramTimelineSequence: "7", telegramUserId: "104", x: 1 })).toEqual({ sandboxSessionId: "s", telegramTimelineSequence: "7" });
    expect(retainTurnAttributes(undefined)).toEqual({});
  });
});
