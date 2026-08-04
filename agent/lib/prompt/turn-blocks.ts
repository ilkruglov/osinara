/**
 * Turn-scoped prompt block resolution.
 *
 * Exports:
 * - `TurnBlockContext`: the minimal Eve resolve context a block resolver reads.
 * - `createModeBlockResolver` / `resolveModeBlock`: verified mode rulebook for the current turn.
 * - `createMemoryBlockResolver` / `resolveMemoryBlock`: authorized long-term memory records.
 * - `createPreferenceBlockResolver` / `resolvePreferenceBlock`: typed presentation preferences.
 *
 * Key constructs:
 * - Eve keeps a previous turn's block when a dynamic resolver throws, and never clears the durable
 *   record on its own. Every resolver here therefore returns an explicit value instead of throwing:
 *   a fail-closed block where the model must stop, and `null` where an absent block is safe.
 */
import type { SessionAuth } from "eve/context";
import type { ModelMessage } from "ai";

import { buildBehaviorPreferenceInstructions } from "../behavior-preferences.js";
import {
  behaviorPreferenceRepository,
  type BehaviorPreferenceItem,
} from "../behavior-preference-repository.js";
import { resolveConversationEnvironment } from "../conversation-environment.js";
import {
  requireMemoryAuthorization,
  type MemoryAuthorization,
} from "../memory-context.js";
import type { MemoryItem } from "../memory-record.js";
import {
  formatRetrievedMemoryInstructions,
  memoryRetrievalQuery,
  retrieveRelevantMemories,
} from "../memory-retrieval.js";
import { loadCurrentExternalGroupCapabilities } from "../tool-policy/external-group-live-policy.js";
import type { ExternalGroupToolName } from "../tool-policy/group-tool-catalog.js";
import {
  resolveExternalGroupPolicyIdentity,
  resolveExternalGroupToolPolicy,
} from "../tool-policy/external-group-policy.js";
import { modeInstructions } from "./mode-instructions.js";

export interface TurnBlockContext {
  readonly messages: readonly ModelMessage[];
  readonly session: { readonly auth: SessionAuth; readonly id: string };
}

type CapabilityLoader = (identity: {
  familyId: string;
  groupId: string;
}) => Promise<ReadonlySet<ExternalGroupToolName>>;

const MODE_UNAVAILABLE_BLOCK = `
<current_conversation_environment>
# Режим текущего чата не определён

Возможности этого чата подтвердить не удалось. Не используй память, workspace, учётные данные, инструменты и интеграции и не выполняй никаких действий.

Ответь пользователю ровно одним сообщением: «AGENT_CONVERSATION_ENVIRONMENT_INVALID: Не удалось определить режим текущего чата. Отправьте сообщение ещё раз» и остановись.
</current_conversation_environment>
`.trim();

const MEMORY_UNAVAILABLE_BLOCK = [
  "AGENT_MEMORY_UNAVAILABLE: В этом ходу долговременная память недоступна.",
  "Не утверждай, что проверила память, и не делай вывод, что записей нет.",
  "Если ответ зависит от долговременной памяти, скажи, что она временно недоступна, и предложи повторить запрос позже.",
].join(" ");

function logBlockFailure(code: string, error: unknown): void {
  // Prompt assembly must not fail the turn, so the cause stays in logs with a stable code.
  console.error(JSON.stringify({
    code,
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function effectiveExternalCapabilities(
  auth: SessionAuth,
  loadCapabilities: CapabilityLoader,
): Promise<ReadonlySet<ExternalGroupToolName>> {
  const policy = resolveExternalGroupToolPolicy(auth);
  if (!policy.restricted) return new Set();
  const identity = resolveExternalGroupPolicyIdentity(auth);
  if (!identity) return new Set();

  // An unavailable policy lookup must describe no capability at all, matching the fail-closed
  // execution boundary, instead of leaving the previous turn's wider guidance in place.
  let current: ReadonlySet<ExternalGroupToolName>;
  try {
    current = await loadCapabilities(identity);
  } catch (error) {
    logBlockFailure("AGENT_GROUP_CAPABILITY_LOOKUP_FAILED", error);
    return new Set();
  }
  return new Set([...policy.allowed].filter((capability) => current.has(capability)));
}

export function createModeBlockResolver(dependencies: { loadCapabilities: CapabilityLoader }) {
  return async function resolve(ctx: TurnBlockContext): Promise<string> {
    let environment: ReturnType<typeof resolveConversationEnvironment>;
    try {
      environment = resolveConversationEnvironment(ctx.session.auth);
    } catch (error) {
      logBlockFailure("AGENT_CONVERSATION_ENVIRONMENT_INVALID", error);
      return MODE_UNAVAILABLE_BLOCK;
    }
    if (environment !== "external") return modeInstructions({ environment });

    const capabilities = await effectiveExternalCapabilities(
      ctx.session.auth,
      dependencies.loadCapabilities,
    );
    return modeInstructions({ capabilities, environment: "external" });
  };
}

export function createMemoryBlockResolver(dependencies: {
  authorize: (ctx: TurnBlockContext) => MemoryAuthorization;
  retrieve: (auth: MemoryAuthorization, query: string) => Promise<MemoryItem[]>;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string | null> {
    try {
      const authorization = dependencies.authorize(ctx);
      const query = memoryRetrievalQuery(ctx.session.auth, ctx.messages);
      if (query === null) return null;
      return formatRetrievedMemoryInstructions(
        await dependencies.retrieve(authorization, query),
      );
    } catch (error) {
      logBlockFailure("AGENT_MEMORY_UNAVAILABLE", error);
      return MEMORY_UNAVAILABLE_BLOCK;
    }
  };
}

export function createPreferenceBlockResolver(dependencies: {
  authorize: (ctx: TurnBlockContext) => MemoryAuthorization;
  list: (auth: MemoryAuthorization) => Promise<BehaviorPreferenceItem[]>;
}) {
  return async function resolve(ctx: TurnBlockContext): Promise<string | null> {
    try {
      const authorization = dependencies.authorize(ctx);
      return buildBehaviorPreferenceInstructions(await dependencies.list(authorization));
    } catch (error) {
      // Presentation preferences only shape style, so an absent block is safe on failure.
      logBlockFailure("AGENT_BEHAVIOR_PREFERENCE_UNAVAILABLE", error);
      return null;
    }
  };
}

export const resolveModeBlock = createModeBlockResolver({
  loadCapabilities: loadCurrentExternalGroupCapabilities,
});

export const resolveMemoryBlock = createMemoryBlockResolver({
  authorize: requireMemoryAuthorization,
  retrieve: retrieveRelevantMemories,
});

export const resolvePreferenceBlock = createPreferenceBlockResolver({
  authorize: requireMemoryAuthorization,
  list: behaviorPreferenceRepository.list,
});
