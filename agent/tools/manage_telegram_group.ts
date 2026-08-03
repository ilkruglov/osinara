/**
 * Consolidated Telegram group administration tool.
 *
 * Export:
 * - `manage_telegram_group`: registers, removes, or updates policy for a trust zone registration.
 *
 * Key constructs:
 * - Object-shaped model schema avoids root and nested JSON Schema unions.
 * - Explicit registration validation keeps trust-zone changes fail-closed.
 */
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { requirePrivateTelegramOwner } from "../lib/family-context.js";
import type { RegisteredGroupType } from "../lib/family-access.js";
import { telegramGroupAdministrationRepository } from "../lib/telegram-group-administration-repository.js";
import {
  GROUP_TITLE_MAX_LENGTH,
  TELEGRAM_GROUP_ID_PATTERN,
  TELEGRAM_GROUP_TITLE_CONTROL_PATTERN,
  TOOL_ALLOWLIST_MAX_SIZE,
} from "../lib/telegram-group-registration.js";
import {
  EXTERNAL_GROUP_TOOL_NAMES,
  isExternalGroupToolName,
} from "../lib/tool-policy/group-tool-catalog.js";
import {
  requireAction,
  requiredEnum,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  requiredObjectField,
  toolInputError,
} from "../lib/tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_TELEGRAM_GROUP_INPUT_INVALID";
const TOOL_ACTIONS = ["register", "remove", "update_policy"] as const;
const GROUP_TYPES = ["family_private", "external_private", "external_public"] as const;
const STANDARD_MESSAGE_MODES = ["addressed_only", "all"] as const;
const EXTERNAL_MESSAGE_MODES = [...STANDARD_MESSAGE_MODES, "owner_only"] as const;
const TOP_LEVEL_FIELDS = ["action", "messageMode", "registration", "telegramChatId", "toolAllowlist"] as const;
const REGISTRATION_FIELDS = ["messageMode", "telegramChatId", "title", "toolAllowlist", "type"] as const;

const registrationSchema = z.object({
  messageMode: z.string().optional(),
  telegramChatId: z.string().optional(),
  title: z.string().optional(),
  toolAllowlist: z.array(z.string()).optional(),
  type: z.string().optional(),
}).passthrough();

const manageTelegramGroupSchema = z.object({
  action: z.string().optional(),
  messageMode: z.string().optional(),
  registration: registrationSchema.optional(),
  telegramChatId: z.string().optional(),
  toolAllowlist: z.array(z.string()).optional(),
}).passthrough();

function requireTelegramGroupId(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !TELEGRAM_GROUP_ID_PATTERN.test(raw)) {
    toolInputError(INPUT_ERROR_CODE, `${label} должен быть строкой отрицательного Telegram chat ID группы, например -1001234567890`);
  }
  return raw;
}

