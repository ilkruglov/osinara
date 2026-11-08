/**
 * Delivery of a whisper turn into the placeholder only its author sees.
 *
 * Exports:
 * - `WHISPER_EMPTY_ANSWER_TEXT`, `WHISPER_TRUNCATED_NOTE`: what the author reads when there is no
 *   answer, or when it did not fit.
 * - `telegramWhisperTarget`: the placeholder of the current whisper turn, from verified auth.
 * - `deliverTelegramWhisperCompletion`: the answer, the interim text, the reaction or the silence.
 * - `finishTelegramWhisperTurn`: the end of a turn that showed nothing.
 * - `reportTelegramWhisperFailure`: a failed turn told in the placeholder.
 *
 * Key constructs:
 * - Nothing of a whisper is posted to the chat: every result replaces the placeholder (an edit has
 *   no 15-second window), a reaction becomes the emoji (an ephemeral message cannot be reacted
 *   to), silence removes the placeholder.
 * - What the placeholder shows is recorded (`whisper-placeholder-repository.ts`), so it survives a
 *   restart: text written before a tool call stands until the answer replaces it, a turn that ended
 *   with the placeholder still open says so, a failure never replaces an answer, and an answer may
 *   replace a failure or the «no answer» text. An edit Telegram did not confirm is retried by the
 *   minute sweep (`whisper-placeholder-sweep.ts`).
 * - Authored asides are joined into one message. A second ephemeral message without a reply
 *   anchor is allowed only to a chat administrator, so an answer longer than one message keeps the
 *   whole paragraphs that fit and says that the rest did not.
 */
import type { SessionAuth } from "eve/context";

import { stripTelegramAsideDirectives } from "../telegram-authored-split.js";
import { formatTelegramFinalPresentation } from "../telegram-final-presentation.js";
import { completedTelegramOutput, TELEGRAM_SILENT_DIRECTIVE } from "../telegram-progress.js";
import type { TelegramWhisperContent } from "./telegram-whisper-api.js";
import {
  isTelegramWhisperSession,
  TELEGRAM_WHISPER_PLACEHOLDER_ATTRIBUTE,
  TELEGRAM_WHISPER_RECEIVER_ATTRIBUTE,
} from "./telegram-whisper.js";
import type { WhisperPlaceholderKey } from "./whisper-placeholder-repository.js";
import {
  PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
  writeWhisperPlaceholder,
  type WhisperPlaceholderDependencies,
} from "./whisper-placeholder-writer.js";

export const WHISPER_EMPTY_ANSWER_TEXT =
  "Ответа не получилось. Спросите ещё раз, можно другими словами.";
export const WHISPER_TRUNCATED_NOTE =
  "\n\n…Ответ длиннее, чем помещается в шёпот; продолжение спросите в личке.";

type WhisperAuth = Pick<SessionAuth, "current">;

export function telegramWhisperTarget(auth: WhisperAuth): WhisperPlaceholderKey | null {
  if (!isTelegramWhisperSession(auth)) return null;
  const attributes = auth.current?.attributes ?? {};
  const chatId = attributes.telegramChatId;
  const placeholder = Number(attributes[TELEGRAM_WHISPER_PLACEHOLDER_ATTRIBUTE]);
  const receiverUserId = attributes[TELEGRAM_WHISPER_RECEIVER_ATTRIBUTE];
  if (
    typeof chatId !== "string" ||
    !Number.isSafeInteger(placeholder) ||
    placeholder <= 0 ||
    typeof receiverUserId !== "string" ||
    !/^[1-9]\d*$/u.test(receiverUserId)
  )
    return null;
  return { chatId, placeholderMessageId: placeholder, receiverUserId };
}

/** The answer as the chat would show it, or null when it does not lay out at all. */
function presentation(markdown: string): TelegramWhisperContent[] | null {
  try {
    return formatTelegramFinalPresentation(markdown).map((chunk) => ({
      format: chunk.format,
      text: chunk.text,
    }));
  } catch {
    return null;
  }
}

/**
 * One message for the placeholder. An answer longer than one message keeps as many whole
 * paragraphs as fit together with the note; cutting by paragraphs of the source keeps every block
 * whole, so the layout stays within Telegram's characters and blocks and no closing tag is lost.
 */
function placeholderContent(markdown: string): TelegramWhisperContent | null {
  const whole = presentation(markdown);
  if (whole !== null && whole.length <= 1) return whole[0] ?? null;
  const paragraphs = markdown.split(/\n{2,}/u);
  let best: TelegramWhisperContent | null = null;
  let low = 1;
  let high = paragraphs.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const fitted = presentation(
      `${paragraphs.slice(0, middle).join("\n\n")}${WHISPER_TRUNCATED_NOTE}`,
    );
    if (fitted !== null && fitted.length === 1) {
      best = fitted[0]!;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best ?? { format: "plain", text: WHISPER_TRUNCATED_NOTE.trim() };
}

function presented(markdown: string): TelegramWhisperContent | null {
  return placeholderContent(stripTelegramAsideDirectives(markdown));
}

export async function deliverTelegramWhisperCompletion(
  data: { finishReason: string; message?: string | null },
  auth: WhisperAuth,
  dependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<void> {
  const target = telegramWhisperTarget(auth);
  if (!target) return;
  const output = completedTelegramOutput(data);
  if (!output) {
    if (
      data.finishReason === "stop" &&
      typeof data.message === "string" &&
      data.message.includes(TELEGRAM_SILENT_DIRECTIVE)
    ) {
      await writeWhisperPlaceholder(
        target,
        { content: { remove: true }, from: ["open", "progress", "failed"], to: "answered" },
        dependencies,
      );
    }
    return;
  }
  const content =
    output.kind === "reaction"
      ? { format: "plain" as const, text: output.emoji }
      : presented(output.message);
  if (!content) return;
  // Interim text never replaces the answer, and stops once the turn has been told it failed.
  const change =
    output.kind === "progress"
      ? { content, from: ["open", "progress"] as const, to: "progress" as const }
      : { content, from: ["open", "progress", "failed"] as const, to: "answered" as const };
  await writeWhisperPlaceholder(target, change, dependencies);
}

/** A placeholder still open when its turn ended was never told anything. */
export async function finishTelegramWhisperTurn(
  auth: WhisperAuth,
  dependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<void> {
  const target = telegramWhisperTarget(auth);
  if (!target) return;
  await writeWhisperPlaceholder(
    target,
    {
      content: { format: "plain", text: WHISPER_EMPTY_ANSWER_TEXT },
      from: ["open"],
      to: "failed",
    },
    dependencies,
  );
}

export async function reportTelegramWhisperFailure(
  auth: WhisperAuth,
  text: string,
  dependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<void> {
  const target = telegramWhisperTarget(auth);
  if (!target) return;
  await writeWhisperPlaceholder(
    target,
    { content: { format: "plain", text }, from: ["open", "progress"], to: "failed" },
    dependencies,
  );
}
