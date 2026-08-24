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
import { buildApprovalMessage, googleWorkspaceFacts } from "./approval-message.js";

interface ApprovalPresentationDependencies {
  findSchedule(auth: AgentScheduleAuthorization, id: string): Promise<AgentScheduleRecord | null>;
}

export type TelegramApprovalPresenter = (
  request: TelegramInputRequest,
  ctx: Pick<SessionContext, "session">,
) => Promise<TelegramInputRequest>;

const SCHEDULE_ACTIONS: Readonly<Record<string, { action: string; consequence: string }>> = {
  create: {
    action: "Создать агентное расписание",
    consequence: "Будет создан новый автоматический запуск агента по указанному сценарию.",
  },
  delete: {
    action: "Удалить агентное расписание",
    consequence: "Расписание и все его будущие автоматические запуски будут удалены.",
  },
  pause: {
    action: "Приостановить агентное расписание",
    consequence: "Будущие автоматические запуски остановятся до ручного возобновления.",
  },
  resume: {
    action: "Возобновить агентное расписание",
    consequence: "Автоматические запуски возобновятся по сохранённому расписанию.",
  },
  run_now: {
    action: "Запустить агентное расписание сейчас",
    consequence: "Сценарий будет запущен один раз сейчас; обычное расписание не изменится.",
  },
  update: {
    action: "Изменить агентное расписание",
    consequence: "Сохранённые параметры расписания будут заменены указанными изменениями.",
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
  action: { action: string; consequence: string },
  schedule: AgentScheduleRecord,
  changes: readonly string[],
): string {
  return [
    "Подтверждение действия",
    "",
    `Действие: ${action.action}`,
    `Расписание: ${schedule.title}`,
    `Назначение: ${schedule.userRequest}`,
    `Периодичность: ${describeRecurrence(schedule.recurrence)}`,
    `Следующий запуск: ${scheduleDate(schedule)} (${schedule.timezone})`,
    `Сценарий: ${schedule.scenarioPrompt}`,
    ...(changes.length === 0 ? [] : ["", "Изменения:", ...changes]),
    "",
    `Что произойдёт: ${action.consequence}`,
  ].join("\n");
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
          consequence:
            "Команда будет выполнена один раз в текущем профиле. Автоматического повтора при ошибке не будет.",
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
      prompt: schedulePrompt(SCHEDULE_ACTIONS[actionName], schedule, changes),
    };
  };
}

export const presentTelegramApproval = createTelegramApprovalPresenter({
  findSchedule: (auth, id) => agentScheduleRepository.findById(auth, id),
});
