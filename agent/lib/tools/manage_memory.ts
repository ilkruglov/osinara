/**
 * Consolidated long-term memory mutation tool.
 *
 * Export:
 * - `manage_memory`: routes explicit edit, delete, and immediate undo actions.
 *
 * Key constructs:
 * - Object-shaped model schema avoids fragile root action unions.
 * - Action validators keep memory mutations fail-closed on malformed model payloads.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { MEMORY_CONTENT_MAX_LENGTH } from "../memory-config.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import { requireMemoryAuthorization } from "../memory-context.js";
import type { MemoryKind, MemorySensitivity } from "../memory-record.js";
import { memoryRepository } from "../memory-repository.js";
import { MEMORY_UNDO_DENIED_MESSAGE } from "../memory-undo-repository.js";
import {
  optionalEnum,
  requireAction,
  requiredString,
  requiredUuid,
  requireInputRecord,
  requireOnlyFields,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_MEMORY_INPUT_INVALID";
const TOOL_ACTIONS = ["edit", "delete", "undo"] as const;
const MEMORY_KINDS = ["profile", "preference", "fact", "episode", "family_shared"] as const;
const MEMORY_SENSITIVITIES = ["normal", "sensitive"] as const;
const TOP_LEVEL_FIELDS = ["action", "content", "id", "kind", "sensitivity"] as const;

const manageMemorySchema = z.object({
  action: z.enum(TOOL_ACTIONS),
  content: z.string().optional(),
  id: z.string().optional(),
  kind: z.string().optional(),
  sensitivity: z.string().optional(),
}).strict();

type MemoryAction = (typeof TOOL_ACTIONS)[number];

function requireMemoryId(input: Record<string, unknown>): string {
  return requiredUuid(input, "id", INPUT_ERROR_CODE, "запись из search_memories или list_memories");
}

function requireEditInput(input: Record<string, unknown>) {
  requireOnlyFields(input, ["action", "content", "id", "kind", "sensitivity"], "action=edit", INPUT_ERROR_CODE);
  const kind = optionalEnum(input, "kind", MEMORY_KINDS, INPUT_ERROR_CODE) as MemoryKind | undefined;
  const sensitivity = optionalEnum(
    input,
    "sensitivity",
    MEMORY_SENSITIVITIES,
    INPUT_ERROR_CODE,
  ) as MemorySensitivity | undefined;
  return {
    ...(kind === undefined ? {} : { kind }),
    content: requiredString(input, "content", INPUT_ERROR_CODE, "Исправленный текст памяти", {
      maxLength: MEMORY_CONTENT_MAX_LENGTH,
    }),
    id: requireMemoryId(input),
    ...(sensitivity === undefined ? {} : { sensitivity }),
  };
}

function requireIdOnlyInput(input: Record<string, unknown>, action: MemoryAction): string {
  requireOnlyFields(input, ["action", "id"], `action=${action}`, INPUT_ERROR_CODE);
  return requireMemoryId(input);
}

function requireManageMemoryInput(input: unknown) {
  const payload = requireInputRecord(input, "manage_memory", INPUT_ERROR_CODE);
  requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_memory", INPUT_ERROR_CODE);
  const action = requireAction(payload, "manage_memory", TOOL_ACTIONS, INPUT_ERROR_CODE);

  // Approval and execution share semantic parsing so malformed mutations never reach HITL.
  if (action === "edit") return { action, values: requireEditInput(payload) } as const;
  return { action, id: requireIdOnlyInput(payload, action) } as const;
}

function currentProvenance(session: { id: string; turn: { id: string } }) {
  return { sessionId: session.id, turnId: session.turn.id };
}

const TOOL_DESCRIPTION = [
  "Исправить доступную запись долговременной памяти, удалить её или отменить только что выполненное сохранение.",
  "Перед edit/delete сначала найди id через search_memories или list_memories.",
  "Edit payload: {\"action\":\"edit\",\"id\":\"uuid\",\"content\":\"Исправленный текст\",\"kind\":\"preference\",\"sensitivity\":\"normal\"}. kind и sensitivity необязательны.",
  "Delete payload: {\"action\":\"delete\",\"id\":\"uuid\"}. Undo payload используется только для немедленной отмены предложенного сохранения: {\"action\":\"undo\",\"id\":\"uuid\"}.",
].join(" ");

export default defineTool({
  approval: async ({ session, toolInput }) => {
    const parsed = requireManageMemoryInput(toolInput);
    const authorization = requireMemoryAuthorization({ session });
    if (parsed.action === "undo") {
      const allowed = await memoryRepository.canUndoCreate(
        authorization,
        parsed.id,
        currentProvenance(session),
      );
      return allowed
        ? "not-applicable"
        : {
            type: "denied",
            reason: `AGENT_MEMORY_UNDO_DENIED: ${MEMORY_UNDO_DENIED_MESSAGE}`,
          };
    }

    // Private edits/deletes are displayed before execution; group policy remains repository-gated.
    return session.auth.current?.attributes.telegramChatType === "private"
      ? "user-approval"
      : "not-applicable";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageMemorySchema,
  async execute(input, ctx) {
    const parsed = requireManageMemoryInput(input);
    const authorization = requireMemoryAuthorization(ctx);
    if (parsed.action === "edit") {
      return await memoryRepository.update(authorization, {
        ...parsed.values,
        content: requireAllowedMemoryContent(parsed.values.content),
        operationKey: ctx.callId,
      });
    }

    if (parsed.action === "undo") {
      return await memoryRepository.undoCreate(authorization, parsed.id, {
        operationKey: ctx.callId,
        ...currentProvenance(ctx.session),
      });
    }

    return await memoryRepository.delete(authorization, parsed.id, ctx.callId);
  },
});
