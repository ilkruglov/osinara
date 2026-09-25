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

import { AppError } from "../app-error.js";
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
/** Another member of the same family group, sharing its sandbox. */
function otherMember(): ToolContext {
  const ctx = context("family");
  const current = ctx.session.auth.current as { attributes: Record<string, unknown>; principalId: string };
  current.principalId = "user-2";
  current.attributes.userId = "user-2";
  current.attributes.telegramUserId = "u2";
  return ctx;
}

const PAGE = { elements: [
  { n: 1, role: "textbox", text: "Телефон", value: "", state: [] },
  { n: 2, role: "generic", text: "Мужская стрижка", value: null, state: [] },
  { n: 3, role: "button", text: "Оплатить 1500 ₽", value: null, state: [] },
  { n: 4, role: "frame", text: "yclients.ru", value: null, state: [] },
], stateHash: 222, textHash: 111, title: "Запись", url: "https://x.yclients.com/book?o=1" };

function harness(options: { vision?: string | null; actOk?: boolean; urlAfter?: string;  emptyLooks?: number; revoked?: boolean; actReason?: string; profile?: Record<string, { domains: string[]; value: string }> } = {}) {
  const calls: string[][] = [];
  let looks: BrowserLook | null = null;
  let url = PAGE.url;
  let textNow = PAGE.textHash;
  let stateNow = PAGE.stateHash;
  const driver: BrowserDriver = {
    back: async () => { calls.push(["back"]); },
    eval: async (script) => {
      if (script.includes("return djb2(visibleText())")) return String(textNow);
      if (script.includes("stateHashOf(reg.nodes")) return String(stateNow);
      if (script.includes("return visibleText()")) return "Спасибо!  Вы записаны";
      if (script.includes("document.title") && script.includes("elements")) {
        calls.push(["mark"]);
        const elements = (options.emptyLooks ?? 0) > calls.filter((c) => c[0] === "mark").length - 1 ? [] : PAGE.elements;
        return JSON.stringify({ ...PAGE, elements, epoch: /"([^"]+)"/u.exec(script.split("const epoch = ")[1] ?? "")?.[1] ?? "?", url });
      }
      if (script.includes("reg.nodes")) { calls.push(["act", script.slice(script.indexOf("const action = "), script.indexOf("const action = ") + 80)]); if (options.urlAfter) url = options.urlAfter; return JSON.stringify(options.actOk === false ? { ok: false, reason: options.actReason ?? "gone" } : script.includes('"enter"') ? { ok: true, src: "https://b20106.yclients.ru/widget" } : { ok: true }); }
      calls.push(["clear"]); return "OK";
    },
    open: async (u) => { calls.push(["open", u]); url = u; },
    press: async (k) => { calls.push(["press", k]); },
    screenshot: async (p) => { await new Promise((resolve) => setTimeout(resolve, 5)); calls.push(["screenshot", p]); },
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
      addEntered: async (_s, _f, entry) => { looks!.entered = [...looks!.entered.filter((e) => !(e.epoch === entry.epoch && e.n === entry.n)), entry]; },
      claimPending: async (_s, _f, epoch, n) => {
        const pending = looks?.pending;
        if (!pending || pending.epoch !== epoch || pending.n !== n || pending.claimed) return false;
        pending.claimed = true; return true;
      },
      get: async () => looks,
      reset: async () => { looks = null; },
      saveLook: async (input) => {
        looks = { elements: input.view.elements, entered: looks?.userId === input.userId ? looks.entered : [], epoch: input.view.epoch, familyId: input.familyId, pending: null, sandboxSessionId: input.sandboxSessionId, screenshotPath: input.screenshotPath, stateHash: input.view.stateHash, steps: (looks?.steps ?? -1) + 1, textHash: input.view.textHash, title: input.view.title, updatedAt: new Date(), url: input.view.url, userId: input.userId, view: input.vision, viewHash: input.viewHash };
        return looks!;
      },
      setPending: async (_s, _f, pending: PendingClick | null) => { looks!.pending = pending; },
    },
    now: () => 1_700_000_000_000,
    requireAccess: async () => { if (options.revoked) throw new AppError("AGENT_WORKSPACE_ACCESS_REVOKED", "Доступ был отозван"); },
    sandboxSessionId: () => "sbx-1",
    saveProfileField: async (_a, _o, input) => { saved.push(input); return { domains: [...input.domains], value: input.value }; },
    vision: async () => options.vision === undefined ? '{"screen":"выбор услуг","selected":["Мужская стрижка"],"blockers":[],"note":""}' : options.vision,
  };
  return { approvalEvidence, calls, deps, saved, tools: createBrowserTools(deps), looks: () => looks, setState: (hash: number) => { stateNow = hash; }, setText: (hash: number) => { textNow = hash; } };
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

  it("looks once more when a slow page shows nothing to act on", async () => {
    const { calls, tools } = harness({ emptyLooks: 1 });
    const out = await tools.browser_open.execute({ url: "https://x.yclients.com/book?o=1" }, context()) as { elements: string };
    expect(out.elements).toContain("[3] button");
    expect(calls.map((c) => c[0])).toEqual(["open", "settle", "mark", "screenshot", "clear", "settle", "settle", "mark", "screenshot", "clear"]);
  });

  it("presses only navigation keys", async () => {
    const { calls, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    for (const key of ["Enter", " ", "Control+Enter", "Shift+Enter", "a"]) {
      await expect(tools.browser_act.execute({ action: { key, kind: "press" }, epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    }
    await tools.browser_act.execute({ action: { key: "Escape", kind: "press" }, epoch }, context());
    expect(calls.filter((c) => c[0] === "press")).toEqual([["press", "Escape"]]);
  });

  it("runs one browser call at a time per sandbox", async () => {
    const { calls, tools } = harness();
    await Promise.all([tools.browser_look.execute({}, context()), tools.browser_look.execute({}, context())]);
    expect(calls.map((c) => c[0])).toEqual(["mark", "screenshot", "clear", "mark", "screenshot", "clear"]);
  });

  it("refuses external callers and a stale epoch", async () => {
    await expect(harness({ revoked: true }).tools.browser_look.execute({}, context())).rejects.toMatchObject({ code: "AGENT_WORKSPACE_ACCESS_REVOKED" });
    const { tools } = harness();
    await expect(tools.browser_look.execute({}, context("external"))).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    const review = context(); (review.session.auth.current as { attributes: Record<string, unknown> }).attributes.memoryReviewMode = "background";
    await expect(tools.browser_look.execute({}, review)).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    await tools.browser_look.execute({}, context());
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 2 }, epoch: "old" }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 9 }, epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
  });

  it("refuses to touch a numbered element once the page text moved on", async () => {
    const { calls, setText, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    setText(999);
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 2 }, epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
    expect(calls.some((c) => c[0] === "act")).toBe(false);
  });

  it("refuses a click once a value or label changed, while a fill only needs the text unchanged", async () => {
    const { calls, setState, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    setState(999);
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 2 }, epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
    await tools.browser_act.execute({ action: { kind: "fill", n: 1, text: "+79161112233" }, epoch }, context());
    expect(calls.filter((c) => c[0] === "act")).toHaveLength(1);
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
    expect(looks()!.entered).toEqual([{ epoch, field: "phone", label: "Телефон", n: 1, value: "+79160000000" }]);
    await tools.browser_act.execute({ action: { kind: "fill", n: 1, text: "+79161112233" }, epoch }, context());
    expect(looks()!.entered).toEqual([{ epoch, field: "text", label: "Телефон", n: 1, value: "+79161112233" }]);

    const missing = await tools.browser_act.execute({ action: { field: "email", kind: "fill", n: 1 }, epoch }, context()) as { status: string };
    expect(missing.status).toBe("field_missing");
    const secret = harness({ actOk: false, actReason: "password" });
    const look2 = await secret.tools.browser_look.execute({}, context()) as { epoch: string };
    await expect(secret.tools.browser_act.execute({ action: { kind: "fill", n: 1, text: "hunter2" }, epoch: look2.epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    expect(secret.looks()!.entered).toEqual([]);
  });

  it("keeps a look, its click and its typed data with the member who made it", async () => {
    const { looks, tools } = harness();
    const { epoch } = await tools.browser_look.execute({}, context("family")) as { epoch: string };
    await tools.browser_act.execute({ action: { field: "phone", kind: "fill", n: 1 }, epoch }, context("family"));
    await tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch }, context("family"));
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 2 }, epoch }, otherMember())).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    await expect(tools.browser_confirm.execute({ epoch, n: 3 }, otherMember())).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    await expect(tools.browser_read.execute({}, otherMember())).rejects.toMatchObject({ code: "AGENT_BROWSER_FORBIDDEN" });
    const theirs = await tools.browser_look.execute({}, otherMember()) as { entered: string[] };
    expect(theirs.entered).toEqual([]);
    expect(looks()!.userId).toBe("user-2");
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

    const moved = harness();
    const look2 = await moved.tools.browser_look.execute({}, context()) as { epoch: string };
    await moved.tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch: look2.epoch }, context());
    moved.setText(999);
    const refused = await moved.tools.browser_confirm.execute({ epoch: look2.epoch, n: 3 }, context()) as { status: string };
    expect(refused.status).toBe("stale");
    expect(moved.calls.some((c) => c[0] === "act")).toBe(false);

    const toggled = harness();
    const look3 = await toggled.tools.browser_look.execute({}, context()) as { epoch: string };
    await toggled.tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch: look3.epoch }, context());
    toggled.setState(999);
    expect((await toggled.tools.browser_confirm.execute({ epoch: look3.epoch, n: 3 }, context()) as { status: string }).status).toBe("stale");
    expect(toggled.calls.some((c) => c[0] === "act")).toBe(false);
  });

  it("never clicks a parked click twice: a failed click stays claimed", async () => {
    const { calls, looks, tools } = harness({ actOk: false });
    const { epoch } = await tools.browser_look.execute({}, context()) as { epoch: string };
    await tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch }, context());
    await expect(tools.browser_confirm.execute({ epoch, n: 3 }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_STALE" });
    expect(looks()!.pending).toMatchObject({ claimed: true, n: 3 });
    await expect(tools.browser_confirm.execute({ epoch, n: 3 }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_CONFIRM_AMBIGUOUS" });
    await expect(tools.browser_act.execute({ action: { kind: "click", n: 3 }, epoch }, context())).rejects.toMatchObject({ code: "AGENT_BROWSER_CONFIRM_AMBIGUOUS" });
    expect(looks()!.pending).toMatchObject({ claimed: true, n: 3 });
    expect(calls.filter((c) => c[0] === "act")).toHaveLength(1);
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