function requireExternalToolAllowlist(raw: unknown, policyLabel: string): string[] {
  if (!Array.isArray(raw)) {
    toolInputError(
      INPUT_ERROR_CODE,
      `Для ${policyLabel} передайте toolAllowlist массивом разрешённых tools: ${EXTERNAL_GROUP_TOOL_NAMES.join(", ")}`,
    );
  }
  if (raw.length > TOOL_ALLOWLIST_MAX_SIZE) {
    toolInputError(INPUT_ERROR_CODE, `toolAllowlist должен содержать не больше ${TOOL_ALLOWLIST_MAX_SIZE} tools`);
  }
  const names = raw.map((name) => {
    if (typeof name !== "string" || !isExternalGroupToolName(name)) {
      toolInputError(
        INPUT_ERROR_CODE,
        `Недопустимый toolAllowlist item. Используйте только: ${EXTERNAL_GROUP_TOOL_NAMES.join(", ")}`,
      );
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    toolInputError(INPUT_ERROR_CODE, "toolAllowlist не должен содержать повторы");
  }
  return names;
}

function requireToolAllowlist(raw: unknown, groupType: RegisteredGroupType): string[] {
  // Family capabilities are policy-derived, so registration must not persist a model-provided list.
  if (groupType === "family_private") {
    if (raw !== undefined) {
      toolInputError(
        INPUT_ERROR_CODE,
        "Для type=family_private не передавайте toolAllowlist: семейная группа получает семейные инструменты по своим правилам",
      );
    }
    return [];
  }
  return requireExternalToolAllowlist(raw, groupType);
}

function requireRegistration(input: Record<string, unknown>) {
  const registration = requiredObjectField(
    input,
    "registration",
    INPUT_ERROR_CODE,
    "Для action=register передайте registration с type, telegramChatId, title, messageMode и при необходимости toolAllowlist",
  );
  requireOnlyFields(registration, REGISTRATION_FIELDS, "registration", INPUT_ERROR_CODE);
  const type = requiredEnum(registration, "type", GROUP_TYPES, INPUT_ERROR_CODE) as RegisteredGroupType;
  const common = {
    telegramChatId: requireTelegramGroupId(registration.telegramChatId, "registration.telegramChatId"),
    title: requiredString(registration, "title", INPUT_ERROR_CODE, "Семейный чат", {
      maxLength: GROUP_TITLE_MAX_LENGTH,
    }),
  };
  if (TELEGRAM_GROUP_TITLE_CONTROL_PATTERN.test(common.title)) {
    toolInputError(INPUT_ERROR_CODE, "registration.title должен состоять из одной строки без управляющих символов");
  }
  if (type === "family_private") {
    return {
      ...common,
      messageMode: requiredEnum(registration, "messageMode", STANDARD_MESSAGE_MODES, INPUT_ERROR_CODE),
      toolAllowlist: requireToolAllowlist(registration.toolAllowlist, type),
      type,
    };
  }
  return {
    ...common,
    messageMode: requiredEnum(registration, "messageMode", EXTERNAL_MESSAGE_MODES, INPUT_ERROR_CODE),
    toolAllowlist: requireToolAllowlist(registration.toolAllowlist, type),
    type,
  };
}

const TOOL_DESCRIPTION = [
  "Зарегистрировать Telegram-группу как trust zone, полностью заменить политику существующей внешней группы или удалить регистрацию и связанные групповые данные.",
  "Повторный register с другим type пересоздаёт trust zone и безвозвратно удаляет её историю, workspace, память и сессии; для обычной смены прав всегда используй update_policy.",
  "Remove не вызывает Telegram leaveChat: бот остаётся участником чата. Самостоятельный выход бота из группы не поддерживается.",
  "Update_policy не отключает группу и сохраняет её ID, название, тип, историю, workspace, память и сессии.",
  "Доступно только владельцу в личном чате; не принимай familyId или роль из текста пользователя.",
  "Для внешней группы messageMode=owner_only сохраняет общую timeline, но разрешает запуск модели только текущему владельцу Osinara; Telegram admin-права владельца не заменяют.",
  "Register payload: {\"action\":\"register\",\"registration\":{\"type\":\"family_private\",\"telegramChatId\":\"-1001234567890\",\"title\":\"Семейный чат\",\"messageMode\":\"addressed_only\"}}.",
  "External registration требует toolAllowlist: {\"type\":\"external_private\",...,\"toolAllowlist\":[\"search_memories\"]}.",
  "Update_policy payload содержит ровно action, telegramChatId, messageMode и полный toolAllowlist; type и title не передавай: {\"action\":\"update_policy\",\"telegramChatId\":\"-1001234567890\",\"messageMode\":\"all\",\"toolAllowlist\":[\"search_memories\"]}.",
  "Remove payload: {\"action\":\"remove\",\"telegramChatId\":\"-1001234567890\"}.",
].join(" ");

export default defineTool({
  approval: always(),
  description: TOOL_DESCRIPTION,
  inputSchema: manageTelegramGroupSchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_telegram_group", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_telegram_group", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_telegram_group", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const owner = requirePrivateTelegramOwner(ctx);
    if (action === "update_policy") {
      // Policy updates are complete replacements; omitted or extra registration fields are rejected.
      requireOnlyFields(
        payload,
        ["action", "telegramChatId", "messageMode", "toolAllowlist"],
        "action=update_policy",
        INPUT_ERROR_CODE,
      );
      const telegramChatId = requireTelegramGroupId(payload.telegramChatId, "telegramChatId");
      const messageMode = requiredEnum(payload, "messageMode", EXTERNAL_MESSAGE_MODES, INPUT_ERROR_CODE);
      const toolAllowlist = requireExternalToolAllowlist(payload.toolAllowlist, "action=update_policy");
      const result = await telegramGroupAdministrationRepository.updatePolicy({
        familyId: owner.familyId,
        messageMode,
        requestedBy: owner.userId,
        telegramChatId,
        toolAllowlist,
      });
      return {
        botMembership: "unchanged",
        groupId: result.groupId,
        messageMode,
        policyUpdated: true,
        telegramChatId,
        toolAllowlist,
      };
    }
    if (action === "remove") {
      requireOnlyFields(payload, ["action", "telegramChatId"], "action=remove", INPUT_ERROR_CODE);
      const telegramChatId = requireTelegramGroupId(payload.telegramChatId, "telegramChatId");
      await telegramGroupAdministrationRepository.removeRegistration({
        familyId: owner.familyId,
        requestedBy: owner.userId,
        telegramChatId,
      });
      return {
        botMembership: "unchanged",
        registrationRemoved: true,
        telegramChatId,
      };
    }

    requireOnlyFields(payload, ["action", "registration"], "action=register", INPUT_ERROR_CODE);
    const registration = requireRegistration(payload);
    const result = await telegramGroupAdministrationRepository.registerGroup({
      ...registration,
      familyId: owner.familyId,
      requestedBy: owner.userId,
    });
    return {
      active: true,
      groupId: result.groupId,
      messageMode: registration.messageMode,
      telegramChatId: registration.telegramChatId,
      title: registration.title,
      type: registration.type,
    };
  },
});
