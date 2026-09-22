/**
 * browser_task tool tests with injected dependencies.
 *
 * Constructs covered:
 * - Only `confirm` declares user approval.
 * - Scope follows the chat; a second start while a run is active is refused.
 * - start returns the loop outcome and saves the run; confirm revalidates approval and performs the pending click.
 * - resume and confirm refuse a run in the wrong state.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import type { BrowserDriver, BrowserPage } from "./browser-task/browser-driver.js";
import type { BrowserTaskRun } from "./browser-task/browser-task-run-repository.js";
import { parseSnapshot } from "./browser-task/element-table.js";
import type { JevDecision } from "./browser-task/jev-client.js";
import { type BrowserTaskDependencies, createBrowserTaskTool } from "./tools/browser_task.js";

function context(chat: "family" | "private" = "private"): ToolContext {
  const caller = {
    attributes: chat === "private"
      ? { familyId: "family-1", role: "owner", sandboxSessionId: "sbx-1", telegramChatId: "1", telegramChatType: "private", telegramUserId: "u1", userId: "user-1" }
      : { familyId: "family-1", groupId: "group-1", groupType: "family_private", role: "member", sandboxSessionId: "sbx-1", telegramChatId: "-1001", telegramChatType: "supergroup", telegramUserId: "u1", userId: "user-1" },
    authenticator: "telegram",
    principalId: "user-1",
    principalType: "user" as const,
  };
  return { abortSignal: new AbortController().signal, callId: "call-1", session: { auth: { current: caller, initiator: caller }, id: "eve-1", turn: { id: "turn-1" } } } as unknown as ToolContext;
}

const FORM = `- textbox "Введите имя" [ref=e1] value="Илья"\n- button "Записаться" [ref=e3]`;
function page(snapshot: string, url = "https://x.yclients.com/book"): BrowserPage { return { table: parseSnapshot(snapshot), title: "t", url }; }
function decision(choice: string, confidence = 0.9): JevDecision {
  return { action: { choice, confidence, probabilities: { [choice]: confidence } }, final: null, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } };
}

function harness(options: { pages?: BrowserPage[]; decisions?: JevDecision[]; active?: BrowserTaskRun | null; stored?: BrowserTaskRun } = {}) {
  const calls: string[][] = [];
  const pages = options.pages ?? [page(FORM)];
  let index = 0;
  const driver: BrowserDriver = {
    click: async (ref) => { calls.push(["click", ref]); }, clickText: async (t) => { calls.push(["clickText", t]); }, enterFrame: async () => undefined,
    fill: async (ref, t) => { calls.push(["fill", ref, t]); }, open: async (u) => { calls.push(["open", u]); }, readText: async () => "Вы записаны",
    scroll: async () => undefined, select: async () => undefined, snapshot: async () => pages[Math.min(index++, pages.length - 1)]!, wait: async () => undefined,
  };
  const decisions = [...(options.decisions ?? [decision("CLICK [2]")])];
  const saved: BrowserTaskRun[] = [];
  const profiles: unknown[] = [];
  const approvalEvidence = vi.fn(async () => undefined);
  const deps: BrowserTaskDependencies = {
    approvalEvidence,
    driver: () => driver,
    jev: () => ({ decide: async () => decisions.shift() ?? decision("BLOCKED", 0.9) }),
    loadProfile: async () => ({ name: { domains: ["*"], value: "Илья" } }),
    saveProfile: async (_auth, profile) => { profiles.push(profile); },
    log: () => undefined,
    now: () => 1_000,
    runs: {
      activeForSandbox: async () => options.active ?? null,
      create: async (input) => ({ ...input, entered: [], failedActions: {}, handoffCount: 0, hint: null, history: [], id: "11111111-1111-4111-8111-111111111111", lastSignature: null, lastUrl: null, pendingAction: null, startedAt: new Date(0), status: "running", stepCount: 0 }),
      get: async (id) => options.stored && options.stored.id === id ? options.stored : null,
      save: async (run) => { saved.push({ ...run }); },
    },
    sandboxSessionId: () => "sbx-1",
  };
  return { approvalEvidence, calls, profiles, saved, tool: createBrowserTaskTool(deps) };
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
function storedRun(overrides: Partial<BrowserTaskRun>): BrowserTaskRun {
  return { allowedFields: ["name"], entered: [], extraData: {}, failedActions: {}, familyId: "family-1", goal: "записаться", handoffCount: 0, hint: null, history: [], id: RUN_ID, lastSignature: null, lastUrl: "https://x.yclients.com/book", pendingAction: null, sandboxSessionId: "sbx-1", scope: "personal", startUrl: null, startedAt: new Date(0), status: "running", stepCount: 1, userId: "user-1", ...overrides };
}

describe("browser_task", () => {
  it("declares user approval only for confirm", () => {
    const { tool } = harness();
    const approval = tool.approval as (input: { toolInput: unknown }) => unknown;
    expect(approval({ toolInput: { action: "confirm", runId: RUN_ID } })).toBe("user-approval");
    expect(approval({ toolInput: { action: "start", goal: "x", scope: "personal" } })).toBe("not-applicable");
  });

  it("refuses family scope outside a family group and personal scope outside a private chat", async () => {
    const { tool } = harness();
    await expect(tool.execute({ action: "start", allowedFields: [], goal: "x", scope: "family" }, context("private"))).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_FORBIDDEN" });
    await expect(tool.execute({ action: "start", allowedFields: [], goal: "x", scope: "personal" }, context("family"))).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_FORBIDDEN" });
  });

  it("refuses a second start while a run is active", async () => {
    const { tool } = harness({ active: storedRun({ status: "needs_plan" }) });
    await expect(tool.execute({ action: "start", allowedFields: [], goal: "x", scope: "personal" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_BUSY" });
  });

  it("runs the loop on start, stops at the gate and saves the run", async () => {
    const { calls, saved, tool } = harness();

    const out = await tool.execute({ action: "start", allowedFields: ["name"], goal: "записаться", scope: "personal", startUrl: "https://x.yclients.com" }, context()) as { status: string; summary: string; runId: string };

    expect(out.status).toBe("awaiting_confirmation");
    expect(out.summary).toContain("Записаться");
    expect(out.runId).toBe(RUN_ID);
    expect(saved.at(-1)!.pendingAction).toMatchObject({ ref: "e3" });
    expect(calls[0]).toEqual(["open", "https://x.yclients.com"]);
    expect(calls.some((c) => c[0] === "click")).toBe(false);
  });

  it("confirm revalidates the approval, clicks the pending element and continues", async () => {
    const stored = storedRun({ pendingAction: { label: "Записаться", ref: "e3", summary: "s", url: "https://x.yclients.com/book" }, status: "awaiting_confirmation" });
    const { approvalEvidence, calls, tool } = harness({ decisions: [decision("DONE")], pages: [page(FORM), page(`- heading "Спасибо" [ref=e1]`)], stored });

    const out = await tool.execute({ action: "confirm", runId: RUN_ID }, context()) as { status: string };

    expect(approvalEvidence).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual(["click", "e3"]);
    expect(out.status).toBe("done");
  });

  it("save_field writes the personal profile, binding the field to the active run's site by default", async () => {
    const active = storedRun({ lastUrl: "https://n1.yclients.ru/book", status: "needs_plan" });
    const { profiles, tool } = harness({ active });

    const out = await tool.execute({ action: "save_field", field: "phone", value: "+79160000000" }, context()) as { saved: { field: string; domains: string[] } };

    expect(out.saved).toEqual({ domains: ["n1.yclients.ru"], field: "phone" });
    expect(profiles[0]).toMatchObject({ name: { value: "Илья" }, phone: { domains: ["n1.yclients.ru"], value: "+79160000000" } });
  });

  it("save_field needs explicit domains without an active run and refuses card fields", async () => {
    const { tool } = harness();
    await expect(tool.execute({ action: "save_field", field: "phone", value: "+7" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_DOMAINS_REQUIRED" });
    await expect(tool.execute({ action: "save_field", domains: ["*"], field: "cvc", value: "123" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_PROFILE_INVALID" });
    const out = await tool.execute({ action: "save_field", domains: ["*"], field: "email", value: "a@b.ru" }, context()) as { saved: { domains: string[] } };
    expect(out.saved.domains).toEqual(["*"]);
  });

  it("refuses resume and confirm in the wrong state, and cancel ends a run", async () => {
    const { saved, tool } = harness({ stored: storedRun({ status: "running" }) });
    await expect(tool.execute({ action: "resume", hint: "h", runId: RUN_ID }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_STATE_INVALID" });
    await expect(tool.execute({ action: "confirm", runId: RUN_ID }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_STATE_INVALID" });
    const out = await tool.execute({ action: "cancel", runId: RUN_ID }, context()) as { status: string };
    expect(out.status).toBe("cancelled");
    expect(saved.at(-1)!.status).toBe("cancelled");
  });
});
