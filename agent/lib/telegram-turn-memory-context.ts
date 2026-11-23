/**
 * Retrieved memory as Telegram delivery context.
 *
 * Exports:
 * - `TelegramMemoryContextInput`: verified facts of one accepted turn the builder may use.
 * - `createTelegramMemoryContextBuilder`: injectable builder returning context blocks.
 * - `buildTelegramMemoryContext`: production builder.
 * - `buildTelegramWhisperMemoryContext`: the same for a whisper, which leaves the skill hint alone.
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
 * - Person cards go first: the author's card in every turn, then the people replied to, mentioned
 *   and found by retrieval; the profile block leaves out what those cards read, except records
 *   released by items that left the turn and whatever a card left with no item read, and gets the
 *   budget the cards left. The switch `AGENT_PERSON_CARDS_ENABLED=false` shows none.
 */
import type { ConversationAccess } from "./family-access.js";
import type { MemoryAuthorization } from "./memory-context.js";
import { memoryContextExposureRepository } from "./memory-context-exposure-repository.js";
import {
  formatRetrievedMemoryInstructions,
  MEMORY_USED_REMINDER,
  retrieveMemoryTurnContext,
  type MemoryTurnContext,
  type MemoryTurnContextOptions,
} from "./memory-retrieval.js";
import {
  formatSkillHint,
  skillHintRepository,
  type SkillHint,
} from "./authored-skills/skill-hint-repository.js";
import { formatProfileViewContext, profileViewRepository } from "./profile-view-repository.js";
import type { CreateProfileViewInput, ProfileView } from "./profile-view.js";
import type { TelegramActorKind } from "./telegram-inbound-actor.js";
import { personCardsEnabled } from "./person-cards/person-card-config.js";
import { PROFILE_CONTEXT_MAX_CHARACTERS } from "./memory-config.js";
import { hasItems, personCardsBlock } from "./person-cards/person-card-render.js";
import {
  loadPersonCardsForTurn,
  personCardsForProfile,
  type TurnPersonCard,
  type LoadPersonCardsInput,
} from "./person-cards/person-card-view-repository.js";

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

interface ExposureLedger {
  authorCardShownRecently(
    applicationSessionId: string,
    telegramUserId: string,
    sessionTurn: number,
  ): Promise<boolean>;
  recentlyShownMemoryRefs(applicationSessionId: string, sessionTurn: number): Promise<Set<string>>;
  record(input: {
    applicationSessionId: string;
    authorTelegramUserId: string | null;
    memoryRefs: readonly string[];
    sessionTurn: number;
  }): Promise<void>;
  sessionTurn(applicationSessionId: string): Promise<number>;
}

