/**
 * `browser_task`: one tool that does a task on a website, with Jev in the click loop.
 *
 * Exports:
 * - `createBrowserTaskTool`: dependency-injected tool for tests.
 * - `BROWSER_TASK_AVAILABLE`: the tool is offered only when a Jev key is configured.
 * - Default: production tool.
 *
 * Key constructs:
 * - `start` and `resume` cannot do anything irreversible by construction; `confirm` does exactly
 *   one such step and is the only action that requires user approval.
 * - The form profile is read from the requester's personal workspace; a missing file is an empty
 *   profile, never an error, and the loop then asks instead of guessing.
 * - One active run per browser session: the browser has one tab state to share.
 */
import { defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { AppError, isAppError } from "../app-error.js";
import { type BrowserDriver, createSandboxBrowserDriver } from "../browser-task/browser-driver.js";
import { type LoopOutcome, performPendingAction, runBrowserTaskLoop } from "../browser-task/browser-task-loop.js";
import { type BrowserTaskRun, browserTaskRunRepository, type NewBrowserTaskRun } from "../browser-task/browser-task-run-repository.js";
import { type FormProfile, parseFormProfile, serializeFormProfile, upsertProfileField } from "../browser-task/form-profile.js";
import { createJevClient, type JevClient } from "../browser-task/jev-client.js";
import { ModelFacingError } from "../model-facing-error.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { workspaceBinaryRepository } from "../workspaces/workspace-binary-repository.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import type { WorkspaceAuthorization } from "../workspaces/workspace-repository.js";

const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY?.trim() ?? "";
export const BROWSER_TASK_AVAILABLE = TYPESAFE_API_KEY.length > 0;
const PROFILE_PATH = "forms/profile.json";
const FIELD_NAME = z.string().min(1).max(64);

export interface BrowserTaskDependencies {
  approvalEvidence(ctx: ToolContext, input: unknown): Promise<void>;
  driver(ctx: ToolContext, sandbox: string): BrowserDriver;
  jev(): JevClient;
  loadProfile(auth: WorkspaceAuthorization): Promise<FormProfile>;
  saveProfile(auth: WorkspaceAuthorization, profile: FormProfile, operationKey: string): Promise<void>;
  log(event: Record<string, unknown>): void;
  now(): number;
  runs: {
    activeForSandbox(sandboxSessionId: string): Promise<BrowserTaskRun | null>;
    create(input: NewBrowserTaskRun): Promise<BrowserTaskRun>;
    get(id: string, owner: { familyId: string; userId: string }): Promise<BrowserTaskRun | null>;
    save(run: BrowserTaskRun): Promise<void>;
  };
  sandboxSessionId(ctx: ToolContext): string;
}

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    allowedFields: z.array(FIELD_NAME).max(16).default([])
      .describe("Поля анкеты, которые для этой задачи можно подставлять: phone, name, email"),
    data: z.record(FIELD_NAME, z.string().max(512)).optional()
      .describe("Данные только для этого прогона, которых нет в анкете; спроси их у человека"),
    goal: z.string().min(1).max(2_000).describe("Что сделать на сайте, словами, с датами и предпочтениями"),
    scope: z.enum(["family", "personal"]).describe("personal в личном чате, family в семейной группе"),
    startUrl: z.string().url().optional().describe("Адрес, с которого начать, если известен"),
  }).strict(),
  z.object({ action: z.literal("resume"), hint: z.string().min(1).max(2_000), runId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("confirm"), runId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("cancel"), runId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("save_field"),
    domains: z.array(z.string().min(1).max(253)).min(1).max(8).optional()
      .describe("Где поле можно подставлять; по умолчанию сайт текущего прогона, * только если человек сказал «везде»"),
    field: FIELD_NAME.describe("Имя поля анкеты: phone, name, email, surname"),
    value: z.string().min(1).max(512).describe("Значение, которое человек только что продиктовал"),
  }).strict(),
]);

function forbidden(reason: string): ModelFacingError {
  return new ModelFacingError({
    category: "authorization", code: "AGENT_BROWSER_TASK_FORBIDDEN", correction: "Не повторяйте вызов; объясните, что действие недоступно здесь.",
    reason, retryable: false, sideEffectStatus: "not_started",
  });
}

function wrongState(run: BrowserTaskRun, expected: string): ModelFacingError {
  return new ModelFacingError({
    category: "operation", code: "AGENT_BROWSER_TASK_STATE_INVALID",
    correction: `Прогон в состоянии ${run.status}; это действие возможно только в состоянии ${expected}. Начните новый прогон, если задача ещё нужна.`,
    reason: `Прогон ${run.id} не в состоянии ${expected}`, retryable: false, sideEffectStatus: "not_started",
  });
}

