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

// Generic call discipline lives once in `agent/instructions.md`; repeating it in every descriptor
// added roughly 17k characters to each model call without adding information.
export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
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
