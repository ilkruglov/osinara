/**
 * The browser tools of Mia: look at a page by numbers, act by number, stop for a human by rule.
 *
 * Exports:
 * - `createBrowserTools`: dependency-injected `browser_open`, `browser_look`, `browser_act`,
 *   `browser_confirm`, `browser_read`, `browser_session`.
 * - `BrowserToolDependencies`, `BLOCKED_HOSTS`.
 *
 * Key constructs:
 * - A look marks the page in the page itself (`som-script.ts`), screenshots it, asks the vision
 *   model what the screen is and what blocks it, and stores all of it as the last look of the
 *   sandbox. Numbers are valid for that epoch only; an act with another epoch is refused.
 * - The gate (`gate.ts`) runs inside `browser_act` before anything happens: a gated click is not
 *   performed but parked as the pending click, and `browser_confirm` performs exactly that click
 *   under user approval, after checking that the page did not change since the look.
 * - Fills from the form profile put the value into the page without ever returning it.
 * - Every tool call is one Chromium of the zone; the child agent and the root share it.
 */
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import { isAppError } from "../app-error.js";
import { ModelFacingError } from "../model-facing-error.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { type FormProfile, type ProfileField, resolveFieldValue, upsertProfileField } from "./form-profile.js";
import type { FormProfileOwner } from "./form-profile-repository.js";
import type { BrowserDriver } from "./browser-driver.js";
import { type ActAction, type EnteredField, gateDecision } from "./gate.js";
import type { BrowserLook, PendingClick, VisionView } from "./look-repository.js";
import { type PageView, parsePageView, renderElements, viewHash } from "./page-view.js";
import { actScript, clearScript, markScript, type SomAction, textHashScript } from "./som-script.js";

export type WorkspaceScope = "family" | "personal";

export interface BrowserToolDependencies {
  approvalEvidence(ctx: ToolContext, input: unknown): Promise<void>;
  driver(ctx: ToolContext, sandbox: string): BrowserDriver;
  loadProfile(auth: WorkspaceAuthorization, owner: FormProfileOwner): Promise<FormProfile>;
  log(event: Record<string, unknown>): void;
  looks: {
    addEntered(sandbox: string, familyId: string, entry: EnteredField): Promise<void>;
    get(sandbox: string, familyId: string): Promise<BrowserLook | null>;
    reset(sandbox: string, familyId: string): Promise<void>;
    saveLook(input: { familyId: string; sandboxSessionId: string; screenshotPath: string | null; view: PageView; viewHash: string; vision: VisionView | null }): Promise<BrowserLook>;
    setPending(sandbox: string, familyId: string, pending: PendingClick | null): Promise<void>;
  };
  now(): number;
  sandboxSessionId(ctx: ToolContext): string;
  saveProfileField(auth: WorkspaceAuthorization, owner: FormProfileOwner, input: { domains: readonly string[]; field: string; value: string }): Promise<ProfileField>;
  /** Describes the screenshot at `path` of `scope`; `null` when the model has no image input. */
  vision(auth: WorkspaceAuthorization, scope: WorkspaceScope, path: string, question: string): Promise<string | null>;
}

/** Where a booking flow never leads: messengers, app stores, downloads. The loop wandered there. */
export const BLOCKED_HOSTS: readonly string[] = ["t.me", "telegram.me", "telegram.org", "wa.me", "api.whatsapp.com", "apps.apple.com", "play.google.com", "vk.me"];
const READ_MAX_CHARACTERS = 20_000;
const FIELD_NAME = z.string().min(1).max(64);
const VISION_QUESTION = "Это скриншот страницы в браузере с красными номерками у элементов. Ответь строго JSON без пояснений: "
  + '{"screen":"какой это экран, одной фразой","selected":["что на экране выбрано или отмечено"],"blockers":["что мешает продолжить: модалка, cookies, капча, форма входа, ошибка"],"note":"что ещё важно для задачи, одной фразой или пусто"}';

function stale(reason: string): ModelFacingError {
  return new ModelFacingError({
    category: "operation", code: "AGENT_BROWSER_STALE",
    correction: "Вызовите browser_look и выберите номер заново; старые номера больше ничего не обозначают.",
    reason, retryable: false, sideEffectStatus: "not_started",
  });
}

