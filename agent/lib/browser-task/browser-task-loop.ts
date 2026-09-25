/**
 * Decision loop of browser_task: observe, let Jev choose, act, until a stop the model must handle.
 *
 * Exports:
 * - `runBrowserTaskLoop`: steps until done, a gate, a question for Mia, a block or a failure.
 * - `performPendingAction`: the one irreversible click after confirmation, then the loop again.
 * - `pageHash`: what a confirmation is bound to besides the element.
 * - `LOOP_LIMITS`: steps, time, handoffs, criteria.
 *
 * Key constructs:
 * - Jev never sees a value: it picks the field, the profile supplies the text.
 * - The gate is code first: a transaction word anywhere or a submit word inside a form. Every
 *   other click is put to Jev as a final-step question. Jev's DONE is a guess; the final page has
 *   to carry a success phrase, and words of the goal or entered values never count as one.
 * - A confirmation is bound to the element's role and name and to a hash of the whole snapshot:
 *   headings, prose and field values, not just the action table. A single-page app may re-render
 *   the form or change "К оплате 100 ₽" into "10 000 ₽" while the person reads the summary.
 * - What was typed is what the confirmation shows: the value is kept with the entered field, so a
 *   profile edited after the fill cannot change the window while the browser sends the old value.
 * - Time counts only while the loop runs; the wait for a person is outside the budget, and a
 *   confirmed click always keeps enough budget to check what it did.
 * - Every Jev request carries the turn's abort signal and the remaining budget.
 * - A page that did not change after an action counts against that action, and after two such
 *   counts the action leaves the table: the spike saw Jev re-click a selected service forever.
 */
import { createHash } from "node:crypto";

import type { BrowserDriver, BrowserPage } from "./browser-driver.js";
import type { BrowserTaskRun, PendingAction } from "./browser-task-run-repository.js";
import { actionCriteria, type ElementTable, parseChoice, renderTable, STATIC_OPTIONS, type TableElement } from "./element-table.js";
import { findEvidence, SUCCESS_TERMS } from "./evidence.js";
import { fieldForElement, type FormProfile, resolveFieldValue } from "./form-profile.js";
import { ACTION_CONFIDENCE_THRESHOLD, FINAL_STEP_THRESHOLD, hasFormContext, looksIrreversible } from "./irreversible.js";
import type { JevClient, JevDecision } from "./jev-client.js";

export interface LoopDependencies {
  driver: BrowserDriver;
  jev: JevClient;
  log(event: Record<string, unknown>): void;
  now(): number;
  profile: FormProfile;
  signal?: AbortSignal;
}
export interface LoopOutcome {
  evidence: Array<{ quote: string }>;
  page: { title: string; url: string };
  question?: string;
  run: BrowserTaskRun;
  snapshotExcerpt?: string;
  summary: string;
}
export const LOOP_LIMITS = {
  maxCriteria: 250, maxHandoffs: 2, maxMillis: 180_000, maxSteps: 40, maxUnchanged: 3, verifyReserveMillis: 30_000,
} as const;

const RECENT_STEPS = 5;
const EXCERPT_MAX_CHARACTERS = 1_500;
const FINAL_QUESTION = "Нажатие элемента chosen_element прямо сейчас окончательно отправит форму, создаст запись, бронь, заказ или платёж. "
  + "Переход к форме, выбор филиала, услуги, мастера, даты, времени, адреса, отметка чекбокса и шаг Далее это НЕ окончательное действие";
const ACTION_QUESTION = "Какое действие сделать следующим, чтобы продвинуться к задаче на этой странице";

const signatureOf = (page: BrowserPage): string => `${page.url}|${page.table.elements.map((e) => `${e.name}=${e.value ?? ""}`).join("|")}`;
const keyOf = (operation: string, element: TableElement): string => `${operation}:${element.ref ?? element.name}`;
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return url; } };
const excerpt = (table: ElementTable): string => renderTable(table).slice(0, EXCERPT_MAX_CHARACTERS);

/** The whole snapshot without refs: a re-render with the same content keeps it, any edit does not. */
export function pageHash(page: BrowserPage): string {
  const content = page.content.replace(/\[?ref=e\d+\]?/gu, "").replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(`${page.url}\u0002${page.title}\u0002${content}`).digest("hex");
}