interface TelegramMemoryContextDependencies {
  createProfile(
    auth: MemoryAuthorization,
    input: CreateProfileViewInput,
  ): Promise<ProfileView | null>;
  /** What this session already showed; absent in tests that do not care about repetition. */
  exposures?: ExposureLedger;
  /** Valid person cards of the people this turn is about; absent means no cards. */
  loadPersonCards?(
    auth: MemoryAuthorization,
    input: LoadPersonCardsInput,
  ): Promise<TurnPersonCard[]>;
  /** Pending repeat-task hint for this conversation; consumed once shown. */
  takeSkillHint?(conversationId: string): Promise<SkillHint | null>;
  retrieve(
    auth: MemoryAuthorization,
    query: string,
    skillHints: readonly string[],
    options?: MemoryTurnContextOptions,
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

/** A `.catch` that logs one unavailable part of memory and lets the turn go on without it. */
function unavailable<T>(component: string, fallback: T): (error: unknown) => T {
  return (error) => {
    console.error(
      JSON.stringify({ code: "AGENT_MEMORY_UNAVAILABLE", component, error: String(error) }),
    );
    return fallback;
  };
}

function exposureFailure(error: unknown): null {
  console.error(JSON.stringify({ code: "AGENT_MEMORY_EXPOSURE_FAILED", error: String(error) }));
  return null;
}

export function createTelegramMemoryContextBuilder(
  dependencies: TelegramMemoryContextDependencies,
) {
  return async function build(input: TelegramMemoryContextInput): Promise<string[]> {
    const query = input.query.trim();
    if (query.length === 0) return [];
    try {
      const authorization = memoryAuthorization(input);
      const startedAt = performance.now();
      const isUser = input.actor.kind === "telegram_user";
      // The same three facts shown fifty times a day read as a stuck record; what this session
      // already showed recently stays out of the automatic block (the model can still search).
      const exposures = dependencies.exposures;
      const sessionTurn = exposures
        ? await exposures.sessionTurn(input.applicationSessionId).catch(exposureFailure)
        : null;
      const excludeMemoryRefs =
        exposures && sessionTurn !== null
          ? await exposures
              .recentlyShownMemoryRefs(input.applicationSessionId, sessionTurn)
              .catch(() => new Set<string>())
          : new Set<string>();
      // Skill-derived thread hints came from load_skill calls in history; none are reviewed now.
      let retrievalFailed = false;
      const context: MemoryTurnContext = await dependencies
        .retrieve(authorization, query, [], { excludeMemoryRefs })
        .catch((error: unknown) => {
          retrievalFailed = true;
          console.error(
            JSON.stringify({
              code: "AGENT_MEMORY_UNAVAILABLE",
              component: "retrieval",
              error: String(error),
            }),
          );
          return {
            memories: [],
            retrievedClaimIds: [],
            threads: { threads: [], totalCharacters: 0 },
          };
        });
      const retrievedAt = performance.now();
      const authorIsSubject =
        input.replyTelegramUserId === input.actor.id ||
        input.explicitMentionTelegramUserIds.includes(input.actor.id);
      // Cards after retrieval: the people its records are about get their cards too.
      const cardsStartedAt = performance.now();
      const loadedCards =
        isUser && dependencies.loadPersonCards !== undefined && personCardsEnabled()
          ? await dependencies
              .loadPersonCards(authorization, {
                conversationId: input.conversationId,
                replyTimelineSequence:
                  input.replyTelegramUserId === null ? input.replyTimelineSequence : null,
                retrievalClaimIds: [...context.retrievedClaimIds],
                telegramUserIds: [
                  input.actor.id,
                  ...(input.replyTelegramUserId === null ? [] : [input.replyTelegramUserId]),
                  ...input.explicitMentionTelegramUserIds,
                ],
              })
              .catch(unavailable<TurnPersonCard[]>("person_cards", []))
          : [];
      const cardsMs = Math.round(performance.now() - cardsStartedAt);
      // The cards and the profile block share the block's budget, the cards first.
      const { block: cardsBlock, shown: cards } = personCardsBlock(
        loadedCards,
        PROFILE_CONTEXT_MAX_CHARACTERS,
      );
      // The author's card is in every turn, and with it what the card did not read: the "shown
      // recently" suppression is for the author's records shown without a card. A card left with
      // no item hides nothing, so the suppression stays (review, 23 November 2026).
      const authorHasCard = cards.some(
        (card) => card.subjectTelegramUserId === input.actor.id && hasItems(card.sections),
      );
      const suppressCurrentAuthor =
        isUser &&
        !authorHasCard &&
        exposures !== undefined &&
        sessionTurn !== null &&
        !authorIsSubject &&
        (await exposures
          .authorCardShownRecently(input.applicationSessionId, input.actor.id, sessionTurn)
          .catch(() => false));
      // A channel post has no human subject to build a profile for.
      const profile = isUser
        ? await dependencies
            .createProfile(authorization, {
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
              suppressCurrentAuthor,
              personCards: personCardsForProfile(cards),
              maxCharacters: Math.max(
                0,
                PROFILE_CONTEXT_MAX_CHARACTERS - (cardsBlock?.length ?? 0),
              ),
            })
            .catch(unavailable("profile", null))
        : null;
      // Both versions of an unresolved conflict are shown too; without them in the ledger a version
      // the answer relied on was refused as unknown (Codex review, 6 October 2026).
      const conflictRefs = context.memories.flatMap((memory) =>
        "type" in memory && memory.type === "unresolved_conflict"
          ? memory.versions.map((version) => version.memoryRef)
          : [],
      );
      const cardRefs = cards.flatMap((card) => [
        card.cardRef,
        ...card.freshRecords.map((record) => record.memoryRef),
      ]);
      const shownMemoryRefs = [
        ...cardRefs,
        ...context.memories.flatMap((memory) =>
          "memoryRef" in memory && typeof memory.memoryRef === "string" ? [memory.memoryRef] : [],
        ),
        ...conflictRefs,
        ...(profile?.subjects.flatMap((subject) =>
          subject.claims.map((claim) => claim.memoryRef),
        ) ?? []),
      ];
      if (exposures && sessionTurn !== null) {
        const shownAuthorCard =
          profile?.subjects.some((subject) => subject.priority === "current_author") === true;
        await exposures
          .record({
            applicationSessionId: input.applicationSessionId,
            authorTelegramUserId: shownAuthorCard ? input.actor.id : null,
            memoryRefs: shownMemoryRefs,
            sessionTurn,
          })
          .catch((error: unknown) => {
            console.error(
              JSON.stringify({ code: "AGENT_MEMORY_EXPOSURE_FAILED", error: String(error) }),
            );
          });
      }
      // Per-turn cost of memory on a small server: retrieval (FTS + BERTA + pgvector) and profile view.
      console.info(
        JSON.stringify({
          code: "AGENT_MEMORY_CONTEXT",
          cardsMs,
          memories: context.memories.length,
          personCards: cards.length,
          profile: profile !== null,
          profileMs: Math.round(performance.now() - retrievedAt) - cardsMs,
          retrievalMs: Math.round(retrievedAt - startedAt),
          threads: context.threads.threads.length,
          // 26 September 2026: retrievalMs was 1.9 s median with nothing to say which step; the
          // steps answer that (most of it was the reranker, removed on 2 October 2026).
          ...context.timings,
        }),
      );
      const profileBlock = profile == null ? null : formatProfileViewContext(profile);
      // The reminder sits right after the records: the rule in the mode block alone was ignored.
      // Cards and the profile are read apart from retrieval: what they showed still asks for the
      // marker, which the card block no longer explains (review, 23 November 2026).
      const records = retrievalFailed
        ? MEMORY_UNAVAILABLE_BLOCK
        : formatRetrievedMemoryInstructions(context.memories, context.threads);
      const memoryBlock =
        shownMemoryRefs.length === 0 ? records : `${records}\n${MEMORY_USED_REMINDER}`;
      // Why a record was or was not shown, joined to AGENT_MEMORY_REINFORCED by the turn's timeline
      // entry (a failed turn leaves the session turn number to the next one; Codex review):
      // shown-to-used precision per kind and the cut that kept a record out (6 October 2026).
      // Opaque refs and numbers only, never record or profile text.
      console.info(
        JSON.stringify({
          applicationSessionId: input.applicationSessionId,
          candidates: context.trace ?? [],
          code: "AGENT_MEMORY_RETRIEVAL_TRACE",
          conflictRefs,
          memoryChars: memoryBlock.length,
          personCardChars: cardsBlock?.length ?? 0,
          personCardRefs: cards.map((card) => `${card.cardRef}:${card.version}`),
          profileChars: profileBlock?.length ?? 0,
          profileRefs:
            profile?.subjects.flatMap((subject) =>
              subject.claims.map((claim) => claim.memoryRef),
            ) ?? [],
          sessionTurn,
          threads: context.threads.threads.length,
          timelineEntryId: input.timelineEntryId,
        }),
      );
      const hint =
        dependencies.takeSkillHint === undefined
          ? null
          : await dependencies.takeSkillHint(input.conversationId).catch((error: unknown) => {
              console.error(
                JSON.stringify({ code: "AGENT_SKILL_HINT_FAILED", error: String(error) }),
              );
              return null;
            });
      return [
        ...(cardsBlock === null ? [] : [cardsBlock]),
        ...(profileBlock === null ? [] : [profileBlock]),
        memoryBlock,
        ...(hint === null ? [] : [formatSkillHint(hint)]),
      ];
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "AGENT_MEMORY_UNAVAILABLE",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return [MEMORY_UNAVAILABLE_BLOCK];
    }
  };
}

export const buildTelegramMemoryContext = createTelegramMemoryContextBuilder({
  createProfile: profileViewRepository.create,
  exposures: memoryContextExposureRepository,
  loadPersonCards: loadPersonCardsForTurn,
  retrieve: retrieveMemoryTurnContext,
  takeSkillHint: (conversationId) => skillHintRepository.take(conversationId),
});

/** A whisper reads memory like its group, but the group's pending skill hint stays for the group. */
export const buildTelegramWhisperMemoryContext = createTelegramMemoryContextBuilder({
  createProfile: profileViewRepository.create,
  exposures: memoryContextExposureRepository,
  loadPersonCards: loadPersonCardsForTurn,
  retrieve: retrieveMemoryTurnContext,
});
