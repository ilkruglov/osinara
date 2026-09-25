/**
 * Confirmation subject tests.
 *
 * Constructs covered:
 * - The window shows the values the loop typed, whatever the profile says now.
 * - A run that no longer waits for confirmation has no subject.
 * - A run of another conversation has no subject: a family group never sees a private run's data.
 */
import { describe, expect, it } from "vitest";

import { describeBrowserTaskApproval } from "./browser-task-approval.js";
import type { BrowserTaskRun } from "./browser-task-run-repository.js";

function run(overrides: Partial<BrowserTaskRun>): BrowserTaskRun {
  return {
    activeMillis: 0, allowedFields: ["phone"], entered: [{ field: "phone", label: "Телефон", value: "111" }], extraData: {},
    failedActions: {}, familyId: "f", goal: "записаться", handoffCount: 0, hint: null, history: [], id: "r", lastSignature: null,
    lastUrl: null, pendingAction: { label: "Записаться", pageHash: "h", ref: "e3", role: "button", url: "https://n1.yclients.com/book" },
    sandboxSessionId: "s", scope: "personal", startUrl: null, startedAt: new Date(0), status: "awaiting_confirmation", stepCount: 1, userId: "u",
    ...overrides,
  };
}

describe("describeBrowserTaskApproval", () => {
  it("shows what was typed into the form, not the profile as it is now", () => {
    expect(describeBrowserTaskApproval(run({}), "s")).toEqual({
      button: "Записаться", fields: [{ label: "Телефон", value: "111" }], site: "n1.yclients.com", url: "https://n1.yclients.com/book",
    });
  });

  it("has no subject once the run stopped waiting", () => {
    expect(() => describeBrowserTaskApproval(run({ status: "confirming" }), "s")).toThrow(/не ждёт подтверждения/u);
  });

  it("reveals nothing about a run of another conversation", () => {
    let message = "";
    try { describeBrowserTaskApproval(run({}), "family-group-sandbox"); } catch (error) { message = String(error); }
    expect(message).toMatch(/не найдена/u);
    expect(message).not.toMatch(/111|yclients/u);
  });
});
