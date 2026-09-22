/**
 * Decision loop of browser_task: observe, let Jev choose, act, until a stop the model must handle.
 *
 * Exports:
 * - `runBrowserTaskLoop`: steps until done, a gate, a question for Mia, a block or a failure.
 * - `performPendingAction`: the one irreversible click after confirmation, then the loop again.
 * - `LOOP_LIMITS`: steps, time, handoffs, criteria.
 *
 * Key constructs:
 * - Jev never sees a value: it picks the field, the profile supplies the text.
 * - The gate is code: form context plus a submit-like name, or Jev's answer about the chosen
 *   element. Jev's DONE is a guess; the final page has to carry a quote.
 * - A page that did not change after an action counts against that action, and after two such
 *   counts the action leaves the table: the spike saw Jev re-click a selected service forever.
 */
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
}
export interface LoopOutcome {
  evidence: Array<{ quote: string }>;
  page: { title: string; url: string };
  question?: string;
  run: BrowserTaskRun;
  snapshotExcerpt?: string;
  summary: string;
}
export const LOOP_LIMITS = { maxCriteria: 250, maxHandoffs: 2, maxMillis: 180_000, maxSteps: 40, maxUnchanged: 3 } as const;

const RECENT_STEPS = 5;
const EXCERPT_MAX_CHARACTERS = 1_500;
const FINAL_QUESTION = "Нажатие элемента chosen_element прямо сейчас окончательно отправит форму, создаст запись, бронь, заказ или платёж. "
  + "Переход к форме, выбор филиала, услуги, мастера, даты, времени, адреса, отметка чекбокса и шаг Далее это НЕ окончательное действие";
const ACTION_QUESTION = "Какое действие сделать следующим, чтобы продвинуться к задаче на этой странице";

const signatureOf = (page: BrowserPage): string => `${page.url}|${page.table.elements.map((e) => `${e.name}=${e.value ?? ""}`).join("|")}`;
const keyOf = (operation: string, element: TableElement): string => `${operation}:${element.ref ?? element.name}`;
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return url; } };
const excerpt = (table: ElementTable): string => renderTable(table).slice(0, EXCERPT_MAX_CHARACTERS);

function outcome(run: BrowserTaskRun, page: BrowserPage, summary: string, extra: Partial<LoopOutcome> = {}): LoopOutcome {
  return { evidence: [], page: { title: page.title, url: page.url }, run, summary, ...extra };
}

function enteredSummary(run: BrowserTaskRun, page: BrowserPage, profile: FormProfile): string {
  const parts = run.entered.map(({ field, label }) => {
    const value = resolveFieldValue({ allowedFields: run.allowedFields, domain: hostOf(page.url), extraData: run.extraData, field, profile });
    return `${label}: ${value ?? "…"}`;
  });
  return parts.join(", ");
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
  const enteredValues = run.entered.map(({ field }) => resolveFieldValue({ allowedFields: run.allowedFields, domain: hostOf(page.url), extraData: run.extraData, field, profile: deps.profile }))
    .filter((value): value is string => value !== null);
  const goalWords = run.goal.split(/[^\p{L}\p{N}:]+/u).filter((word) => word.length >= 4);
  const evidence = findEvidence(text, [...SUCCESS_TERMS, ...enteredValues, ...goalWords]);
  run.status = evidence.length > 0 ? "done" : "unverified";
  return outcome(run, page, evidence.length > 0 ? `Готово: ${evidence[0]!.quote}` : "Похоже, задача выполнена, но подтверждения на странице не видно", { evidence });
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

async function isFinalStep(run: BrowserTaskRun, page: BrowserPage, element: TableElement, deps: LoopDependencies): Promise<boolean> {
  const formContext = hasFormContext(page.table);
  if (!formContext) return false;
  if (looksIrreversible(element, true)) return true;
  const decision = await deps.jev.decide(
    { chosen_element: `${element.role} ${element.name}`, page: renderTable(page.table), task: run.goal, url: page.url },
    { action: { criteria: { NO: "не окончательное действие", YES: "окончательное действие" }, instructions: ACTION_QUESTION, type: "choice" }, final: { instructions: FINAL_QUESTION, type: "noul" } },
  );
  return (decision.final ?? 0) >= FINAL_STEP_THRESHOLD;
}

async function actOn(run: BrowserTaskRun, page: BrowserPage, element: TableElement, operation: string, deps: LoopDependencies): Promise<LoopOutcome | null> {
  const { driver } = deps;
  switch (operation) {
    case "TYPE_TEXT": {
      const field = fieldForElement(element);
      const value = field === null ? null : resolveFieldValue({ allowedFields: run.allowedFields, domain: hostOf(page.url), extraData: run.extraData, field, profile: deps.profile });
      if (value === null) {
        return handOver(run, page, `Нужно значение для поля «${element.name}» на ${hostOf(page.url)}: в анкете его нет или оно не разрешено для этой задачи.`, false);
      }
      await driver.fill(element.ref!, value);
      run.entered.push({ field: field!, label: element.name });
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
      if (await isFinalStep(run, page, element, deps)) return gate(run, page, element, deps);
      await driver.clickText(element.name);
      return null;
    }
    default: {
      if (await isFinalStep(run, page, element, deps)) return gate(run, page, element, deps);
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

function gate(run: BrowserTaskRun, page: BrowserPage, element: TableElement, deps: LoopDependencies): LoopOutcome {
  const entered = enteredSummary(run, page, deps.profile);
  const summary = `${element.name} на ${hostOf(page.url)}${entered ? `. Данные: ${entered}` : ""}`;
  const pending: PendingAction = { label: element.name, ref: element.ref, summary, url: page.url };
  run.pendingAction = pending;
  run.status = "awaiting_confirmation";
  return outcome(run, page, summary);
}

export async function runBrowserTaskLoop(run: BrowserTaskRun, deps: LoopDependencies): Promise<LoopOutcome> {
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
    if (deps.now() - run.startedAt.getTime() >= LOOP_LIMITS.maxMillis) { run.status = "failed"; return outcome(run, page, "Исчерпан предел времени на прогон"); }

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
    const decision = await deps.jev.decide(state, { action: { criteria, instructions: ACTION_QUESTION, type: "choice" } });
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
    const stop = await actOn(run, page, element, choice.operation, deps);
    if (stop) return stop;
    run.history.push({ action: `${choice.operation}: ${element.role} ${element.name}`, confidence: decision.action.confidence, key: keyOf(choice.operation, element), url: page.url });
  }
}

export async function performPendingAction(run: BrowserTaskRun, deps: LoopDependencies): Promise<LoopOutcome> {
  const pending = run.pendingAction;
  const page = await deps.driver.snapshot();
  if (!pending) { run.status = "failed"; return outcome(run, page, "Нет отложенного шага для подтверждения"); }
  if (page.url !== pending.url) {
    run.status = "failed";
    return outcome(run, page, "Страница изменилась с момента показа сводки, подтверждение устарело");
  }
  if (pending.ref) await deps.driver.click(pending.ref);
  else await deps.driver.clickText(pending.label);
  run.pendingAction = null;
  run.status = "running";
  run.stepCount += 1;
  run.history.push({ action: `подтверждённый шаг: ${pending.label}`, confidence: 1, url: page.url });
  run.lastSignature = null;
  return await runBrowserTaskLoop(run, deps);
}
