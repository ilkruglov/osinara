/**
 * Long-term memory creation tool.
 *
 * Export:
 * - Eve `remember` tool for one main-agent source-backed claim and optional atomic thread action.
 */
import { defineTool } from "eve/tools";
import { AppError, isAppError } from "../app-error.js";
import { requireAllowedMemoryContent } from "../memory-content-policy.js";
import { requireMemoryAuthorization, requireWritableScope } from "../memory-context.js";
import { memoryRepository } from "../memory-repository.js";
import { logMemoryWriteEvent } from "../memory-observability.js";
import { resolveMemoryTurnSource } from "../memory-turn-source.js";
import { requireToolApprovalEvidence } from "../require-tool-approval-evidence.js";
import { toModelMemory } from "../model-memory.js";
import { rememberInputSchema, type RememberInput } from "../remember-contract.js";

export default defineTool({
  approval: ({ session, toolInput }) => {
    // Sensitive data and disclosure from a private chat into family memory require explicit consent.
    const input = toolInput as RememberInput | undefined;
    const privateFamilyWrite =
      input?.scope === "family" && session.auth.current?.attributes.telegramChatType === "private";
    return input?.sensitivity === "sensitive" || privateFamilyWrite
      ? "user-approval"
      : "not-applicable";
  },
  description:
    "Сохранить одну устойчивую запись, которую ты сама определила из проверенного сообщения текущего хода; в группе sourceSequence выбирает одно сообщение из видимой дельты, optional thread атомарно создаёт нить или прикрепляет запись. Не сохраняй предположения и одноразовые запросы.",
  inputSchema: rememberInputSchema,
  async execute(input, ctx) {
    const authorization = requireMemoryAuthorization(ctx);
    const scope = requireWritableScope(authorization, input.scope);
    const requestedSourceKind = input.sourceSequence === undefined ? "current" : "delta";
    let source: Awaited<ReturnType<typeof resolveMemoryTurnSource>> | null = null;
    let item: Awaited<ReturnType<typeof memoryRepository.create>>;
    try {
      source = await resolveMemoryTurnSource(ctx, authorization, input.sourceSequence);
      // The approval declaration controls Eve UX; exact consumed evidence independently guards writes.
      const privateFamilyWrite = input.scope === "family" &&
        ctx.session.auth.current?.attributes.telegramChatType === "private";
      const reviewWrite = source.isReview;
      if (reviewWrite && (input.sensitivity !== "normal" || input.basis !== "agent_inferred" ||
        input.sourceSequence === undefined)) {
        throw new AppError(
          "AGENT_MEMORY_REVIEW_INPUT_INVALID",
          "Тихая проверка сохраняет только normal-память с конкретным sourceSequence",
        );
      }
      const approvedWrite = input.sensitivity === "sensitive" || privateFamilyWrite;
      if (approvedWrite) {
        await requireToolApprovalEvidence(ctx, "remember", input);
      }
      item = await memoryRepository.create(authorization, {
        // A request to save another participant's delta message is not that author's endorsement.
        confirmation: (input.basis === "user_requested" && source.isCurrent) || approvedWrite
          ? "user_confirmed"
          : "model_high",
        content: requireAllowedMemoryContent(input.content),
        explicitSource: {
          conversationId: source.conversationId,
          subject: input.subject,
          timelineEntryId: source.timelineEntryId,
        },
        kind: input.kind,
        operationKey: ctx.callId,
        provenance: { sessionId: ctx.session.id, turnId: ctx.session.turn.id },
        systemActor: reviewWrite,
        scope,
        sensitivity: input.sensitivity,
        source: `eve:${ctx.session.id}:${ctx.session.turn.id}`,
        sourceEventId: source.sourceMessageId,
        ...(source.messageThreadId === null ? {} : { messageThreadId: source.messageThreadId }),
        ...(input.thread === undefined ? {} : { thread: input.thread }),
      });
    } catch (error) {
      const errorCode = isAppError(error)
        ? error.code
        : typeof error === "object" && error !== null &&
            "code" in error && typeof error.code === "string"
          ? error.code
          : "AGENT_MEMORY_WRITE_UNEXPECTED";
      logMemoryWriteEvent({
        code: "AGENT_MEMORY_WRITE_FAILED",
        errorCode,
        scope,
        sourceKind: source?.isCurrent === true ? "current" : requestedSourceKind,
        threadAction: input.thread?.action ?? "none",
      });
      throw error;
    }
    logMemoryWriteEvent({
      code: "AGENT_MEMORY_WRITE_SUCCEEDED",
      scope,
      sourceKind: source.isCurrent ? "current" : "delta",
      threadAction: item.thread?.action ?? "none",
    });
    return {
      item: toModelMemory(item),
      ...(item.thread === undefined ? {} : { thread: item.thread }),
      notice: `Сохранено в область «${scope}». Для немедленной отмены используй manage_memory с action undo и memoryRef ${item.memoryRef}.`,
    };
  },
});
