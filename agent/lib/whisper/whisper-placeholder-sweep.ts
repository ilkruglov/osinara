/**
 * The minute sweep of whisper placeholders.
 *
 * Export:
 * - `sweepWhisperPlaceholders`: finishes what the turn path could not, in one bounded pass.
 *
 * Key constructs:
 * - A placeholder no stored update carries is removed: the queue write rolled back after the
 *   placeholder was sent, or Telegram redelivered the update and the queue kept the first one.
 * - A placeholder still open two minutes after its update ended gets the «no answer» text: the
 *   turn ended without telling its author (a crash between the end of the update and the failure
 *   notice). A later answer still replaces it.
 * - An edit Telegram did not confirm is repeated with the status and content recorded for it.
 */
import { WHISPER_EMPTY_ANSWER_TEXT } from "./telegram-whisper-delivery.js";
import {
  PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
  retryWhisperPlaceholder,
  writeWhisperPlaceholder,
  type WhisperPlaceholderDependencies,
} from "./whisper-placeholder-writer.js";

const SWEEP_BATCH = 20;

export async function sweepWhisperPlaceholders(
  dependencies: WhisperPlaceholderDependencies = PRODUCTION_WHISPER_PLACEHOLDER_DEPENDENCIES,
): Promise<void> {
  const stale = await dependencies.placeholders.listStale(SWEEP_BATCH);
  for (const placeholder of stale) {
    const key = {
      chatId: placeholder.chatId,
      placeholderMessageId: placeholder.placeholderMessageId,
      receiverUserId: placeholder.receiverUserId,
    };
    await writeWhisperPlaceholder(
      key,
      placeholder.reason === "orphan"
        ? { content: { remove: true }, from: ["open"], to: "closed" }
        : {
            content: { format: "plain", text: WHISPER_EMPTY_ANSWER_TEXT },
            from: ["open"],
            to: "failed",
          },
      dependencies,
    );
  }
  const due = await dependencies.placeholders.claimDue(SWEEP_BATCH);
  for (const placeholder of due) {
    const key = {
      chatId: placeholder.chatId,
      placeholderMessageId: placeholder.placeholderMessageId,
      receiverUserId: placeholder.receiverUserId,
    };
    await retryWhisperPlaceholder(
      key,
      { content: placeholder.content, to: placeholder.status },
      dependencies,
    );
  }
  const purged = await dependencies.placeholders.purge();
  if (stale.length > 0 || due.length > 0 || purged > 0) {
    console.info(
      JSON.stringify({
        code: "AGENT_TELEGRAM_WHISPER_SWEEP",
        orphans: stale.filter((placeholder) => placeholder.reason === "orphan").length,
        purged,
        retried: due.length,
        unanswered: stale.filter((placeholder) => placeholder.reason === "unanswered").length,
      }),
    );
  }
}
