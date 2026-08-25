/**
 * Semantic Telegram presentation for HITL requests.
 *
 * Exports:
 * - `TelegramApprovalPresenter`: asynchronous trusted approval presentation contract.
 * - `createTelegramApprovalPresenter`: injectable presenter with schedule subject resolution.
 * - `presentTelegramApproval`: production presenter backed by PostgreSQL repositories.
 */
import type { SessionContext } from "eve/context";

import { agentScheduleRepository } from "../agent-schedules/agent-schedule-repository.js";
import type {
  AgentScheduleRecord,
  AgentScheduleRecurrence,
} from "../agent-schedules/agent-schedule-record.js";
import { describeRecurrence } from "../agent-schedules/agent-schedule-recurrence.js";
import {
  type AgentScheduleAuthorization,
  requireAgentScheduleAuthorization,
} from "../agent-schedules/agent-schedule-context.js";
import { AppError } from "../app-error.js";
import {
  localizeTelegramInputRequest,
  type TelegramInputRequest,
} from "../telegram-interface.js";
import {
  GOOGLE_WORKSPACE_CONSEQUENCE,
  SCHEDULE_CONSEQUENCES,
} from "./approval-consequences.js";
import {
  approvalFact,
  buildApprovalMessage,
  googleWorkspaceFacts,
  sanitizeApprovalLine,
} from "./approval-message.js";

interface ApprovalPresentationDependencies {
  findSchedule(auth: AgentScheduleAuthorization, id: string): Promise<AgentScheduleRecord | null>;
}

export type TelegramApprovalPresenter = (
  request: TelegramInputRequest,
  ctx: Pick<SessionContext, "session">,
) => Promise<TelegramInputRequest>;

const SCHEDULE_ACTIONS: Readonly<Record<string, { action: string }>> = {
  create: {
    action: "Создать агентное расписание",
      },
  delete: {
    action: "Удалить агентное расписание",
      },
  pause: {
    action: "Приостановить агентное расписание",
      },
  resume: {
    action: "Возобновить агентное расписание",
      },
  run_now: {
    action: "Запустить агентное расписание сейчас",
      },
  update: {
    action: "Изменить агентное расписание",
      },
};

function scheduleDate(schedule: AgentScheduleRecord): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: schedule.timezone,
  }).format(new Date(schedule.nextRunAt));
}

function requestedRecurrence(value: unknown): AgentScheduleRecurrence {
  // Presentation accepts only the recurrence shapes it can explain unambiguously to the user.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось показать новую периодичность агентного расписания",
    );
  }
  const recurrence = value as Record<string, unknown>;
  if (recurrence.kind === "once") return { kind: "once" };
  if (recurrence.kind === "daily" && typeof recurrence.interval === "number") {
    return { interval: recurrence.interval, kind: "daily" };
  }
  if (
    recurrence.kind === "weekly" &&
    typeof recurrence.interval === "number" &&
    Array.isArray(recurrence.daysOfWeek) &&
    recurrence.daysOfWeek.every((day) => typeof day === "number")
  ) {
    return {
      daysOfWeek: recurrence.daysOfWeek as number[],
      interval: recurrence.interval,
      kind: "weekly",
    };
  }
  throw new AppError(
    "AGENT_APPROVAL_INPUT_INVALID",
    "Не удалось показать новую периодичность агентного расписания",
  );
}

function scheduleChanges(input: Record<string, unknown>): string[] {
  // Show only fields that the approved update will replace; the technical schedule ID is excluded.
  const changes: string[] = [];
  if (typeof input.title === "string") changes.push(`Название: ${input.title}`);
  if (typeof input.userRequest === "string") changes.push(`Назначение: ${input.userRequest}`);
  if (input.recurrence !== undefined) {
    changes.push(`Периодичность: ${describeRecurrence(requestedRecurrence(input.recurrence))}`);
  }
  if (typeof input.nextRunAt === "string") changes.push(`Следующий запуск: ${input.nextRunAt}`);
  if (typeof input.scenarioPrompt === "string") {
    changes.push(`Сценарий: ${input.scenarioPrompt}`);
  }
  if (changes.length === 0) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось определить изменения агентного расписания",
    );
  }
  return changes;
}

function schedulePrompt(
  actionName: string,
  schedule: AgentScheduleRecord,
  changes: readonly string[],
): string {
  // Одна и та же структура во всех окнах: заголовок, факты, последствие. Значения расписания
  // проходят ту же очистку, что и остальные факты, поэтому перенос строки в названии или сценарии
  // не может дорисовать строку, выглядящую как строка приложения.
  return buildApprovalMessage({
    actionLabel: lowerFirst(SCHEDULE_ACTIONS[actionName]!.action),
    consequence: SCHEDULE_CONSEQUENCES[actionName]!,
    facts: [
      ...approvalFact("Расписание", schedule.title),
      ...approvalFact("Назначение", schedule.userRequest),
      ...approvalFact("Периодичность", describeRecurrence(schedule.recurrence)),
      ...approvalFact("Следующий запуск", `${scheduleDate(schedule)} (${schedule.timezone})`),
      ...approvalFact("Сценарий", schedule.scenarioPrompt),
    ],
    // Отдельным блоком: предлагаемые значения обязаны быть визуально отделены от текущих, иначе
    // две строки «Сценарий:» — сохранённая и новая — читаются как одна.
    // `scheduleChanges` уже формирует строки «Метка: значение», поэтому им нужна только очистка.
    ...(changes.length === 0
      ? {}
      : { section: { lines: changes.map(sanitizeApprovalLine), title: "Изменения:" } }),
  });
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}


export function createTelegramApprovalPresenter(
  dependencies: ApprovalPresentationDependencies,
): TelegramApprovalPresenter {
  return async (request, ctx) => {
    const localized = localizeTelegramInputRequest(request);
    if (
      request.display === "confirmation" &&
      request.action.toolName === "execute_google_workspace"
    ) {
      return {
        ...localized,
        prompt: buildApprovalMessage({
          actionLabel: "изменение в Google Workspace",
          consequence: GOOGLE_WORKSPACE_CONSEQUENCE,
          facts: googleWorkspaceFacts(request.action.input),
        }),
      };
    }
    if (
      request.display !== "confirmation" ||
      request.action.toolName !== "manage_agent_schedule"
    ) return localized;

    const actionName = request.action.input.action;
    if (typeof actionName !== "string" || !SCHEDULE_ACTIONS[actionName]) {
      throw new AppError(
        "AGENT_APPROVAL_ACTION_INVALID",
        "Не удалось определить действие с агентным расписанием",
      );
    }
    if (actionName === "create") return localized;

    const id = request.action.input.id;
    if (typeof id !== "string" || !id) {
      throw new AppError(
        "AGENT_APPROVAL_SUBJECT_INVALID",
        "Не удалось определить агентное расписание для подтверждения",
      );
    }
    const schedule = await dependencies.findSchedule(requireAgentScheduleAuthorization(ctx), id);
    if (!schedule) {
      throw new AppError(
        "AGENT_APPROVAL_SUBJECT_NOT_FOUND",
        "Агентное расписание для подтверждения не найдено или больше недоступно",
      );
    }
    const changes = actionName === "update" ? scheduleChanges(request.action.input) : [];
    return {
      ...localized,
      prompt: schedulePrompt(actionName, schedule, changes),
    };
  };
}

export const presentTelegramApproval = createTelegramApprovalPresenter({
  findSchedule: (auth, id) => agentScheduleRepository.findById(auth, id),
});