function forbidden(reason: string): ModelFacingError {
  return new ModelFacingError({
    category: "authorization", code: "AGENT_BROWSER_FORBIDDEN", correction: "Не повторяйте вызов; объясните, что действие недоступно здесь.",
    reason, retryable: false, sideEffectStatus: "not_started",
  });
}

function scopeOf(auth: WorkspaceAuthorization): WorkspaceScope {
  return auth.telegramChatType === "private" ? "personal" : "family";
}

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return ""; } }

function blockedHost(url: string): boolean {
  const host = hostOf(url).toLowerCase();
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function parseVision(text: string | null): VisionView | null {
  if (text === null) return null;
  const match = /\{[\s\S]*\}/u.exec(text);
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 6) : [];
  try {
    const raw = match ? JSON.parse(match[0]) as Record<string, unknown> : {};
    return {
      blockers: strings(raw.blockers), note: typeof raw.note === "string" ? raw.note.slice(0, 300) : match ? "" : text.slice(0, 300),
      screen: typeof raw.screen === "string" ? raw.screen.slice(0, 200) : "", selected: strings(raw.selected),
    };
  } catch {
    return { blockers: [], note: text.slice(0, 300), screen: "", selected: [] };
  }
}

function present(look: BrowserLook, view: PageView) {
  return {
    elements: renderElements(view),
    entered: look.entered.map((e) => e.label),
    epoch: look.epoch,
    ...(look.screenshotPath === null ? {} : { screenshot: look.screenshotPath }),
    title: look.title,
    url: look.url,
    view: look.view,
  };
}

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), n: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("fill"), n: z.number().int().positive(), field: FIELD_NAME.optional(), text: z.string().max(2_000).optional() }).strict()
    .refine((a) => (a.field === undefined) !== (a.text === undefined), "передайте либо field анкеты, либо text"),
  z.object({ kind: z.literal("select"), n: z.number().int().positive(), option: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("enter"), n: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("press"), key: z.string().min(1).max(32) }).strict(),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["down", "up"]) }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
]);