interface Budget { elapsed(): number; signal(): AbortSignal; }

function budgetFor(run: BrowserTaskRun, deps: LoopDependencies): Budget {
  const segmentStart = deps.now();
  const before = run.activeMillis;
  const elapsed = (): number => before + deps.now() - segmentStart;
  return {
    elapsed,
    signal() {
      const remaining = Math.max(1, LOOP_LIMITS.maxMillis - elapsed());
      const deadline = AbortSignal.timeout(remaining);
      return deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
    },
  };
}

function outcome(run: BrowserTaskRun, page: BrowserPage, summary: string, extra: Partial<LoopOutcome> = {}): LoopOutcome {
  return { evidence: [], page: { title: page.title, url: page.url }, run, summary, ...extra };
}

function enteredSummary(run: BrowserTaskRun): string {
  return run.entered.map(({ label, value }) => `${label}: ${value ?? "…"}`).join(", ");
}

function questionFrom(decision: JevDecision, table: ElementTable): string {
  const top = Object.entries(decision.action.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([choice, probability]) => {
      const parsed = parseChoice(choice, table);
      const label = parsed?.kind === "element" ? `${table.elements[parsed.index - 1]!.role} ${table.elements[parsed.index - 1]!.name}` : STATIC_OPTIONS[choice] ?? choice;
      return `${label} (${Math.round(probability * 100)}%)`;
    });
  return `Не уверена, что делать дальше. Варианты на странице: ${top.join("; ")}. Что выбрать или как переформулировать задачу?`;
}

async function verifyDone(run: BrowserTaskRun, page: BrowserPage, deps: LoopDependencies): Promise<LoopOutcome> {
  const text = await deps.driver.readText();
  // The goal's own words and the typed values are on the unsent form too; only a success phrase
  // tells the result apart from the form. The values then only add detail to the quotes.
  const success = findEvidence(text, SUCCESS_TERMS);
  if (success.length === 0) {
    run.status = "unverified";
    return outcome(run, page, "Похоже, задача выполнена, но подтверждения на странице не видно", { evidence: [] });
  }
  const enteredValues = run.entered.map(({ value }) => value).filter((value): value is string => typeof value === "string");
  const details = findEvidence(text, enteredValues).filter((d) => !success.some((s) => s.quote === d.quote));
  const evidence = [...success, ...details].slice(0, 3);
  run.status = "done";
  return outcome(run, page, `Готово: ${evidence[0]!.quote}`, { evidence });
}

function handOver(run: BrowserTaskRun, page: BrowserPage, question: string, countsAsHandoff: boolean): LoopOutcome {
  if (countsAsHandoff) {
    if (run.handoffCount >= LOOP_LIMITS.maxHandoffs) {
      run.status = "blocked";
      return outcome(run, page, "Не удалось продвинуться даже с подсказками", { snapshotExcerpt: excerpt(page.table) });
    }
    run.handoffCount += 1;
  }
  run.status = "needs_plan";
  return outcome(run, page, question, { question, snapshotExcerpt: excerpt(page.table) });
}

async function isFinalStep(run: BrowserTaskRun, page: BrowserPage, element: TableElement, deps: LoopDependencies, budget: Budget): Promise<boolean> {
  if (looksIrreversible(element, hasFormContext(page.table))) return true;
  const decision = await deps.jev.decide(
    { chosen_element: `${element.role} ${element.name}`, page: renderTable(page.table), task: run.goal, url: page.url },
    { action: { criteria: { NO: "не окончательное действие", YES: "окончательное действие" }, instructions: ACTION_QUESTION, type: "choice" }, final: { instructions: FINAL_QUESTION, type: "noul" } },
    budget.signal(),
  );
  return (decision.final ?? 0) >= FINAL_STEP_THRESHOLD;
}

