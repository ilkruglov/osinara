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
import { MEMORY_REF_PATTERN, toModelMemory } from "../model-memory.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import {
  optionalEnum,
  requireAction,
  requiredString,
  requireInputRecord,
  requireOnlyFields,
  toolInputError,
} from "../tool-input-validation.js";

const INPUT_ERROR_CODE = "AGENT_MEMORY_INPUT_INVALID";
const TOOL_ACTIONS = ["edit", "delete", "undo"] as const;
const MEMORY_KINDS = ["profile", "preference", "fact", "episode", "family_shared"] as const;
const MEMORY_SENSITIVITIES = ["normal", "sensitive"] as const;
const TOP_LEVEL_FIELDS = ["action", "content", "kind", "memoryRef", "sensitivity"] as const;

const manageMemorySchema = z.object({
  action: z.string().optional(),
  content: z.string().optional(),
  kind: z.string().optional(),
  memoryRef: z.string().optional(),
  sensitivity: z.string().optional(),
}).passthrough();

type MemoryAction = (typeof TOOL_ACTIONS)[number];

function requireMemoryRef(input: Record<string, unknown>): string {
  const memoryRef = requiredString(
    input,
    "memoryRef",
    INPUT_ERROR_CODE,
    "mem_0123456789abcdef0123456789abcdef",
  );
  if (!MEMORY_REF_PATTERN.test(memoryRef)) {
    toolInputError(
      INPUT_ERROR_CODE,
      "Поле memoryRef должно быть безопасной ссылкой из remember, search_memories или list_memories",
    );
  }
  return memoryRef;
}

function requireEditInput(input: Record<string, unknown>) {
  requireOnlyFields(
    input,
    ["action", "content", "kind", "memoryRef", "sensitivity"],
    "action=edit",
    INPUT_ERROR_CODE,
  );
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
    memoryRef: requireMemoryRef(input),
    ...(sensitivity === undefined ? {} : { sensitivity }),
  };
}

function requireRefOnlyInput(input: Record<string, unknown>, action: MemoryAction): string {
  requireOnlyFields(input, ["action", "memoryRef"], `action=${action}`, INPUT_ERROR_CODE);
  return requireMemoryRef(input);
}

function requireCurrentCorrectionSource(ctx: Parameters<typeof requireToolApprovalEvidence>[0]) {
  const attributes = ctx.session.auth.current?.attributes;
  const conversationId = attributes?.telegramConversationId;
  const timelineEntryId = attributes?.telegramTimelineEntryId;
  if (typeof conversationId !== "string" || typeof timelineEntryId !== "string") {
    toolInputError(
      "AGENT_MEMORY_CORRECTION_SOURCE_INVALID",
      "Не удалось подтвердить текущее сообщение как источник исправления памяти",
    );
  }
  return { conversationId, timelineEntryId };
}

const TOOL_DESCRIPTION = [
  "Исправить доступную запись долговременной памяти, удалить её или отменить только что выполненное сохранение.",
  "Перед edit/delete сначала получи memoryRef через remember, search_memories или list_memories.",
  "Edit payload: {\"action\":\"edit\",\"memoryRef\":\"mem_...\",\"content\":\"Исправленный текст\",\"kind\":\"preference\",\"sensitivity\":\"normal\"}. kind и sensitivity необязательны.",
  "Delete payload: {\"action\":\"delete\",\"memoryRef\":\"mem_...\"}. Undo используется только для немедленной отмены сохранения: {\"action\":\"undo\",\"memoryRef\":\"mem_...\"}.",
].join(" ");

export default defineTool({
  approval: ({ toolInput }) => {
    // Undo is the immediate reversal offered after creation; edit and delete remain confirmation-gated.
    if (toolInput?.action === "undo") return "not-applicable";
    return "user-approval";
  },
  description: TOOL_DESCRIPTION,
  inputSchema: manageMemorySchema,
  async execute(input, ctx) {
    const payload = requireInputRecord(input, "manage_memory", INPUT_ERROR_CODE);
    requireOnlyFields(payload, TOP_LEVEL_FIELDS, "manage_memory", INPUT_ERROR_CODE);
    const action = requireAction(payload, "manage_memory", TOOL_ACTIONS, INPUT_ERROR_CODE);
    const authorization = requireMemoryAuthorization(ctx);
    if (action !== "undo") await requireToolApprovalEvidence(ctx, "manage_memory", input);
    if (action === "edit") {
      const values = requireEditInput(payload);
      const updated = await memoryRepository.updateByRef(authorization, {
        ...values,
        content: requireAllowedMemoryContent(values.content),
        operationKey: ctx.callId,
        source: requireCurrentCorrectionSource(ctx),
      });
      return toModelMemory(updated);
    }

    return await memoryRepository.deleteByRef(
      authorization,
      requireRefOnlyInput(payload, action),
      ctx.callId,
    );
  },
});