function result(outcome: LoopOutcome) {
  return {
    evidence: outcome.evidence,
    page: outcome.page,
    ...(outcome.question === undefined ? {} : { question: outcome.question }),
    runId: outcome.run.id,
    ...(outcome.snapshotExcerpt === undefined ? {} : { snapshotExcerpt: outcome.snapshotExcerpt }),
    status: outcome.run.status,
    summary: outcome.summary,
  };
}

export function createBrowserTaskTool(deps: BrowserTaskDependencies) {
  async function owned(ctx: ToolContext, auth: WorkspaceAuthorization, runId: string): Promise<BrowserTaskRun> {
    const run = await deps.runs.get(runId, { familyId: auth.familyId, userId: auth.userId! });
    if (!run) {
      throw new ModelFacingError({
        category: "not_found", code: "AGENT_BROWSER_TASK_RUN_NOT_FOUND", correction: "Используйте runId из результата start этого же пользователя.",
        reason: `Прогон ${runId} не найден`, retryable: false, sideEffectStatus: "not_started",
      });
    }
    if (run.sandboxSessionId !== deps.sandboxSessionId(ctx)) throw forbidden("Прогон принадлежит другому разговору");
    return run;
  }

  return defineTool({
    approval: ({ toolInput }) => toolInput?.action === "confirm" ? "user-approval" : "not-applicable",
    description: [
      "Когда использовать: сделать что-то на сайте по описанию: записаться, забронировать, заполнить форму, найти и выбрать. Инструмент сам открывает страницы и нажимает; ты ставишь цель и отвечаешь на его вопросы.",
      "Не использовать: чтобы прочитать публичную страницу (web_fetch) или найти сайт (web_search).",
      "start: goal словами, startUrl если известен, scope, allowedFields из анкеты (phone, name, email), которые для этой задачи можно подставлять; data только для данных, которых в анкете нет, спроси их у человека.",
      "Статусы: done с evidence; unverified значит подтверждения на странице нет, так и скажи; awaiting_confirmation значит перескажи summary человеку и после его согласия вызови confirm; needs_plan значит ответь на question через resume с hint, при необходимости спроси человека; blocked и failed это конец прогона.",
      "confirm требует подтверждения кнопкой и делает ровно один необратимый шаг. Одновременно идёт один прогон; второй вызов start вернёт AGENT_BROWSER_TASK_BUSY.",
      "Анкету personal/forms/profile.json ведёшь ты через save_field: когда needs_plan просит значение поля, спроси человека, сохрани ответ через save_field (домены по умолчанию это сайт прогона), затем resume; JSON руками не пиши.",
    ].join(" "),
    inputSchema,
    async execute(input, ctx) {
      const auth = requireWorkspaceAuthorization(ctx);
      if (auth.userId === null) throw forbidden("Задачу в браузере ставит только участник с аккаунтом");
      const sandbox = deps.sandboxSessionId(ctx);
      if (input.action === "save_field") {
        const active = await deps.runs.activeForSandbox(sandbox);
        const site = active?.lastUrl ?? active?.startUrl ?? null;
        const domains = input.domains ?? (site ? [new URL(site).hostname] : []);
        if (domains.length === 0) {
          throw new ModelFacingError({
            category: "input", code: "AGENT_BROWSER_TASK_DOMAINS_REQUIRED", correction: "Передайте domains: сайт, для которого человек разрешил это поле, или * если он сказал «везде».",
            reason: "Нет активного прогона, поэтому домен для поля не выводится сам", retryable: false, sideEffectStatus: "not_started",
          });
        }
        let profile: FormProfile;
        try {
          profile = upsertProfileField(await deps.loadProfile(auth), { domains, field: input.field, value: input.value });
        } catch (error) {
          if (!isAppError(error)) throw error;
          throw new ModelFacingError({ category: "input", code: error.code, correction: "Такое поле в анкете хранить нельзя; заполнять его тоже нельзя.", reason: error.message, retryable: false, sideEffectStatus: "not_started" });
        }
        await deps.saveProfile(auth, profile, ctx.callId);
        return { saved: { domains: profile[input.field.trim()]!.domains, field: input.field.trim() }, status: "saved" };
      }
      const startedAt = deps.now();
      const loopDeps = { driver: deps.driver(ctx, sandbox), jev: deps.jev(), log: deps.log, now: deps.now, profile: await deps.loadProfile(auth) };

      let outcome: LoopOutcome;
      if (input.action === "start") {
        if (input.scope === "family" && auth.groupType !== "family_private") throw forbidden("scope family доступен только в семейной группе");
        if (input.scope === "personal" && auth.telegramChatType !== "private") throw forbidden("scope personal доступен только в личном чате");
        const active = await deps.runs.activeForSandbox(sandbox);
        if (active) {
          throw new ModelFacingError({
            category: "operation", code: "AGENT_BROWSER_TASK_BUSY",
            correction: `Дождитесь прогона ${active.id} (${active.status}) или отмените его через cancel.`,
            reason: "В этом разговоре уже идёт задача в браузере", retryable: false, sideEffectStatus: "not_started",
          });
        }
        const run = await deps.runs.create({
          allowedFields: input.allowedFields, extraData: input.data ?? {}, familyId: auth.familyId, goal: input.goal,
          sandboxSessionId: sandbox, scope: input.scope, startUrl: input.startUrl ?? null, userId: auth.userId,
        });
        outcome = await runBrowserTaskLoop(run, loopDeps);
      } else if (input.action === "resume") {
        const run = await owned(ctx, auth, input.runId);
        if (run.status !== "needs_plan") throw wrongState(run, "needs_plan");
        run.hint = input.hint;
        run.status = "running";
        outcome = await runBrowserTaskLoop(run, loopDeps);
      } else if (input.action === "confirm") {
        const run = await owned(ctx, auth, input.runId);
        if (run.status !== "awaiting_confirmation") throw wrongState(run, "awaiting_confirmation");
        // The approval is revalidated at the mutation boundary, like every other irreversible tool.
        await deps.approvalEvidence(ctx, input);
        outcome = await performPendingAction(run, loopDeps);
      } else {
        const run = await owned(ctx, auth, input.runId);
        run.status = "cancelled";
        run.pendingAction = null;
        await deps.runs.save(run);
        return { runId: run.id, status: run.status, summary: "Прогон отменён" };
      }
      await deps.runs.save(outcome.run);
      deps.log({
        code: "AGENT_BROWSER_TASK", action: input.action, elapsedMs: deps.now() - startedAt, handoffCount: outcome.run.handoffCount,
        status: outcome.run.status, stepCount: outcome.run.stepCount,
      });
      return result(outcome);
    },
  });
}