async function actOn(run: BrowserTaskRun, page: BrowserPage, element: TableElement, operation: string, deps: LoopDependencies, budget: Budget): Promise<LoopOutcome | null> {
  const { driver } = deps;
  switch (operation) {
    case "TYPE_TEXT": {
      const field = fieldForElement(element);
      const value = field === null ? null : resolveFieldValue({ allowedFields: run.allowedFields, domain: hostOf(page.url), extraData: run.extraData, field, profile: deps.profile });
      if (value === null) {
        return handOver(run, page, `Нужно значение для поля «${element.name}» на ${hostOf(page.url)}: в анкете его нет или оно не разрешено для этой задачи.`, false);
      }
      await driver.fill(element.ref!, value);
      run.entered.push({ field: field!, label: element.name, value });
      return null;
    }
    case "SELECT": {
      const parent = [...page.table.elements].reverse().find((e) => e.index < element.index && (e.role === "combobox" || e.role === "listbox"));
      if (parent?.ref) await driver.select(parent.ref, element.name);
      else await driver.clickText(element.name);
      return null;
    }
    case "ENTER": await driver.enterFrame(element.ref!); return null;
    case "TEXT": {
      if (await isFinalStep(run, page, element, deps, budget)) return gate(run, page, element);
      await driver.clickText(element.name);
      return null;
    }
    default: {
      if (await isFinalStep(run, page, element, deps, budget)) return gate(run, page, element);
      try {
        await driver.click(element.ref!);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const frame = [...page.table.elements].reverse().find((e) => e.operations.includes("ENTER"));
        if (/covered by <iframe/u.test(reason) && frame?.ref) {
          await driver.enterFrame(frame.ref);
          run.history.push({ action: `вошла во встроенный виджет после того, как ${element.name} оказался накрыт`, confidence: 1, url: page.url });
          return null;
        }
        throw error;
      }
      return null;
    }
  }
}

function gate(run: BrowserTaskRun, page: BrowserPage, element: TableElement): LoopOutcome {
  const entered = enteredSummary(run);
  const summary = `${element.name} на ${hostOf(page.url)}${entered ? `. Данные: ${entered}` : ""}`;
  const pending: PendingAction = { label: element.name, pageHash: pageHash(page), ref: element.ref, role: element.role, url: page.url };
  run.pendingAction = pending;
  run.status = "awaiting_confirmation";
  return outcome(run, page, summary);
}

export async function runBrowserTaskLoop(run: BrowserTaskRun, deps: LoopDependencies): Promise<LoopOutcome> {
  const budget = budgetFor(run, deps);
  try {
    return await loop(run, deps, budget);
  } finally {
    run.activeMillis = budget.elapsed();
  }
}

async function loop(run: BrowserTaskRun, deps: LoopDependencies, budget: Budget): Promise<LoopOutcome> {
  const { driver } = deps;
  if (run.stepCount === 0 && run.startUrl && run.lastUrl === null) await driver.open(run.startUrl);
  // Consecutive snapshots with the same signature; three means the page ignores everything we do.
  let unchanged = 0;
  for (;;) {
    const page = await driver.snapshot();
    const signature = signatureOf(page);
    const last = run.history.at(-1);
    if (run.lastSignature === signature) {
      unchanged += 1;
      if (last?.key) {
        run.failedActions[last.key] = (run.failedActions[last.key] ?? 0) + 1;
        run.history.push({ action: `страница не изменилась после ${last.action}`, confidence: last.confidence, url: page.url });
      }
    } else {
      unchanged = 0;
    }
    run.lastSignature = signature;
    run.lastUrl = page.url;

    if (unchanged >= LOOP_LIMITS.maxUnchanged) {
      run.status = "failed";
      return outcome(run, page, "Страница не меняется в ответ на действия, цикл остановлен", { snapshotExcerpt: excerpt(page.table) });
    }
    if (run.stepCount >= LOOP_LIMITS.maxSteps) { run.status = "failed"; return outcome(run, page, `Исчерпан предел в ${LOOP_LIMITS.maxSteps} шагов`); }
    if (budget.elapsed() >= LOOP_LIMITS.maxMillis) { run.status = "failed"; return outcome(run, page, "Исчерпан предел времени на прогон"); }

    const criteria = Object.fromEntries(Object.entries(actionCriteria(page.table)).filter(([choice]) => {
      const parsed = parseChoice(choice, page.table);
      if (parsed?.kind !== "element") return true;
      return (run.failedActions[keyOf(parsed.operation, page.table.elements[parsed.index - 1]!)] ?? 0) < 2;
    }).slice(0, LOOP_LIMITS.maxCriteria));
    const state = {
      hint: run.hint ?? undefined,
      page: renderTable(page.table),
      recent: run.history.slice(-RECENT_STEPS).map((step) => step.action),
      task: run.goal,
      url: page.url,
    };
    const decision = await deps.jev.decide(state, { action: { criteria, instructions: ACTION_QUESTION, type: "choice" } }, budget.signal());
    deps.log({ code: "AGENT_BROWSER_TASK_STEP", choice: decision.action.choice, confidence: decision.action.confidence, elements: page.table.elements.length, inputTokens: decision.usage.inputTokens, latencyMs: decision.latencyMs, step: run.stepCount + 1 });

    const choice = parseChoice(decision.action.choice, page.table);
    if (choice === null || choice.kind === "BLOCKED" || decision.action.confidence < ACTION_CONFIDENCE_THRESHOLD) {
      return handOver(run, page, questionFrom(decision, page.table), true);
    }
    if (choice.kind === "DONE") return await verifyDone(run, page, deps);

    run.stepCount += 1;
    if (choice.kind !== "element") {
      if (choice.kind === "WAIT") await driver.wait(1_500);
      else await driver.scroll(choice.kind === "SCROLL_DOWN" ? "down" : "up");
      run.history.push({ action: choice.kind, confidence: decision.action.confidence, key: choice.kind, url: page.url });
      continue;
    }
    const element = page.table.elements[choice.index - 1]!;
    const stop = await actOn(run, page, element, choice.operation, deps, budget);
    if (stop) return stop;
    run.history.push({ action: `${choice.operation}: ${element.role} ${element.name}`, confidence: decision.action.confidence, key: keyOf(choice.operation, element), url: page.url });
  }
}

