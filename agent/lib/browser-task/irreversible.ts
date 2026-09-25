/**
 * Gate vocabulary for browser_task: which chosen element counts as the irreversible step.
 *
 * Exports:
 * - `hasFormContext`: the page carries a name, phone or e-mail field.
 * - `looksIrreversible`: a transaction word anywhere, or a submit-like word inside a form.
 * - `ACTION_CONFIDENCE_THRESHOLD`, `FINAL_STEP_THRESHOLD`: measured on the spike of 22 сентября 2026.
 *
 * Key constructs:
 * - Two vocabularies. Paying, deleting, buying, confirming, sending and ordering end a transaction
 *   wherever the button stands: the last screen of a multi-step form and a signed-in account show
 *   them with no contact field around. Booking words ("Записаться", "Продолжить", "Далее") also
 *   lead to the form from a home page, so they stop the loop only inside a form.
 * - Two of three booking sites submit through a `link`, not a `button`, and Dikidi's submit is
 *   the link "Продолжить". So the role is not the signal.
 * - A word miss is not the last line: every other click is put to Jev as a final-step question.
 * - A false positive costs one extra confirmation. A miss books the wrong slot. Thresholds are low.
 */
import type { ElementTable, TableElement } from "./element-table.js";

/** Below this Jev is guessing: on the spike correct steps scored 0.42 to 0.98, flailing 0.14 to 0.35. */
export const ACTION_CONFIDENCE_THRESHOLD = 0.35;
/** With the chosen element named in the state, filled-form submits scored 0.30 to 0.84, everything else at most 0.08. */
export const FINAL_STEP_THRESHOLD = 0.25;

/** A transaction ends here, form or not. */
export const TRANSACTION_WORDS: readonly string[] = [
  "подтвердить", "оплатить", "отправить", "заказать", "купить", "удалить",
  "confirm", "pay", "submit", "order", "buy", "delete",
];
/** A submit inside a form, a way into the form outside it. */
export const FORM_SUBMIT_WORDS: readonly string[] = [
  "записаться", "записать", "сохранить", "забронировать", "бронировать", "продолжить", "далее", "готово",
  "book", "reserve", "continue", "next",
];
const CLICKABLE_ROLES = new Set(["button", "generic", "link", "text"]);
const wordsPattern = (words: readonly string[]): RegExp =>
  new RegExp(`(?:^|[^\\p{L}])(?:${words.join("|")})(?:[^\\p{L}]|$)`, "iu");
const TRANSACTION = wordsPattern(TRANSACTION_WORDS);
const FORM_SUBMIT = wordsPattern(FORM_SUBMIT_WORDS);
const CONTACT_FIELD = /телефон|phone|тел\.|имя|name|фамили|e-?mail|почт/iu;

export function hasFormContext(table: ElementTable): boolean {
  return table.elements.some((e) => e.operations.includes("TYPE_TEXT") && CONTACT_FIELD.test(e.name));
}

export function looksIrreversible(element: Pick<TableElement, "name" | "role">, formContext: boolean): boolean {
  if (!CLICKABLE_ROLES.has(element.role)) return false;
  return TRANSACTION.test(element.name) || (formContext && FORM_SUBMIT.test(element.name));
}
