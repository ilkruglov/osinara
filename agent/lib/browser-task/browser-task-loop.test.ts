/**
 * Decision loop tests with a scripted browser and a queued Jev.
 *
 * Constructs covered:
 * - The loop stops before an irreversible click inside a form and hands a code-built summary over.
 * - A transaction word stops the loop without a form; any other click outside a form is put to Jev.
 * - Low confidence hands over to Mia twice, then blocks.
 * - A page that does not change after an action counts against that action; three in a row is stuck.
 * - DONE is claimed only with a success phrase on the final page, never with the goal's own words.
 * - Every Jev request carries an abort signal; time counts only while the loop runs.
 * - A field the profile does not cover becomes a question, not a guess.
 * - performPendingAction clicks exactly the pending element and continues; a changed element, form
 *   or URL refuses without a click; a failed click is reported as unknown and never retried.
 * - A click covered by an iframe enters that iframe without asking Jev.
 */
import { describe, expect, it } from "vitest";

import type { BrowserDriver, BrowserPage } from "./browser-driver.js";
import { parseSnapshot } from "./element-table.js";
import type { JevClient, JevDecision } from "./jev-client.js";
import { ModelFacingError } from "../model-facing-error.js";
import type { BrowserTaskRun } from "./browser-task-run-repository.js";
import { pageHash, performPendingAction, runBrowserTaskLoop } from "./browser-task-loop.js";

const FORM = `- textbox "Введите имя" [ref=e1]\n- textbox "Номер телефона" [ref=e2]\n- button "Записаться" [ref=e3]`;
const FORM_FILLED = `- textbox "Введите имя" [ref=e1] value="Илья"\n- textbox "Номер телефона" [ref=e2] value="+79160000000"\n- button "Записаться" [ref=e3]`;
const HOME = `- link "Записаться" [ref=e1]\n- link "Контакты" [ref=e2]`;
const THANKS = `- heading "Вы записаны" [ref=e1]\n- link "На главную" [ref=e2]`;

function page(snapshot: string, url = "https://x.yclients.com/book", title = "Запись"): BrowserPage {
  return { content: snapshot, table: parseSnapshot(snapshot), title, url };
}

function scriptedDriver(pages: BrowserPage[], options: { text?: string; clickError?: string } = {}) {
  const calls: string[][] = [];
  let index = 0;
  const driver: BrowserDriver = {
    click: async (ref) => {
      calls.push(["click", ref]);
      if (options.clickError) {
        throw new ModelFacingError({ category: "operation", code: "AGENT_BROWSER_TASK_BROWSER_FAILED", correction: "", reason: options.clickError, retryable: false, sideEffectStatus: "unknown" });
      }
    },
    clickText: async (text) => { calls.push(["clickText", text]); },
    enterFrame: async (ref) => { calls.push(["enterFrame", ref]); },
    fill: async (ref, text) => { calls.push(["fill", ref, text]); },
    open: async (url) => { calls.push(["open", url]); },
    readText: async () => options.text ?? "",
    scroll: async (direction) => { calls.push(["scroll", direction]); },
    select: async (ref, value) => { calls.push(["select", ref, value]); },
    snapshot: async () => { calls.push(["snapshot"]); return pages[Math.min(index++, pages.length - 1)]!; },
    wait: async (ms) => { calls.push(["wait", String(ms)]); },
  };
  return { calls, driver };
}

function decision(choice: string, confidence: number, final: number | null = null): JevDecision {
  return { action: { choice, confidence, probabilities: { [choice]: confidence, DONE: 0.01, BLOCKED: 0.01 } }, final, latencyMs: 400, usage: { inputTokens: 500, outputTokens: 90 } };
}

function queuedJev(decisions: JevDecision[]) {
  const asked: Array<{ state: unknown; final: boolean; signal: AbortSignal | undefined }> = [];
  const jev: JevClient = {
    decide: async (state, questions, signal) => {
      asked.push({ final: questions.final !== undefined, signal, state });
      const next = decisions.shift();
      if (!next) throw new Error("jev queue empty");
      return next;
    },
  };
  return { asked, jev };
}

function run(overrides: Partial<BrowserTaskRun> = {}): BrowserTaskRun {
  return {
    activeMillis: 0, allowedFields: ["name", "phone"], entered: [], extraData: {}, failedActions: {}, familyId: "f", goal: "записаться на стрижку завтра после 18:00",
    handoffCount: 0, hint: null, history: [], id: "run-1", lastSignature: null, lastUrl: null, pendingAction: null,
    sandboxSessionId: "sbx", scope: "personal", startUrl: "https://x.yclients.com", startedAt: new Date(0), status: "running", stepCount: 0, userId: "u",
    ...overrides,
  };
}