function stale(run: BrowserTaskRun, page: BrowserPage, what: string): LoopOutcome {
  run.status = "failed";
  run.pendingAction = null;
  return outcome(run, page, `${what} с момента показа сводки, подтверждение устарело: ничего не нажимала`, { snapshotExcerpt: excerpt(page.table) });
}

/**
 * Called with the run already claimed as `confirming`. Any refusal here happens before the click;
 * a failed click is never retried, because the site may have taken it.
 */
export async function performPendingAction(run: BrowserTaskRun, deps: LoopDependencies): Promise<LoopOutcome> {
  const pending = run.pendingAction;
  const page = await deps.driver.snapshot();
  if (!pending || typeof pending.pageHash !== "string") return stale(run, page, "Отложенный шаг не найден");
  if (page.url !== pending.url) return stale(run, page, "Страница сменилась");
  const target = pending.ref === null
    ? page.table.elements.find((e) => e.ref === null && e.name === pending.label)
    : page.table.elements.find((e) => e.ref === pending.ref);
  if (!target || target.name !== pending.label || target.role !== pending.role) return stale(run, page, "Кнопка на странице теперь другая");
  if (pageHash(page) !== pending.pageHash) return stale(run, page, "Форма изменилась");

  // Waiting for the person is outside the budget; the check after the click must not be cut short.
  run.activeMillis = Math.min(run.activeMillis, LOOP_LIMITS.maxMillis - LOOP_LIMITS.verifyReserveMillis);
  try {
    if (pending.ref) await deps.driver.click(pending.ref);
    else await deps.driver.clickText(pending.label);
  } catch (error) {
    run.status = "failed";
    run.pendingAction = null;
    run.history.push({ action: `подтверждённый шаг ${pending.label} завершился ошибкой`, confidence: 1, url: page.url });
    deps.log({ code: "AGENT_BROWSER_TASK_CONFIRM_AMBIGUOUS", reason: error instanceof Error ? error.message : String(error) });
    return outcome(run, page, `Нажатие «${pending.label}» закончилось ошибкой, и неизвестно, принял ли его сайт. Повторно не нажимаю: проверьте результат на сайте или в письме`);
  }
  run.pendingAction = null;
  run.status = "running";
  run.stepCount += 1;
  run.history.push({ action: `подтверждённый шаг: ${pending.label}`, confidence: 1, url: page.url });
  run.lastSignature = null;
  return await runBrowserTaskLoop(run, deps);
}
