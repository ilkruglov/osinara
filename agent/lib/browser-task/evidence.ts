/**
 * Evidence for browser_task: `done` is claimed only with quotes found on the final page.
 *
 * Exports:
 * - `findEvidence`: up to three short quotes around the first occurrences of the given terms.
 * - `SUCCESS_TERMS`: confirmation phrases searched before the goal's own words.
 *
 * Key construct:
 * - Jev's DONE is a guess. The quotes are what the model repeats to the person instead of
 *   "готово": if none is found the run is `unverified`, and Mia says so.
 */
export const SUCCESS_TERMS: readonly string[] = [
  "вы записаны", "запись подтверждена", "запись создана", "вы успешно записаны", "бронь подтверждена",
  "забронирован", "ждём вас", "успешно", "booked", "confirmed", "reservation",
];
const HALF_WINDOW = 70;
const QUOTE_MAX_CHARACTERS = 160;

export function findEvidence(pageText: string, terms: readonly string[], limit = 3): Array<{ quote: string }> {
  const text = pageText.replace(/\s+/gu, " ").trim();
  const lower = text.toLowerCase();
  const quotes: Array<{ quote: string }> = [];
  // Two terms may sit close together and still be two facts (the master and the time);
  // only a needle overlapping an already quoted needle is the same fact twice.
  const spans: Array<[number, number]> = [];
  for (const term of terms) {
    const needle = term.toLowerCase().trim();
    if (needle.length < 3) continue;
    const at = lower.indexOf(needle);
    if (at < 0 || spans.some(([from, to]) => at < to && at + needle.length > from)) continue;
    spans.push([at, at + needle.length]);
    const start = Math.max(0, at - HALF_WINDOW);
    const end = Math.min(text.length, at + needle.length + HALF_WINDOW);
    quotes.push({ quote: text.slice(start, end).trim().slice(0, QUOTE_MAX_CHARACTERS) });
    if (quotes.length >= limit) break;
  }
  return quotes;
}
