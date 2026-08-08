/**
 * Long-term memory creation tool.
 *
 * Export:
 * - Eve `remember` tool for explicit user-requested scoped writes with replay protection.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import { requireMemoryAuthorization, requireWritableScope } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { toModelMemory } from "../model-memory.js";
import { resolveSessionCaller } from "../session-auth.js";

const memoryCreateSchema = z.object({
  content: z.string().min(1).max(4_000),
  kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]),
  scope: z.enum(["personal", "family", "group"]),
  sensitivity: z.enum(["normal", "sensitive"]),
  subjectLabel: z.string().trim().min(1).max(200).optional(),
  subjectRef: z.string().regex(/^subj_[0-9a-f]{32}$/u).optional(),
}).strict().refine(
  (input) => input.subjectLabel === undefined || input.subjectRef === undefined,
  { message: "Передайте subjectRef или subjectLabel, но не оба поля" },
);

export default defineTool({
  approval: ({ session, toolInput }) => {
    // Sensitive data and disclosure from a private chat into family memory require explicit consent.
    const input = toolInput as z.infer<typeof memoryCreateSchema> | undefined;
    const privateFamilyWrite =
      input?.scope === "family" && session.auth.current?.attributes.telegramChatType === "private";
    return input?.sensitivity === "sensitive" || privateFamilyWrite
      ? "user-approval"
      : "not-applicable";
  },
  description:
    "Сохранить одну запись долговременной памяти только когда пользователь прямо попросил запомнить именно это сведение. Автоматическое извлечение устойчивых фактов выполняет backend; не дублировать его через этот tool.",
  inputSchema: memoryCreateSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const scope = requireWritableScope(authorization, input.scope);
    const caller = resolveSessionCaller(ctx);
    const conversationId = caller?.attributes.telegramConversationId;
    const timelineEntryId = caller?.attributes.telegramTimelineEntryId;
    if (typeof conversationId !== "string" || typeof timelineEntryId !== "string") {
      throw new AppError(
        "AGENT_MEMORY_EXPLICIT_SOURCE_INVALID",
        "Не удалось подтвердить текущее сообщение для сохранения памяти",
      );
    }
    // The approval declaration controls Eve UX; exact consumed evidence independently guards writes.
    const privateFamilyWrite = input.scope === "family" &&
      ctx.session.auth.current?.attributes.telegramChatType === "private";
    if (input.sensitivity === "sensitive" || privateFamilyWrite) {
      await requireToolApprovalEvidence(ctx, "remember", input);
    }
    const item = await memoryRepository.create(authorization, {
      confirmation: "user_confirmed",
      content: requireAllowedMemoryContent(input.content),
      explicitSource: {
        conversationId,
        ...(input.subjectLabel === undefined ? {} : { subjectLabel: input.subjectLabel }),
        ...(input.subjectRef === undefined ? {} : { subjectRef: input.subjectRef }),
        timelineEntryId,
      },
      kind: input.kind,
      operationKey: ctx.callId,
      provenance: { sessionId: ctx.session.id, turnId: ctx.session.turn.id },
      scope,
      sensitivity: input.sensitivity,
      source: `eve:${ctx.session.id}:${ctx.session.turn.id}`,
      sourceEventId:
        typeof caller?.attributes.telegramMessageId === "string"
          ? caller.attributes.telegramMessageId
          : undefined,
      messageThreadId:
        typeof caller?.attributes.telegramMessageThreadId === "string"
          ? caller.attributes.telegramMessageThreadId
          : undefined,
    });
    return {
      item: toModelMemory(item),
      notice: `Сохранено в область «${scope}». Для немедленной отмены используй manage_memory с action undo и memoryRef ${item.memoryRef}.`,
    };
  },
});
