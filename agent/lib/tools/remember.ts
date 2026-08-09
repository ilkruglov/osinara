/**
 * Long-term memory creation tool.
 *
 * Export:
 * - Eve `remember` tool for one main-agent source-backed claim and optional atomic thread action.
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
import {
  THREAD_PURPOSE_MAX_CHARACTERS,
  THREAD_TITLE_MAX_CHARACTERS,
} from "../memory-config.js";
import { THREAD_REF_PATTERN } from "../memory-thread-query-repository.js";

const threadRoleSchema = z.enum([
  "goal", "constraint", "method", "decision", "episode", "outcome", "lesson", "open_loop",
]);
const threadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("attach"),
    role: threadRoleSchema,
    threadRef: z.string().regex(THREAD_REF_PATTERN),
  }).strict(),
  z.object({
    action: z.literal("create"),
    identity: z.enum(["subject", "project"]).optional(),
    parentThreadRef: z.string().regex(THREAD_REF_PATTERN).optional(),
    purpose: z.string().trim().min(1).max(THREAD_PURPOSE_MAX_CHARACTERS),
    role: threadRoleSchema,
    title: z.string().trim().min(1).max(THREAD_TITLE_MAX_CHARACTERS),
  }).strict().refine(
    (input) => input.parentThreadRef === undefined || input.identity === undefined,
    { message: "Для subthread identity определяется только проверенной родительской нитью" },
  ),
]);

const memoryCreateSchema = z.object({
  basis: z.enum(["agent_inferred", "user_requested"]),
  content: z.string().min(1).max(4_000),
  kind: z.enum(["profile", "preference", "fact", "episode", "family_shared"]),
  scope: z.enum(["personal", "family", "group"]),
  sensitivity: z.enum(["normal", "sensitive"]),
  subjectLabel: z.string().trim().min(1).max(200).optional(),
  subjectRef: z.string().regex(/^subj_[0-9a-f]{32}$/u).optional(),
  thread: threadSchema.optional(),
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
    "Сохранить одну устойчивую запись, которую ты сама определила из текущего сообщения пользователя; optional thread тем же вызовом атомарно создаёт нить или прикрепляет запись к найденной нити. Не сохраняй предположения и одноразовые запросы.",
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
    const approvedWrite = input.sensitivity === "sensitive" || privateFamilyWrite;
    if (approvedWrite) {
      await requireToolApprovalEvidence(ctx, "remember", input);
    }
    const item = await memoryRepository.create(authorization, {
      confirmation: input.basis === "user_requested" || approvedWrite
        ? "user_confirmed"
        : "model_high",
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
      ...(input.thread === undefined ? {} : { thread: input.thread }),
    });
    return {
      item: toModelMemory(item),
      ...(item.thread === undefined ? {} : { thread: item.thread }),
      notice: `Сохранено в область «${scope}». Для немедленной отмены используй manage_memory с action undo и memoryRef ${item.memoryRef}.`,
    };
  },
});
