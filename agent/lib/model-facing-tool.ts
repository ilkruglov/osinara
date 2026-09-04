/**
 * Common model-facing execution boundary for Eve tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error.
 *
 * Key construct:
 * - The generic call contract is stated once in `agent/instructions.md`, so a descriptor carries
 *   only what is specific to its own tool.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";

import { normalizeModelFacingError } from "./model-facing-error.js";

type AnyToolDefinition = ToolDefinition<any, any>;

/**
 * The shared call contract lives once in the permanent core, not on every descriptor: repeating it
 * per tool cost about fifteen thousand characters of identical text in a single private-chat
 * request. A tool still states its own purpose, and a denied one still says it is unavailable.
 */
function completeDescription(description: string): string {
  return /недоступен/u.test(description)
    ? `${description} Не вызывай его и не пытайся обойти запрет другим инструментом.`
    : description;
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