function pendingOn(at: BrowserPage) {
  return { label: "Записаться", pageHash: pageHash(at), ref: "e3", role: "button", url: at.url };
}

const PROFILE = { name: { domains: ["*"], value: "Илья" }, phone: { domains: ["yclients.com"], value: "+79160000000" } };
const deps = (driver: BrowserDriver, jev: JevClient, now = 1_000) => ({ driver, jev, log: () => undefined, now: () => now, profile: PROFILE });

describe("runBrowserTaskLoop", () => {
  it("fills fields from the profile and stops before the irreversible click with a code-built summary", async () => {
    const { calls, driver } = scriptedDriver([page(FORM), page(FORM), page(FORM_FILLED), page(FORM_FILLED)]);
    const { asked, jev } = queuedJev([decision("TYPE_TEXT [1]", 0.9), decision("TYPE_TEXT [2]", 0.9), decision("CLICK [3]", 0.95)]);

    const outcome = await runBrowserTaskLoop(run(), deps(driver, jev));

    expect(outcome.run.status).toBe("awaiting_confirmation");
    expect(outcome.run.pendingAction).toMatchObject({ label: "Записаться", ref: "e3", url: "https://x.yclients.com/book" });
    expect(outcome.summary).toContain("Записаться");
    expect(outcome.summary).toContain("x.yclients.com");
    expect(outcome.summary).toContain("Введите имя: Илья");
    expect(outcome.summary).toContain("Номер телефона: +79160000000");
    expect(calls).toEqual([["open", "https://x.yclients.com"], ["snapshot"], ["fill", "e1", "Илья"], ["snapshot"], ["fill", "e2", "+79160000000"], ["snapshot"]]);
    // "Записаться" is in the dictionary: no second question to Jev is needed.
    expect(asked.every((a) => !a.final)).toBe(true);
    expect(outcome.run.entered).toEqual([{ field: "name", label: "Введите имя", value: "Илья" }, { field: "phone", label: "Номер телефона", value: "+79160000000" }]);
  });

  it("asks Jev about a submit-like element the dictionary does not know, inside a form", async () => {
    const form = `- textbox "Введите имя" [ref=e1] value="Илья"\n- button "Ок" [ref=e3]`;
    const { calls, driver } = scriptedDriver([page(form)]);
    const { asked, jev } = queuedJev([decision("CLICK [2]", 0.9), decision("YES", 0.7, 0.45)]);

    const outcome = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver, jev));

    expect(outcome.run.status).toBe("awaiting_confirmation");
    expect(asked.at(-1)!.final).toBe(true);
    expect(JSON.stringify(asked.at(-1)!.state)).toContain("button Ок");
    expect(calls.some((c) => c[0] === "click")).toBe(false);
  });

  it("asks for a value instead of guessing when the profile does not cover the field", async () => {
    const { calls, driver } = scriptedDriver([page(FORM, "https://goodman.ru/reserve")]);
    const { jev } = queuedJev([decision("TYPE_TEXT [2]", 0.9)]);

    const outcome = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver, jev));

    expect(outcome.run.status).toBe("needs_plan");
    expect(outcome.question).toContain("Номер телефона");
    expect(outcome.run.handoffCount).toBe(0);
    expect(calls.some((c) => c[0] === "fill")).toBe(false);
  });

  it("hands over to Mia on low confidence at most twice, then blocks", async () => {
    const { driver } = scriptedDriver([page(HOME, "https://x.ru/")]);
    const { jev } = queuedJev([decision("CLICK [1]", 0.2), decision("BLOCKED", 0.6), decision("CLICK [2]", 0.1)]);

    const first = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver, jev));
    expect(first.run.status).toBe("needs_plan");
    expect(first.run.handoffCount).toBe(1);
    expect(first.question).toContain("Записаться");

    first.run.status = "running";
    first.run.hint = "жми Записаться";
    const second = await runBrowserTaskLoop(first.run, deps(driver, jev));
    expect(second.run.status).toBe("needs_plan");
    expect(second.run.handoffCount).toBe(2);

    second.run.status = "running";
    const third = await runBrowserTaskLoop(second.run, deps(driver, jev));
    expect(third.run.status).toBe("blocked");
  });

  it("counts an unchanged page against the action, drops it after two, and is stuck after three", async () => {
    const same = page(HOME, "https://x.ru/");
    const { driver } = scriptedDriver([same, same, same, same]);
    const notFinal = decision("NO", 0.9, 0.01);
    const { asked, jev } = queuedJev([decision("CLICK [1]", 0.9), notFinal, decision("CLICK [1]", 0.9), { ...notFinal }, decision("CLICK [2]", 0.9), { ...notFinal }]);

    const outcome = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver, jev));

    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.failedActions["CLICK:e1"]).toBe(2);
    const lastCriteria = (asked.filter((a) => !a.final).at(-1)!.state as { page: string }).page;
    expect(lastCriteria).toContain("Записаться");
    expect(outcome.summary).toMatch(/не меняется/u);
  });

  it("claims done only with a success phrase, not with the goal's words on the unsent form", async () => {
    const { driver } = scriptedDriver([page(FORM)], { text: "Записаться на стрижку завтра. Выберите время. Илья" });
    const { jev } = queuedJev([decision("DONE", 0.9)]);
    const outcome = await runBrowserTaskLoop(run({ entered: [{ field: "name", label: "Введите имя" }], startUrl: null }), deps(driver, jev));
    expect(outcome.run.status).toBe("unverified");
    expect(outcome.evidence).toEqual([]);
  });

  it("claims done only with evidence on the final page", async () => {
    const { driver } = scriptedDriver([page(THANKS)], { text: "Спасибо! Вы записаны на 23 сентября 18:30 к мастеру Иван." });
    const { jev } = queuedJev([decision("DONE", 0.9)]);
    const done = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver, jev));
    expect(done.run.status).toBe("done");
    expect(done.evidence[0]!.quote).toMatch(/Вы записаны/u);

    const { driver: bare } = scriptedDriver([page(HOME)], { text: "Главная страница" });
    const { jev: jev2 } = queuedJev([decision("DONE", 0.9)]);
    const unverified = await runBrowserTaskLoop(run({ startUrl: null }), deps(bare, jev2));
    expect(unverified.run.status).toBe("unverified");
    expect(unverified.evidence).toEqual([]);
  });

  it("enters the covering iframe itself when a click is covered by one", async () => {
    const withFrame = page(`- link "Записаться" [ref=e1]\n- Iframe [ref=e22]`, "https://b-frant.ru/");
    const { calls, driver } = scriptedDriver([withFrame, withFrame], { clickError: "Element '@e1' is covered by <iframe.yWidgetIFrame> at its click point" });
    const { jev } = queuedJev([decision("CLICK [1]", 0.9), decision("NO", 0.9, 0.01), decision("BLOCKED", 0.9)]);

    await runBrowserTaskLoop(run({ startUrl: null, handoffCount: 2 }), deps(driver, jev));

    expect(calls).toContainEqual(["enterFrame", "e22"]);
  });

  it("fails on the step limit and on loop time, but not on time spent waiting for a person", async () => {
    const { driver } = scriptedDriver([page(HOME)]);
    const { jev } = queuedJev([]);
    const steps = await runBrowserTaskLoop(run({ startUrl: null, stepCount: 40 }), deps(driver, jev));
    expect(steps.run.status).toBe("failed");
    const time = await runBrowserTaskLoop(run({ activeMillis: 180_000, startUrl: null }), deps(driver, jev));
    expect(time.run.status).toBe("failed");

    // Started an hour ago, most of it waiting for an answer: the budget sees only loop time.
    const { jev: jev2 } = queuedJev([decision("BLOCKED", 0.9)]);
    const waited = await runBrowserTaskLoop(run({ activeMillis: 10_000, startUrl: null, startedAt: new Date(0) }), deps(driver, jev2, 3_600_000));
    expect(waited.run.status).toBe("needs_plan");
  });

  it("stops before a transaction word without a form, and asks Jev about any other click outside one", async () => {
    const pay = page(`- heading "Ваш заказ" [ref=e1]\n- button "Оплатить 1500 ₽" [ref=e2]`, "https://shop.ru/cart");
    const { calls, driver } = scriptedDriver([pay]);
    const { asked, jev } = queuedJev([decision("CLICK [1]", 0.9)]);
    const paid = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver, jev));
    expect(paid.run.status).toBe("awaiting_confirmation");
    expect(asked.every((a) => !a.final)).toBe(true);
    expect(calls.some((c) => c[0] === "click")).toBe(false);

    const odd = page(`- heading "Ваш заказ" [ref=e1]\n- button "Ок" [ref=e2]`, "https://shop.ru/cart");
    const { calls: calls2, driver: driver2 } = scriptedDriver([odd]);
    const { asked: asked2, jev: jev2 } = queuedJev([decision("CLICK [1]", 0.9), decision("YES", 0.7, 0.6)]);
    const gated = await runBrowserTaskLoop(run({ startUrl: null }), deps(driver2, jev2));
    expect(gated.run.status).toBe("awaiting_confirmation");
    expect(asked2.at(-1)!.final).toBe(true);
    expect(calls2.some((c) => c[0] === "click")).toBe(false);
  });

  it("gives every Jev request an abort signal tied to the turn", async () => {
    const turn = new AbortController();
    const { driver } = scriptedDriver([page(HOME, "https://x.ru/")]);
    const { asked, jev } = queuedJev([decision("BLOCKED", 0.9)]);
    await runBrowserTaskLoop(run({ startUrl: null }), { ...deps(driver, jev), signal: turn.signal });
    const signal = asked[0]!.signal!;
    expect(signal.aborted).toBe(false);
    turn.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("performPendingAction", () => {
  it("binds to a re-render with the same content: new refs keep the hash", async () => {
    const renumbered = FORM_FILLED.replace(/ref=e(\d)/gu, (_m, n: string) => `ref=e${Number(n) + 40}`);
    expect(pageHash(page(renumbered))).toBe(pageHash(page(FORM_FILLED)));
  });

  it("clicks exactly the pending element on the same page and continues to done", async () => {
    const { calls, driver } = scriptedDriver([page(FORM_FILLED), page(THANKS)], { text: "Вы записаны, ждём вас" });
    const { jev } = queuedJev([decision("DONE", 0.9)]);
    const pending = run({ pendingAction: pendingOn(page(FORM_FILLED)), startUrl: null, status: "confirming" });

    const outcome = await performPendingAction(pending, deps(driver, jev));

    expect(calls.slice(0, 2)).toEqual([["snapshot"], ["click", "e3"]]);
    expect(outcome.run.status).toBe("done");
    expect(outcome.run.pendingAction).toBeNull();
  });

  it.each([
    ["the URL changed", page(FORM_FILLED, "https://x.yclients.com/other")],
    ["the ref now names another button", page(`- textbox "Введите имя" [ref=e1] value="Илья"\n- textbox "Номер телефона" [ref=e2] value="+79160000000"\n- button "Удалить запись" [ref=e3]`)],
    ["the form was re-rendered with other data", page(`- textbox "Введите имя" [ref=e1] value="Пётр"\n- textbox "Номер телефона" [ref=e2] value="+79160000000"\n- button "Записаться" [ref=e3]`)],
    ["only prose outside the action table changed", page(`- heading "К оплате 10 000 ₽"\n${FORM_FILLED}`)],
  ])("refuses without a click when %s", async (_case, now) => {
    const { calls, driver } = scriptedDriver([now]);
    const { jev } = queuedJev([]);
    const shown = _case === "only prose outside the action table changed" ? page(`- heading "К оплате 100 ₽"\n${FORM_FILLED}`) : page(FORM_FILLED);
    const pending = run({ pendingAction: pendingOn(shown), startUrl: null, status: "confirming" });

    const outcome = await performPendingAction(pending, deps(driver, jev));

    expect(outcome.run.status).toBe("failed");
    expect(outcome.summary).toMatch(/ничего не нажимала/u);
    expect(calls.some((c) => c[0] === "click")).toBe(false);
  });

  it("reports a failed confirmed click as unknown and does not retry it", async () => {
    const { calls, driver } = scriptedDriver([page(FORM_FILLED)], { clickError: "timeout" });
    const { jev } = queuedJev([]);
    const pending = run({ pendingAction: pendingOn(page(FORM_FILLED)), startUrl: null, status: "confirming" });

    const outcome = await performPendingAction(pending, deps(driver, jev));

    expect(outcome.run.status).toBe("failed");
    expect(outcome.summary).toMatch(/неизвестно/u);
    expect(calls.filter((c) => c[0] === "click")).toHaveLength(1);
  });

  it("keeps a verification reserve for the check after a click confirmed late in the budget", async () => {
    const { driver } = scriptedDriver([page(FORM_FILLED), page(THANKS)], { text: "Вы записаны" });
    const { jev } = queuedJev([decision("DONE", 0.9)]);
    const pending = run({ activeMillis: 179_000, pendingAction: pendingOn(page(FORM_FILLED)), startUrl: null, status: "confirming" });

    const outcome = await performPendingAction(pending, deps(driver, jev));

    expect(outcome.run.status).toBe("done");
  });
});
