/**
 * Consolidated behavior preference mutation tool.
 *
 * Export:
 * - `manage_behavior_preference`: sets or resets typed presentation preferences.
 *
 * Key constructs:
 * - Object-shaped model schema publishes required common fields and finite enums.
 * - One semantic parser validates both approval and execution inputs.
 * - Existing domain schemas remain the source of truth for preference/value pairs.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { behaviorPreferenceRepository } from "../behavior-preference-repository.js";
import {
  behaviorPreferenceInputSchema,
  behaviorPreferenceResetInputSchema,
} from "../behavior-preferences.js";
import { requireOwner } from "../family-context.js";
import { requireMemoryAuthorization, requireWritableScope } from "../memory-context.js";
import {
  requireAction,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_BEHAVIOR_PREFERENCE_INPUT_INVALID";
const TOOL_ACTIONS = ["set", "reset"] as const;
const PREFERENCES = [
  "answer_structure",
  "language",
  "response_length",
  "status_updates",
  "tone",
] as const;
const SCOPES = ["personal", "family", "group"] as const;
const VALUES = [
  "prose",
  "structured",
  "match_user",
  "russian",
  "balanced",
  "concise",
  "detailed",
  "milestones",
  "minimal",
  "formal",
  "neutral",
  "warm",
] as const;
const TOP_LEVEL_FIELDS = ["action", "preference", "scope", "value"] as const;

const manageBehaviorPreferenceSchema = z.object({
  action: z.enum(TOOL_ACTIONS).describe("Обязательный action: set или reset."),
  preference: z.enum(PREFERENCES).describe("Обязательное имя типизированной настройки."),
  scope: z.enum(SCOPES).describe("Обязательная область: personal, family или group."),
  value: z.enum(VALUES).optional().describe("Обязательно только для action=set; для reset не передавайте."),
}).strict();

function requireSetInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "preference", "scope", "value"], "action=set", INPUT_ERROR_CODE);
  const parsed = behaviorPreferenceInputSchema.safeParse(input);
  if (!parsed.success) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=set передайте scope, preference и допустимый value. Примеры: tone=warm, language=russian, response_length=concise, answer_structure=structured, status_updates=minimal",
    );
  }
  return parsed.data;
}

function requireResetInput(input: Record<string, unknown>) {
  // MiniMax may materialize the known set-only value. Reset never reads or persists it.
  const parsed = behaviorPreferenceResetInputSchema.safeParse(input);
  if (!parsed.success) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Для action=reset передайте scope и preference: answer_structure | language | response_length | status_updates | tone",
    );
  }
  return parsed.data;
}

function requireManageBehaviorPreferenceInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_behavior_preference", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_behavior_preference", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_behavior_preference", TOOL_ACTIONS, INPUT_ERROR_CODE);

  // Approval and execution share this parser, so malformed writes never become HITL requests.
  if (action === "set") return { action, values: requireSetInput(payload) } as const;
  return { action, values: requireResetInput(payload) } as const;
}

const TOOL_DESCRIPTION = [
  "Установить или сбросить типизированную настройку представления ответа: длину, тон, язык, структуру или промежуточные статусы.",
  "Для action=set обязательны action, scope, preference и value: {\"action\":\"set\",\"scope\":\"personal\",\"preference\":\"tone\",\"value\":\"warm\"}.",
  "Для action=reset обязательны action, scope и preference; value не передавайте: {\"action\":\"reset\",\"scope\":\"personal\",\"preference\":\"tone\"}.",
  "scope: personal | family | group; family и group требуют владельца.",
  "preference и допустимые value: answer_structure=prose | structured; language=match_user | russian; response_length=balanced | concise | detailed; status_updates=milestones | minimal; tone=formal | neutral | warm.",
  "Не угадывай обязательные значения и не подставляй defaults: если их нет, спроси пользователя.",
  "После ошибки входных данных исправь payload по тексту ошибки и повтори не более одного раза; при повторной ошибке остановись и уточни данные.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) => {
    const parsed = requireManageBehaviorPreferenceInput(toolInput);
    return parsed.action === "reset" ? "user-approval" : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageBehaviorPreferenceSchema,
  async execute(input, ctx) {
    const parsed = requireManageBehaviorPreferenceInput(input);
    const authorization = requireMemoryAuthorization(ctx);

    if (parsed.action === "set") {
      const values = parsed.values;
      const scope = requireWritableScope(authorization, values.scope);
      if (scope !== "personal") requireOwner(ctx);
      return await behaviorPreferenceRepository.set(authorization, {
        preference: values.preference,
        scope,
        value: values.value,
      });
    }

    const values = parsed.values;
    const scope = requireWritableScope(authorization, values.scope);
    if (scope !== "personal") requireOwner(ctx);
    return {
      deleted: await behaviorPreferenceRepository.delete(
        authorization,
        scope,
        values.preference,
      ),
    };
  },
});
