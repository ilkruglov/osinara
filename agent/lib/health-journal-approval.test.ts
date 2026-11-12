/**
 * The health journal's approvals.
 *
 * Constructs covered:
 * - Switching where the journal lives and erasing it are confirmed by the person with a button; the
 *   ordinary journal actions are not.
 * - The confirmation names the mode in words; an erase says it takes the journal's cards and leaves
 *   the person's other files.
 */
import { describe, expect, it } from "vitest";

import { localizeTelegramInputRequest } from "./telegram-interface.js";
import manageBodyProfile from "./tools/manage_body_profile.js";

function approvalFor(input: Record<string, unknown>): unknown {
  const approval = (manageBodyProfile as { approval: (context: unknown) => unknown }).approval;
  return approval({ approvedTools: [], callId: "call-1", toolInput: input });
}

function prompt(input: Record<string, string>): string {
  return localizeTelegramInputRequest({
    action: {
      callId: "call-1",
      input,
      kind: "tool-call" as const,
      toolName: "manage_body_profile",
    },
    display: "confirmation" as const,
    kind: "tool-approval" as const,
    options: [],
    prompt: "Approve tool call",
    requestId: "request-1",
  }).prompt;
}

describe("health journal approvals", () => {
  it("asks the person to confirm a mode switch and an erase, nothing else", () => {
    expect(approvalFor({ action: "set_journal_mode", journalMode: "files" })).toBe("user-approval");
    expect(approvalFor({ action: "erase_all" })).toBe("user-approval");
    expect(approvalFor({ action: "get" })).toBe("not-applicable");
    expect(approvalFor({ action: "log_measurement", source: "text", weightKg: 60 })).toBe(
      "not-applicable",
    );
  });

  it("tells the person an erase takes the journal's cards and leaves their other files", () => {
    const erase = prompt({ action: "erase_all" });
    expect(erase).toContain("и его карточки");
    expect(erase).toContain("остальные файлы в личной папке остаются");
  });

  it("names the mode in the confirmation", () => {
    expect(prompt({ action: "set_journal_mode", journalMode: "files" })).toContain(
      "в файлах health/",
    );
    expect(prompt({ action: "set_journal_mode", journalMode: "database" })).toContain(
      "дневник в чате",
    );
  });
});
