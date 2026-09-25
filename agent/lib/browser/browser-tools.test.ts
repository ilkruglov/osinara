/**
 * Browser tools tests with injected dependencies.
 *
 * Constructs covered:
 * - open refuses non-http and blocked hosts; a look returns numbered elements, the screenshot path
 *   and the vision view, and stores the look.
 * - act refuses a stale epoch and an unknown number; a gated click is parked, not performed; a
 *   profile fill puts the value into the page and records the field without returning the value.
 * - confirm performs only the parked click, refuses a mismatch, and does nothing on a changed page.
 * - session status, reset and save_field; external callers are refused.
 */
import type { ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";

import type { BrowserDriver } from "./browser-driver.js";
import { type BrowserToolDependencies, createBrowserTools } from "./browser-tools.js";
import type { BrowserLook, PendingClick } from "./look-repository.js";

function context(chat: "external" | "family" | "private" = "private"): ToolContext {
  const attributes = chat === "private"
    ? { familyId: "family-1", role: "owner", sandboxSessionId: "sbx-1", telegramChatId: "1", telegramChatType: "private", telegramUserId: "u1", userId: "user-1" }
    : chat === "family"
    ? { familyId: "family-1", groupId: "group-1", groupType: "family_private", role: "member", sandboxSessionId: "sbx-1", telegramChatId: "-1001", telegramChatType: "supergroup", telegramUserId: "u1", userId: "user-1" }
    : { familyId: "family-1", groupId: "group-2", groupType: "external", role: "external", sandboxSessionId: "sbx-2", telegramChatId: "-1002", telegramChatType: "supergroup", telegramUserId: "u9", userId: null };
  const caller = { attributes, authenticator: "telegram", principalId: "user-1", principalType: "user" as const };
  return { abortSignal: new AbortController().signal, callId: "call-1", session: { auth: { current: caller, initiator: caller }, id: "eve-1", turn: { id: "turn-1" } } } as unknown as ToolContext;
}

const PAGE = { elements: [
  { n: 1, role: "textbox", text: "Телефон", value: "", state: [] },
  { n: 2, role: "generic", text: "Мужская стрижка", value: null, state: [] },
  { n: 3, role: "button", text: "Оплатить 1500 ₽", value: null, state: [] },
  { n: 4, role: "frame", text: "yclients.ru", value: null, state: [] },
], textHash: 111, title: "Запись", url: "https://x.yclients.com/book?o=1" };

function harness(options: { vision?: string | null; actOk?: boolean; urlAfter?: string; textAfter?: number; profile?: Record<string, { domains: string[]; value: string }> } = {}) {
  const calls: string[][] = [];
  let looks: BrowserLook | null = null;
  let url = PAGE.url;
  const driver: BrowserDriver = {
    back: async () => { calls.push(["back"]); },
    eval: async (script) => {
      if (script.includes("document.title") && script.includes("elements")) { calls.push(["mark"]); return JSON.stringify({ ...PAGE, epoch: /"([^"]+)"/u.exec(script.split("const epoch = ")[1] ?? "")?.[1] ?? "?", url }); }
      if (script.includes("reg.nodes")) { calls.push(["act", script.slice(script.indexOf("const action = "), script.indexOf("const action = ") + 80)]); if (options.urlAfter) url = options.urlAfter; return JSON.stringify(options.actOk === false ? { ok: false, reason: "gone" } : script.includes('"enter"') ? { ok: true, src: "https://b20106.yclients.ru/widget" } : { ok: true }); }
      if (script.includes("5381")) return String(options.textAfter ?? PAGE.textHash);
      calls.push(["clear"]); return "OK";
    },
    open: async (u) => { calls.push(["open", u]); url = u; },
    press: async (k) => { calls.push(["press", k]); },
    readText: async () => "Спасибо! Вы записаны",
    screenshot: async (p) => { calls.push(["screenshot", p]); },
    scroll: async (d) => { calls.push(["scroll", d]); },
    settle: async () => { calls.push(["settle"]); },
    url: async () => url,
  };
  const approvalEvidence = vi.fn(async () => undefined);
  const saved: Array<{ domains: readonly string[]; field: string; value: string }> = [];
  const deps: BrowserToolDependencies = {
    approvalEvidence,
    driver: () => driver,
    loadProfile: async () => options.profile ?? { phone: { domains: ["yclients.com"], value: "+79160000000" } },
    log: () => undefined,
    looks: {
      addEntered: async (_s, _f, entry) => { looks!.entered = [...looks!.entered, entry]; },
      get: async () => looks,
      reset: async () => { looks = null; },
      saveLook: async (input) => {
        looks = { elements: input.view.elements, entered: looks?.entered ?? [], epoch: input.view.epoch, familyId: input.familyId, pending: null, sandboxSessionId: input.sandboxSessionId, screenshotPath: input.screenshotPath, steps: (looks?.steps ?? -1) + 1, textHash: input.view.textHash, title: input.view.title, updatedAt: new Date(), url: input.view.url, view: input.vision, viewHash: input.viewHash };
        return looks!;
      },
      setPending: async (_s, _f, pending: PendingClick | null) => { looks!.pending = pending; },
    },
    now: () => 1_700_000_000_000,
    sandboxSessionId: () => "sbx-1",
    saveProfileField: async (_a, _o, input) => { saved.push(input); return { domains: [...input.domains], value: input.value }; },
    vision: async () => options.vision === undefined ? '{"screen":"выбор услуг","selected":["Мужская стрижка"],"blockers":[],"note":""}' : options.vision,
  };
  return { approvalEvidence, calls, deps, saved, tools: createBrowserTools(deps), looks: () => looks };
}

describe("browser tools", () => {
  it("opens only http(s) outside blocked hosts and returns a numbered look with the vision view", async () => {
    const { calls, tools } = harness();
    await expect(tools.browser_open.execute({ url: "https://t.me/+7999" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });

    const out = await tools.browser_open.execute({ url: "https://x.yclients.com/book?o=1" }, context()) as { elements: string; epoch: string; screenshot: string; view: { screen: string } };

    expect(out.elements).toContain("[3] button Оплатить 1500 ₽");
    expect(out.screenshot).toMatch(/^shots\/look-[a-z0-9]+-1\.png$/u);
    expect(out.view.screen).toBe("выбор услуг");
    expect(calls.map((c) => c[0])).toEqual(["open", "settle", "mark", "screenshot", "clear"]);
    expect(calls.find((c) => c[0] === "screenshot")![1]).toMatch(/^\/workspace\/personal\/shots\//u);
  });

  it("refuses external callers and a stale epoch", async () => {
    const { tools } = harness();
    await expect(tools.browser_look.execute({}, context("external"))).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    await tools.browser_look.execute({}, context());
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 2 }, epoch: "old" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 9 }, epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
  });

  it("performs a plain click and reports whether the page changed", async () => {
    const { calls, tools } = harness({ urlAfter: "https://x.yclients.com/book?o=1s2" });
    const { epoch } = await tools.browser_look.execute({}, context("family")) as { epoch: string };
    const out = await tools.browser_act.execute({ action: { kind: "click", n: 2 }, epoch }, context("family")) as { changed: boolean; status: string };
    expect(out).toMatchObject({ changed: true, status: "done" });
    expect(calls.some((c) => c[0] === "act" && c[1]!.includes('"click"'))).toBe(true);
    expect(calls.map((c) => c[0])).toContain("settle");
  });

  it("parks a gated click instead of performing it", async () => {
    const { calls, looks, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    const out = await tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch }, context()) as { status: string; reason: string; screenshot: string };
    expect(out).toMatchObject({ reason: "transaction", status: "confirmation_required" });
    expect(out.screenshot).toMatch(/^shots\//u);
    expect(calls.some((c) => c[0] === "act")).toBe(false);
    expect(looks()!.pending).toMatchObject({ epoch, n: 3 });
  });

  it("fills a profile field into the page, records it, and never returns the value", async () => {
    const { calls, looks, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    const out = await tools.browser_act.execute({ action: { field: "phone", kind: "fill", n: 1 }, epoch }, context());
    expect(JSON.stringify(out)).not.toContain("+79160000000");
    expect(calls.find((c) => c[0] === "act")![1]).toContain("+79160000000");
    expect(looks()!.entered).toEqual([{ field: "phone", label: "Телефон", n: 1 }]);

    const missing = await tools.browser_act.execute({ action: { field: "email", kind: "fill", n: 1 }, epoch }, context()) as { status: string };
    expect(missing.status).toBe("field_missing");
  });

  it("gates any submit click after a field was entered", async () => {
    const { tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    await tools.browser_act.execute({ action: { field: "phone", kind: "fill", n: 1 }, epoch }, context());
    const page = await tools.browser_look.execute({}, context()) as { epoch: string };
    const out = await tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch: page.epoch }, context()) as { status: string; reason: string };
    expect(out).toMatchObject({ status: "confirmation_required" });
  });

  it("enters a widget frame by opening its src", async () => {
    const { calls, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    await tools.browser_act.execute({ action: { kind: "enter", n: 4 }, epoch }, context());
    expect(calls).toContainEqual(["open", "https://b20106.yclients.ru/widget"]);
  });

  it("confirm performs only the parked click, under approval, and refuses a changed page", async () => {
    const { approvalEvidence, calls, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    await expect(tools.browser_confirm.execute({ epoch, n: 3 }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
    await tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch }, context());
    await expect(tools.browser_confirm.execute({ epoch, n: 2 }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });

    const out = await tools.browser_confirm.execute({ epoch, n: 3 }, context()) as { status: string };
    expect(approvalEvidence).toHaveBeenCalled();
    expect(out.status).toBe("done");
    expect(calls.filter((c) => c[0] === "act")).toHaveLength(1);
    expect((tools.browser_confirm.approval as () => unknown)()).toBe("user-approval");

    const moved = harness({ textAfter: 999 });
    const look2 = await moved.tools.browser_look.execute({}, context()) as { epoch: string };
    await moved.tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch: look2.epoch }, context());
    const refused = await moved.tools.browser_confirm.execute({ epoch: look2.epoch, n: 3 }, context()) as { status: string };
    expect(refused.status).toBe("stale");
    expect(moved.calls.some((c) => c[0] === "act")).toBe(false);
  });

  it("reports session status, resets, and saves a profile field bound to the current site", async () => {
    const { looks, saved, tools } = harness();
    expect(await tools.browser_session.execute({ action: "status" }, context())).toEqual({ status: "idle" });
    await tools.browser_look.execute({}, context());
    expect(await tools.browser_session.execute({ action: "status" }, context())).toMatchObject({ status: "active", url: PAGE.url });
    const out = await tools.browser_session.execute({ action: "save_field", field: "phone", value: "+7" }, context()) as { saved: { domains: string[] } };
    expect(out.saved.domains).toEqual(["x.yclients.com"]);
    expect(saved[0]).toMatchObject({ field: "phone", value: "+7" });
    await expect(tools.browser_session.execute({ action: "save_field", domains: ["*"], field: "cvc", value: "1" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_TASK_PROFILE_INVALID" });
    await tools.browser_session.execute({ action: "reset" }, context());
    expect(looks()).toBeNull();
  });
});
