/**
 * Retrieved memory as Telegram delivery context.
 *
 * Exports:
 * - `TelegramMemoryContextInput`: verified facts of one accepted turn the builder may use.
 * - `createTelegramMemoryContextBuilder`: injectable builder returning context blocks.
 * - `buildTelegramMemoryContext`: production builder.
 *
 * Key constructs:
 * - Eve turns every delivery context string into a user message placed right before the current
 *   message, inside history. The system prefix and the tool descriptors therefore stay
 *   byte-identical between turns and the provider prompt cache covers them; a system-role memory
 *   block changed every turn and cut the cache at that point.
 * - Authorization derives from verified conversation access and the verified actor only.
 * - The same-turn profile view binds to the application session and the timeline entry, which
 *   exist before Eve starts the turn; Eve turn identity is not known at this boundary.
 * - Any failure degrades to an explicit unavailability notice: prompt assembly never fails a turn.
 */
import type { ConversationAccess } from "./family-access.js";
import type { MemoryAuthorization } from "./memory-context.js";
import {
  formatRetrievedMemoryInstructions,
  retrieveMemoryTurnContext,
  type MemoryTurnContext,
} from "./memory-retrieval.js";
import { formatSkillHint, skillHintRepository, type SkillHint } from "./authored-skills/skill-hint-repository.js";
import { formatProfileViewContext, profileViewRepository } from "./profile-view-repository.js";
import type { CreateProfileViewInput, ProfileView } from "./profile-view.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";

export interface TelegramMemoryContextInput {
  readonly access: ConversationAccess;
  readonly actor: { readonly id: string; readonly kind: TelegramActorKind };
  readonly applicationSessionId: string;
  readonly conversationId: string;
  readonly explicitMentionTelegramUserIds: readonly string[];
  readonly query: string;
  readonly replyTelegramUserId: string | null;
  readonly replyTimelineSequence: string | null;
  readonly timelineEntryId: string;
  readonly turnStartedAt: Date;
}

interface TelegramMemoryContextDependencies {
  createProfile(auth: MemoryAuthorization, input: CreateProfileViewInput): Promise<ProfileView | null>;
  /** Pending repeat-task hint for this conversation; consumed once shown. */
  takeSkillHint?(conversationId: string): Promise<SkillHint | null>;
  retrieve(
    auth: MemoryAuthorization,
    query: string,
    skillHints: readonly string[],
  ): Promise<MemoryTurnContext>;
}

const MEMORY_UNAVAILABLE_BLOCK = [
  "AGENT_MEMORY_UNAVAILABLE: В этом ходу долговременная память недоступна.",
  "Не утверждай, что проверила память, и не делай вывод, что записей нет.",
  "Если ответ зависит от долговременной памяти, скажи, что она временно недоступна, и предложи повторить запрос позже.",
].join(" ");

function memoryAuthorization(input: TelegramMemoryContextInput): MemoryAuthorization {
  return {
    familyId: input.access.familyId,
    groupId: input.access.groupId,
    role: input.access.role,
    scopes: [...input.access.memoryScopes],
    telegramActorId: input.actor.id,
    telegramActorKind: input.actor.kind,
    telegramUserId: input.actor.kind === "telegram_user" ? input.actor.id : null,
    userId: input.access.userId,
  };
}

export function createTelegramMemoryContextBuilder(dependencies: TelegramMemoryContextDependencies) {
  return async function build(input: TelegramMemoryContextInput): Promise<string[]> {
    const query = input.query.trim();
    if (query.length === 0) return [];
    try {
      const authorization = memoryAuthorization(input);
      const startedAt = performance.now();
      // Skill-derived thread hints came from load_skill calls in history; none are reviewed now.
      const context = await dependencies.retrieve(authorization, query, []);
      const retrievedAt = performance.now();
      // A channel post has no human subject to build a profile for.
      const profile = input.actor.kind === "telegram_user"
        ? await dependencies.createProfile(authorization, {
          conversationId: input.conversationId,
          currentTelegramUserId: input.actor.id,
          explicitMentionTelegramUserIds: [...input.explicitMentionTelegramUserIds],
          now: input.turnStartedAt,
          provenance: { sessionId: input.applicationSessionId, turnId: input.timelineEntryId },
          replyTelegramUserId: input.replyTelegramUserId,
          ...(input.replyTimelineSequence === null
            ? {}
            : { replyTimelineSequence: input.replyTimelineSequence }),
          retrievalClaimIds: [...context.retrievedClaimIds],
        })
        : null;
      // Per-turn cost of memory on a small server: retrieval (FTS + E5 + pgvector) and profile view.
      console.info(JSON.stringify({
        code: "AGENT_MEMORY_CONTEXT",
        memories: context.memories.length,
        profile: profile !== null,
        profileMs: Math.round(performance.now() - retrievedAt),
        retrievalMs: Math.round(retrievedAt - startedAt),
        threads: context.threads.threads.length,
      }));
      const hint = dependencies.takeSkillHint === undefined
        ? null
        : await dependencies.takeSkillHint(input.conversationId);
      return [
        ...(profile === null ? [] : [formatProfileViewContext(profile)]),
        formatRetrievedMemoryInstructions(context.memories, context.threads),
        ...(hint === null ? [] : [formatSkillHint(hint)]),
      ];
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_MEMORY_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      }));
      return [MEMORY_UNAVAILABLE_BLOCK];
    }
  };
}

export const buildTelegramMemoryContext = createTelegramMemoryContextBuilder({
  createProfile: profileViewRepository.create,
  retrieve: retrieveMemoryTurnContext,
  takeSkillHint: (conversationId) => skillHintRepository.take(conversationId),
});
