/**
 * Telegram channel draft-rate regression contract.
 *
 * Constructs covered:
 * - The channel does not emit text-like drafts before knowing the terminal delivery kind.
 * - Token deltas and tool-loop events never trigger draft API calls.
 * - Scheduled Telegram delivery is durably confirmed before secondary group timeline persistence.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const TELEGRAM_CHANNEL_PATH = new URL("../channels/telegram.ts", import.meta.url);

describe("Telegram channel draft policy", () => {
  it("keeps reaction-capable turns free of speculative Telegram drafts", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");

    expect(source).toContain('async "turn.started"');
    expect(source).not.toContain("startTelegramRichThinkingDraft");
    expect(source).not.toContain('"message.appended"');
    expect(source).not.toContain('"action.result"');
    expect(source).not.toContain('"actions.requested"');
  });

  it("records scheduled delivery confirmation before the group timeline", async () => {
    const source = await readFile(TELEGRAM_CHANNEL_PATH, "utf8");
    const confirmation = source.indexOf("await agentScheduleDispatchRepository.completeDeliveredRun(");
    const timeline = source.indexOf("await telegramGroupJournalRepository.recordAgentResponse(");

    expect(confirmation).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(confirmation);
    expect(source).not.toContain("agentScheduleDispatchRepository.completeRun(");
    expect(source).toContain("AGENT_SCHEDULE_DELIVERY_CONFIRMATION_MISSING");
  });
});
