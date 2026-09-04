/**
 * Common model-facing execution boundary for Eve tools.
 *
 * Exports:
 * - `wrapModelFacingTool`: preserves a descriptor while normalizing every thrown error and telling
 *   the model when its pre-tool text has already been delivered.
 * - `wrapModelFacingToolMap`: applies the boundary once to a complete mode-scoped surface.
 */
import { defineTool, type ToolDefinition } from "eve/tools";

import { isAppError } from "./app-error.js";
import { normalizeModelFacingError } from "./model-facing-error.js";
import {
  PROGRESS_NOTICE_SENT_NOTE,
  progressNoticeKey,
  telegramProgressNoticeDeferral,
} from "./telegram-progress-deferral.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type ApprovalPolicyFunction = (ctx: unknown) => unknown;

/**
 * Eve treats an exception thrown by an approval policy as a failed model call and parks the whole
 * session for a manual retry. Input validation inside a policy is an ordinary correctable error,
 * so it becomes a denial with the reason the model can act on.
 */
function wrapApprovalPolicy(approval: unknown): unknown {
  if (typeof approval !== "function") return approval;
  const policy = approval as ApprovalPolicyFunction;
  return async (ctx: unknown) => {
    try {
      return await policy(ctx);
    } catch (error) {
      if (isAppError(error)) return { reason: error.message, type: "denied" };
      throw error;
    }
  };
}

// Generic call discipline lives once in `agent/instructions.md`; repeating it in every descriptor
// added roughly 17k characters to each model call without adding information.
export function wrapModelFacingTool(
  toolName: string,
  definition: AnyToolDefinition,
): AnyToolDefinition {
  return defineTool({
    ...definition,
    ...(definition.approval === undefined
      ? {}
      : { approval: wrapApprovalPolicy(definition.approval) as AnyToolDefinition["approval"] }),
    async execute(input, ctx) {
      let output: unknown;
      try {
        output = await definition.execute(input, ctx);
      } catch (error) {
        throw normalizeModelFacingError(error, { toolName });
      }
      return withDeliveredNoticeNote(output, ctx);
    },
  });
}

/**
 * The model writes its final message right after this result. Without the note it answers every
 * topic again, and the person reads the pre-tool text twice.
 */
function withDeliveredNoticeNote(output: unknown, ctx: unknown): unknown {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return output;
  const session = (ctx as { session?: { id?: unknown; turn?: { id?: unknown } } } | undefined)
    ?.session;
  if (typeof session?.id !== "string" || typeof session.turn?.id !== "string") return output;
  if (!telegramProgressNoticeDeferral.wasSent(progressNoticeKey(session.id, session.turn.id))) {
    return output;
  }
  return { ...output, already_sent_to_user: PROGRESS_NOTICE_SENT_NOTE };
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
