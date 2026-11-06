/**
 * Changing what a whisper placeholder shows, durably.
 *
 * Exports:
 * - `WhisperPlaceholderApi`: the two Bot API calls on an ephemeral message.
 * - `writeWhisperPlaceholder`: records the change, then makes it.
 * - `retryWhisperPlaceholder`: one more attempt at an edit Telegram has not confirmed.
 *
 * Key constructs:
 * - The record comes first (`transition`), so the sweep finishes an edit this process never
 *   confirmed: a crash between, a 5xx, a 429 or a timeout. A refusal (4xx) is final: the placeholder
 *   is gone or the author's app no longer has it, and repeating would change nothing.
 * - A failed call is logged and never thrown: the turn is finished either way.
 */
import { telegramProviderDescription } from "../telegram-reachability/recipient-failure.js";
import {
  deleteTelegramWhisperMessage,
  editTelegramWhisperMessage,
  type TelegramWhisperContent,
  type TelegramWhisperEditResult,
} from "./telegram-whisper-api.js";
import {
  whisperPlaceholderRepository,
  type WhisperPlaceholderContent,
  type WhisperPlaceholderKey,
  type WhisperPlaceholderRepository,
  type WhisperPlaceholderSettlement,
  type WhisperPlaceholderTransition,
} from "./whisper-placeholder-repository.js";

export interface WhisperPlaceholderApi {
  delete(input: WhisperPlaceholderKey): Promise<TelegramWhisperEditResult>;
  edit(input: WhisperPlaceholderKey & { content: TelegramWhisperContent }): Promise<TelegramWhisperEditResult>;
}

export interface WhisperPlaceholderDependencies {
  readonly api: WhisperPlaceholderApi;
  readonly placeholders: WhisperPlaceholderRepository;
}

export const PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES: WhisperPlaceholderDependencies = {
  api: {
    delete: (input) => deleteTelegramWhisperMessage(input),
    edit: (input) => editTelegramWhisperMessage(input),
  },
  placeholders: whisperPlaceholderRepository,
};

function isRemoval(content: WhisperPlaceholderContent): content is { readonly remove: true } {
  return "remove" in content;
}

async function call(key: WhisperPlaceholderKey, content: WhisperPlaceholderContent, api: WhisperPlaceholderApi): Promise<WhisperPlaceholderSettlement> {
  let result: TelegramWhisperEditResult;
  try {
    const target = { chatId: key.chatId, placeholderMessageId: key.placeholderMessageId, receiverUserId: key.receiverUserId };
    result = isRemoval(content) ? await api.delete(target) : await api.edit({ ...target, content });
  } catch (error) {
    // A timeout or a lost connection may or may not have reached Telegram; the edit is idempotent.
    return { errorCode: error instanceof Error ? error.name : "UnknownError", outcome: "retry" };
  }
  if (result.ok) return { outcome: "delivered" };
  console.warn(JSON.stringify({
    code: "AGENT_TELEGRAM_WHISPER_DELIVERY_FAILED",
    providerDescription: telegramProviderDescription(result.body),
    providerStatus: result.status,
  }));
  const retryable = result.status === 429 || result.status >= 500;
  return { errorCode: `TELEGRAM_${result.status}`, outcome: retryable ? "retry" : "refused" };
}

async function attempt(
  key: WhisperPlaceholderKey,
  change: Omit<WhisperPlaceholderTransition, "from">,
  dependencies: WhisperPlaceholderDependencies,
): Promise<void> {
  const settlement = await call(key, change.content, dependencies.api);
  const settled = await dependencies.placeholders.settle(key, change, settlement);
  if (settlement.outcome === "retry" && settled === "final") {
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_WHISPER_DELIVERY_ABANDONED", errorCode: settlement.errorCode }));
  }
}

/**
 * "refused": the placeholder shows something this change may not replace; "missing": no record
 * names it (the caller decides whether to act without one).
 */
export async function writeWhisperPlaceholder(
  key: WhisperPlaceholderKey,
  change: WhisperPlaceholderTransition,
  dependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<"missing" | "refused" | "written"> {
  const recorded = await dependencies.placeholders.transition(key, change);
  if (recorded === "missing") {
    console.warn(JSON.stringify({ code: "AGENT_TELEGRAM_WHISPER_PLACEHOLDER_UNKNOWN", to: change.to }));
    return "missing";
  }
  if (recorded === "refused") return "refused";
  await attempt(key, change, dependencies);
  return "written";
}

export async function retryWhisperPlaceholder(
  key: WhisperPlaceholderKey,
  change: Omit<WhisperPlaceholderTransition, "from">,
  dependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<void> {
  await attempt(key, change, dependencies);
}
