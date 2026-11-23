/**
 * Fitting what a reply brings along into the turn's budget.
 *
 * Export:
 * - `fitReplyParts`: shortens Telegram's copy of the reply target, then the fragment the author
 *   selected, until the current message leaves the timeline `REPLY_TIMELINE_RESERVE` characters of
 *   the turn's context; a part that would keep less than `REPLY_PART_MIN_CHARACTERS` (or less than
 *   all of a shorter one) is dropped instead. An ordinary turn and a whisper use the same rule.
 *
 * Key construct:
 * - Both parts are reserved in the turn's context before the timeline is chosen, and escaping can
 *   make a character six (`<` → `\u003c`): the two at 1 024 characters each failed the turn
 *   (final review, 22 November 2026). The copy goes first: the selected fragment is what the
 *   author points at. A dropped copy leaves the target marked unavailable; a dropped fragment
 *   leaves a target that is in the timeline still referenced.
 */
import { TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS } from "../config.js";
import { clipText } from "./display-text.js";
import type { TelegramReplyTargetProjection } from "./telegram-reply-target-snapshot.js";

/** Below this a shortened part tells the model too little to be worth its place. */
const REPLY_PART_MIN_CHARACTERS = 300;
/** Room the timeline keeps when a long reply target or fragment comes along. */
const REPLY_TIMELINE_RESERVE = 2_000;
const LIMIT = TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS - REPLY_TIMELINE_RESERVE;

/** The longest prefix of `text` whose candidate measures within `limit`, or null if too short. */
function longestFitting(
  text: string,
  measure: (clipped: string) => number,
  limit: number,
): string | null {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(clipText(text, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return low >= Math.min(REPLY_PART_MIN_CHARACTERS, text.length) ? clipText(text, low) : null;
}

export function fitReplyParts(
  parts: TelegramReplyTargetProjection,
  measure: (parts: TelegramReplyTargetProjection) => number,
): TelegramReplyTargetProjection {
  let fitted = parts;
  const snapshot = fitted.snapshot;
  if (measure(fitted) > LIMIT && snapshot !== null) {
    const contentText = longestFitting(
      snapshot.contentText,
      (clipped) => measure({ ...fitted, snapshot: { ...snapshot, contentText: clipped } }),
      LIMIT,
    );
    fitted = { ...fitted, snapshot: contentText === null ? null : { ...snapshot, contentText } };
  }
  const quotedText = fitted.quotedText;
  if (measure(fitted) > LIMIT && quotedText !== null) {
    const base = fitted;
    fitted = {
      ...fitted,
      quotedText: longestFitting(
        quotedText,
        (clipped) => measure({ ...base, quotedText: clipped }),
        LIMIT,
      ),
    };
  }
  return fitted;
}
