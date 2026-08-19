/**
 * Common model-facing execution boundary for Eve tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";

import { normalizeModelFacingError } from "./model-facing-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

function completeDescription(description: string): string {
  if (/недоступен/u.test(description)) {
    return [
      description,
      "Когда использовать: никогда в текущем режиме.",
      "Не использовать: не пытайся обходить запрет другим tool.",
      "Вход: не формируй вызов.",
      "Результат: доступ отсутствует.",
      "Ошибка: не повторяй и сообщи об ограничении текущего контекста.",
    ].join(" ");
  }
  const sections = [
    description.includes("Когда использовать:")
      ? null
      : "Когда использовать: только когда назначение выше прямо соответствует задаче пользователя.",
    description.includes("Не использовать:")
      ? null
      : "Не использовать: не вызывай для действий вне описанного назначения или текущего trust zone.",
    description.includes("Вход:")
      ? null
      : "Вход: передавай только поля schema; ID, cursor и opaque ref бери только из текущего контекста или результата подходящего list/search tool.",
    description.includes("Результат:")
      ? null
      : "Результат: считай действие выполненным только по успешному tool result и используй только реально возвращённые поля.",
    description.includes("Ошибка:")
      ? null
      : "Ошибка: следуй code, correction, retryable и sideEffectStatus; при unknown или completed не повторяй side effect автоматически.",
  ].filter((section): section is string => section !== null);
  return [description, ...sections].join(" ");
}

export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    description: completeDescription(definition.description),
    async execute(input, ctx) {
      try {
        return await definition.execute(input, ctx);
      } catch (error) {
        throw normalizeModelFacingError(error, { toolName });
      }
    },
  });
}

export function wrapModelFacingToolMap<T extends Readonly<Record<string, AnyToolDefinition>>>(
  surface: T,
): T {
  return Object.fromEntries(
    Object.entries(surface).map(([name, definition]) => [
      name,
      wrapModelFacingTool(name, definition),
    ]),
  ) as T;
}