async function loadPersonalProfile(auth: WorkspaceAuthorization): Promise<FormProfile> {
  try {
    const file = await workspaceBinaryRepository.readBinary(auth, "personal", PROFILE_PATH);
    return parseFormProfile(Buffer.from(file.bytes).toString("utf8"));
  } catch (error) {
    if (isAppError(error) && (error.code === "AGENT_WORKSPACE_FILE_NOT_FOUND" || error.code === "AGENT_WORKSPACE_ACCESS_DENIED")) return {};
    if (isAppError(error) && error.code === "AGENT_BROWSER_TASK_PROFILE_INVALID") {
      throw new ModelFacingError({
        category: "input", code: error.code, correction: "Попросите человека поправить personal/forms/profile.json: у каждого поля нужны value и domains.",
        reason: error.message, retryable: false, sideEffectStatus: "not_started",
      });
    }
    throw error;
  }
}

async function savePersonalProfile(auth: WorkspaceAuthorization, profile: FormProfile, operationKey: string): Promise<void> {
  await workspaceBinaryRepository.writeBinary(auth, {
    bytes: Buffer.from(serializeFormProfile(profile), "utf8"),
    mediaType: "application/json",
    operationKey,
    path: PROFILE_PATH,
    scope: "personal",
  });
}

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export default createBrowserTaskTool({
  approvalEvidence: (ctx, input) => requireToolApprovalEvidence(ctx, "browser_task", input),
  driver: (ctx, sandbox) => createSandboxBrowserDriver({ runner, sandboxSessionId: sandbox, signal: ctx.abortSignal }),
  jev: () => {
    if (!BROWSER_TASK_AVAILABLE) throw new AppError("AGENT_BROWSER_TASK_UNAVAILABLE", "Сервис решений для задач в браузере не настроен");
    return createJevClient({ apiKey: TYPESAFE_API_KEY });
  },
  loadProfile: loadPersonalProfile,
  saveProfile: savePersonalProfile,
  log: (event) => console.info(JSON.stringify(event)),
  now: () => Date.now(),
  runs: browserTaskRunRepository,
  sandboxSessionId,
});