export function createBrowserTools(deps: BrowserToolDependencies) {
  interface Bound { auth: WorkspaceAuthorization; ctx: ToolContext; driver: BrowserDriver; owner: FormProfileOwner; sandbox: string; scope: WorkspaceScope; }

  function bind(ctx: ToolContext): Bound {
    const auth = requireWorkspaceAuthorization(ctx);
    if (auth.userId === null || auth.role === "external") throw forbidden("Браузер доступен только участникам семьи");
    if (auth.telegramChatType !== "private" && auth.groupType !== "family_private") throw forbidden("Браузер доступен только в личном чате и семейной группе");
    const sandbox = deps.sandboxSessionId(ctx);
    return { auth, ctx, driver: deps.driver(ctx, sandbox), owner: { familyId: auth.familyId, groupId: auth.groupId, userId: auth.userId }, sandbox, scope: scopeOf(auth) };
  }

  let counter = 0;
  async function look(b: Bound, question?: string) {
    const epoch = `${deps.now().toString(36)}-${(counter += 1).toString(36)}`;
    const view = parsePageView(await b.driver.eval(markScript(epoch)));
    const relativePath = `shots/look-${epoch}.png`;
    let screenshotPath: string | null = relativePath;
    try {
      await b.driver.screenshot(`/workspace/${b.scope}/${relativePath}`);
    } catch (error) {
      screenshotPath = null;
      deps.log({ code: "AGENT_BROWSER_SCREENSHOT_FAILED", reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
    await b.driver.eval(clearScript());
    let vision: VisionView | null = null;
    if (screenshotPath !== null) {
      try {
        vision = parseVision(await deps.vision(b.auth, b.scope, screenshotPath, question === undefined ? VISION_QUESTION : `${VISION_QUESTION}\nДополнительно ответь в note: ${question}`));
      } catch (error) {
        deps.log({ code: "AGENT_BROWSER_VISION_FAILED", reason: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
    }
    const saved = await deps.looks.saveLook({ familyId: b.auth.familyId, sandboxSessionId: b.sandbox, screenshotPath, view, viewHash: viewHash(view), vision });
    deps.log({ code: "AGENT_BROWSER_LOOK", elements: view.elements.length, epoch, host: hostOf(view.url), steps: saved.steps, vision: vision !== null });
    return present(saved, view);
  }

  async function currentLook(b: Bound, epoch: string): Promise<{ look: BrowserLook; view: PageView }> {
    const look = await deps.looks.get(b.sandbox, b.auth.familyId);
    if (!look) throw stale("Страница ещё не просмотрена");
    if (look.epoch !== epoch) throw stale(`Номера эпохи ${epoch} устарели, текущая ${look.epoch}`);
    return { look, view: { elements: look.elements, epoch: look.epoch, textHash: look.textHash, title: look.title, url: look.url } };
  }

  async function runScript(b: Bound, script: string): Promise<{ ok: true; src?: string } | { ok: false; reason: string }> {
    const raw = await b.driver.eval(script);
    try {
      return JSON.parse(raw) as { ok: true; src?: string } | { ok: false; reason: string };
    } catch {
      return { ok: false, reason: `неожиданный ответ страницы: ${raw.slice(0, 80)}` };
    }
  }

  async function changedSince(b: Bound, look: BrowserLook): Promise<{ changed: boolean; url: string }> {
    await b.driver.settle();
    const url = await b.driver.url();
    if (url !== look.url) return { changed: true, url };
    const hash = Number(await b.driver.eval(textHashScript()));
    return { changed: Number.isFinite(hash) && hash !== look.textHash, url };
  }

  async function performClick(b: Bound, look: BrowserLook, n: number) {
    const result = await runScript(b, actScript(look.epoch, n, { kind: "click" }));
    if (!result.ok) throw stale(result.reason === "stale" ? "Страница перестроилась после просмотра" : `Элемент ${n} исчез (${result.reason})`);
    return await changedSince(b, look);
  }

  const open = defineTool({
    description: [
      "Открыть адрес в браузере семьи и сразу посмотреть страницу (как browser_look). Только http(s); мессенджеры, магазины приложений и загрузки не открывает.",
      "Сессия браузера одна на чат и живёт между вызовами: логины и cookies сохраняются. Если адрес записи на сайт есть в памяти (attribute «адрес онлайн-записи»), начинай с него.",
    ].join(" "),
    inputSchema: z.object({ url: z.string().url().max(2_048) }).strict(),
    async execute(input, ctx) {
      const b = bind(ctx);
      if (!/^https?:$/u.test(new URL(input.url).protocol) || blockedHost(input.url)) throw forbidden(`Адрес ${hostOf(input.url)} для задач в браузере не открывается`);
      await b.driver.open(input.url);
      await b.driver.settle();
      return await look(b);
    },
  });

  const lookTool = defineTool({
    description: [
      "Посмотреть текущую страницу: элементы с номерами (роль, текст, значение, состояние), адрес, заголовок, описание экрана от зрения (view: что за экран, что выбрано, что мешает) и путь скриншота в workspace.",
      "Номера действительны только для возвращённой epoch: после любого действия смотри заново. Показаны только элементы на экране; ниже по странице — после browser_act scroll.",
      "question: свой вопрос к скриншоту, ответ придёт в view.note. Для подробного разбора картинки есть inspect_workspace_image с путём screenshot.",
    ].join(" "),
    inputSchema: z.object({ question: z.string().min(1).max(300).optional() }).strict(),
    async execute(input, ctx) {
      return await look(bind(ctx), input.question);
    },
  });

  const act = defineTool({
    description: [
      "Одно действие на странице по номеру из последнего browser_look: click, fill (text или field анкеты: phone, name, email, surname), select option, enter во встроенный виджет (элемент frame), press key, scroll down|up, back.",
      "Ответ: changed=true, если адрес или текст страницы изменились; иначе действие не подействовало, не повторяй его подряд больше одного раза.",
      "Кнопки отправки, оплаты, удаления и любой клик после ввода данных анкеты инструмент не выполняет, а возвращает status=confirmation_required со скриншотом: покажи человеку скриншот и сводку, после согласия вызови browser_confirm.",
      "AGENT_BROWSER_STALE значит, что страница перестроилась: вызови browser_look и выбери номер заново.",
    ].join(" "),
    inputSchema: z.object({ action: actionSchema, epoch: z.string().min(1).max(64) }).strict(),
    async execute(input, ctx) {
      const b = bind(ctx);
      const { look: last, view } = await currentLook(b, input.epoch);
      const action = input.action;
      const n = "n" in action ? action.n : null;
      const element = n === null ? null : view.elements.find((e) => e.n === n) ?? null;
      if (n !== null && element === null) throw stale(`Номера ${n} нет в текущем просмотре`);

      const gate = gateDecision({ action: action as ActAction, entered: last.entered, n, view });
      if (gate.gated && element !== null && n !== null) {
        const pending: PendingClick = { element, epoch: last.epoch, n, reason: gate.reason! };
        await deps.looks.setPending(b.sandbox, b.auth.familyId, pending);
        deps.log({ code: "AGENT_BROWSER_GATED", element: element.text, host: hostOf(last.url), reason: gate.reason });
        return {
          element: `${element.role} ${element.text}`, entered: last.entered.map((e) => e.label), epoch: last.epoch, n, reason: gate.reason,
          ...(last.screenshotPath === null ? {} : { screenshot: last.screenshotPath }), status: "confirmation_required", url: last.url,
        };
      }

      switch (action.kind) {
        case "click": return { ...await performClick(b, last, action.n), status: "done" };
        case "fill": {
          let text = action.text ?? null;
          if (action.field !== undefined) {
            const profile = await deps.loadProfile(b.auth, b.owner);
            text = resolveFieldValue({ allowedFields: [action.field], domain: hostOf(last.url), extraData: {}, field: action.field, profile });
            if (text === null) {
              return { field: action.field, status: "field_missing", summary: `В анкете нет поля ${action.field} для сайта ${hostOf(last.url)}: спроси человека и сохрани через browser_session save_field` };
            }
          }
          const result = await runScript(b, actScript(last.epoch, action.n, { kind: "fill", text: text! }));
          if (!result.ok) throw stale(result.reason === "stale" ? "Страница перестроилась после просмотра" : `Поле ${action.n}: ${result.reason}`);
          if (action.field !== undefined) await deps.looks.addEntered(b.sandbox, b.auth.familyId, { field: action.field, label: element!.text, n: action.n });
          return { ...await changedSince(b, last), status: "done" };
        }
        case "select": {
          const result = await runScript(b, actScript(last.epoch, action.n, { kind: "select", option: action.option } satisfies SomAction));
          if (!result.ok) throw stale(result.reason === "stale" ? "Страница перестроилась после просмотра" : `Список ${action.n}: ${result.reason}`);
          return { ...await changedSince(b, last), status: "done" };
        }
        case "enter": {
          const result = await runScript(b, actScript(last.epoch, action.n, { kind: "enter" }));
          if (!result.ok || !result.src) throw stale(`Элемент ${action.n} не встроенный виджет`);
          if (blockedHost(result.src)) throw forbidden(`Виджет ведёт на ${hostOf(result.src)}, туда задачи не идут`);
          await b.driver.open(result.src);
          return { ...await changedSince(b, last), status: "done" };
        }
        case "press": await b.driver.press(action.key); return { ...await changedSince(b, last), status: "done" };
        case "scroll": await b.driver.scroll(action.direction); return { ...await changedSince(b, last), status: "done" };
        case "back": await b.driver.back(); return { ...await changedSince(b, last), status: "done" };
      }
    },
  });

  const confirm = defineTool({
    approval: () => "user-approval",
    description: [
      "Выполнить ровно тот клик, который browser_act вернул как confirmation_required, после согласия человека. Требует подтверждения кнопкой.",
      "Если страница изменилась после показа сводки, ничего не нажимает и возвращает status=stale: посмотри заново и покажи человеку новую сводку.",
    ].join(" "),
    inputSchema: z.object({ epoch: z.string().min(1).max(64), n: z.number().int().positive() }).strict(),
    async execute(input, ctx) {
      const b = bind(ctx);
      await deps.approvalEvidence(ctx, input);
      const { look: last } = await currentLook(b, input.epoch);
      const pending = last.pending;
      if (!pending || pending.epoch !== input.epoch || pending.n !== input.n) throw stale("Такого отложенного клика нет: сначала browser_act, который вернул confirmation_required");
      const before = await changedSince(b, last);
      if (before.changed) {
        await deps.looks.setPending(b.sandbox, b.auth.familyId, null);
        return { status: "stale", summary: "Страница изменилась с момента показа сводки, ничего не нажимала", url: before.url };
      }
      let outcome: { changed: boolean; url: string };
      try {
        outcome = await performClick(b, last, input.n);
      } catch (error) {
        await deps.looks.setPending(b.sandbox, b.auth.familyId, null);
        if (isAppError(error) && error.code === "AGENT_BROWSER_STALE") throw error;
        throw new ModelFacingError({
          category: "operation", code: "AGENT_BROWSER_CONFIRM_AMBIGUOUS", correction: "Не нажимайте повторно; попросите человека проверить результат на сайте.",
          reason: `Нажатие «${pending.element.text}» закончилось ошибкой, и неизвестно, принял ли его сайт`, retryable: false, sideEffectStatus: "unknown",
        });
      }
      await deps.looks.setPending(b.sandbox, b.auth.familyId, null);
      deps.log({ code: "AGENT_BROWSER_CONFIRMED", element: pending.element.text, host: hostOf(last.url) });
      return { ...outcome, status: "done" };
    },
  });

  const read = defineTool({
    description: "Текст видимой страницы браузера, до 20 000 символов: чтобы прочитать содержимое или найти подтверждение результата («Вы записаны на …»).",
    inputSchema: z.object({}).strict(),
    async execute(_input, ctx) {
      const b = bind(ctx);
      const text = (await b.driver.readText()).replace(/\s+/gu, " ").trim();
      return { text: text.slice(0, READ_MAX_CHARACTERS), truncated: text.length > READ_MAX_CHARACTERS, url: await b.driver.url() };
    },
  });

  const session = defineTool({
    description: [
      "status: адрес, epoch, сколько шагов и какие поля анкеты введены на этой странице. reset: закрыть вкладки и забыть введённое; логины сохраняются.",
      "save_field: сохранить в анкету человека значение поля (phone, name, email, surname), которое он только что продиктовал; domains по умолчанию — сайт текущей страницы, * только если человек сказал «везде».",
    ].join(" "),
    inputSchema: z.discriminatedUnion("action", [
      z.object({ action: z.literal("status") }).strict(),
      z.object({ action: z.literal("reset") }).strict(),
      z.object({ action: z.literal("save_field"), domains: z.array(z.string().min(1).max(253)).min(1).max(8).optional(), field: FIELD_NAME, value: z.string().min(1).max(512) }).strict(),
    ]),
    async execute(input, ctx) {
      const b = bind(ctx);
      const last = await deps.looks.get(b.sandbox, b.auth.familyId);
      if (input.action === "status") {
        return last === null ? { status: "idle" } : { entered: last.entered.map((e) => e.label), epoch: last.epoch, pending: last.pending?.element.text ?? null, status: "active", steps: last.steps, url: last.url };
      }
      if (input.action === "reset") {
        await deps.looks.reset(b.sandbox, b.auth.familyId);
        try { await b.driver.open("about:blank"); } catch { /* the next open starts fresh anyway */ }
        return { status: "reset" };
      }
      const domains = input.domains ?? (last ? [hostOf(last.url)].filter(Boolean) : []);
      if (domains.length === 0) {
        throw new ModelFacingError({
          category: "input", code: "AGENT_BROWSER_DOMAINS_REQUIRED", correction: "Передайте domains: сайт, для которого человек разрешил это поле, или * если он сказал «везде».",
          reason: "Нет открытой страницы, поэтому домен для поля не выводится сам", retryable: false, sideEffectStatus: "not_started",
        });
      }
      try {
        upsertProfileField({}, { domains, field: input.field, value: input.value });
      } catch (error) {
        if (!isAppError(error)) throw error;
        throw new ModelFacingError({ category: "input", code: error.code, correction: "Такое поле в анкете хранить нельзя; заполнять его тоже нельзя.", reason: error.message, retryable: false, sideEffectStatus: "not_started" });
      }
      const stored = await deps.saveProfileField(b.auth, b.owner, { domains, field: input.field, value: input.value });
      return { saved: { domains: stored.domains, field: input.field.trim() }, status: "saved" };
    },
  });

  return { browser_act: act, browser_confirm: confirm, browser_look: lookTool, browser_open: open, browser_read: read, browser_session: session };
}
