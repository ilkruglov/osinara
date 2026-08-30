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
import type { GmailMessageApprovalSubject } from "../google-workspace/gmail-message-approval.js";
import { loadGmailMessageApproval } from "../google-workspace/gmail-message-approval.js";
import { requireGmailMessageInput } from "../google-workspace/gmail-message-contract.js";
import {
  localizeTelegramInputRequest,
  type TelegramInputRequest,
} from "../telegram-interface.js";

function googleWorkspacePrompt(input: Record<string, unknown>): string {
  const argv = input.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === "string")) {
    throw new AppError(
      "AGENT_APPROVAL_INPUT_INVALID",
      "Не удалось показать параметры команды Google Workspace",
    );
  }
  return [
    "Подтверждение изменения в Google Workspace",
    "",
    "Точные аргументы команды:",
    JSON.stringify(argv, null, 2),
    "",
    "После подтверждения команда будет выполнена один раз в текущем профиле.",
    "При ошибке автоматического повтора не будет.",
  ].join("\n");
}

interface ApprovalPresentationDependencies {
  findGmailMessage(
    messageId: string,
    profileRef: string,
    ctx: Pick<SessionContext, "session">,
  ): Promise<GmailMessageApprovalSubject>;
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

const GMAIL_MESSAGE_ACTIONS = {
  delete: {
    action: "Безвозвратно удалить письмо Gmail",
    consequence: "Письмо будет удалено навсегда. Его нельзя будет восстановить.",
  },
  mark_read: {
    action: "Отметить письмо Gmail прочитанным",
    consequence: "Письмо больше не будет отмечено как непрочитанное.",
  },
  mark_unread: {
    action: "Отметить письмо Gmail непрочитанным",
    consequence: "Письмо будет отмечено как непрочитанное.",
  },
  restore: {
    action: "Восстановить письмо Gmail из корзины",
    consequence: "Письмо будет возвращено из корзины.",
  },
  trash: {
    action: "Переместить письмо в корзину Gmail",
    consequence: "Письмо будет перемещено в корзину. Его можно будет восстановить.",
  },
} as const;

function approvalValue(value: string | null, missing: string, maxCharacters = 500): string {
  if (value === null) return missing;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return missing;
  return normalized.length <= maxCharacters
    ? normalized
    : `${normalized.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function gmailMessagePrompt(
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
  message: GmailMessageApprovalSubject,
): string {
  const action = GMAIL_MESSAGE_ACTIONS[actionName];
  return [
    "Подтверждение действия",
    "",
    `Действие: ${action.action}`,
    `Профиль: ${message.scope === "personal" ? "личный" : "семейный"}`,
    `Почтовый ящик: ${approvalValue(message.profileDisplayName, "не определён")}`,
    `Отправитель: ${approvalValue(message.from, "не указан")}`,
    `Тема: ${approvalValue(message.subject, "без темы")}`,
    `Дата: ${approvalValue(message.date, "не указана")}`,
    `Фрагмент письма: ${approvalValue(message.snippet, "не предоставлен Gmail", 240)}`,
    `Gmail ID: ${message.id}`,
    "",
    `Что произойдёт: ${action.consequence}`,
  ].join("\n");
}

function gmailMessageOptions(
  request: TelegramInputRequest,
  actionName: keyof typeof GMAIL_MESSAGE_ACTIONS,
): TelegramInputRequest["options"] {
  const approveLabels: Readonly<Record<keyof typeof GMAIL_MESSAGE_ACTIONS, string>> = {
    delete: "Удалить навсегда",
    mark_read: "Отметить прочитанным",
    mark_unread: "Отметить непрочитанным",
    restore: "Восстановить письмо",
    trash: "Переместить в корзину",
  };
  return request.options?.map((option) => ({
    ...option,
    label: option.id === "approve"
      ? approveLabels[actionName]
      : option.id === "deny" || option.id === "cancel"
        ? "Отменить"
        : option.label,
  }));
}

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
      request.action.toolName === "manage_gmail_message"
    ) {
      const input = requireGmailMessageInput(request.action.input);
      const message = await dependencies.findGmailMessage(input.messageId, input.profileRef, ctx);
      return {
        ...localized,
        options: gmailMessageOptions(localized, input.action),
        prompt: gmailMessagePrompt(input.action, message),
      };
    }
    if (
      request.display === "confirmation" &&
      request.action.toolName === "execute_google_workspace"
    ) {
      return { ...localized, prompt: googleWorkspacePrompt(request.action.input) };
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
  findGmailMessage: loadGmailMessageApproval,
  findSchedule: (auth, id) => agentScheduleRepository.findById(auth, id),
});
