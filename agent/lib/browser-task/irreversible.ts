/**
 * Gate vocabulary for browser_task: which chosen element counts as the irreversible step.
 *
 * Exports:
 * - `hasFormContext`: the page carries a name, phone or e-mail field.
 * - `looksIrreversible`: submit-like name on a clickable element, inside a form only.
 * - `ACTION_CONFIDENCE_THRESHOLD`, `FINAL_STEP_THRESHOLD`: measured on the spike of 22 сентября 2026.
 *
 * Key constructs:
 * - Two of three booking sites submit through a `link`, not a `button`, and Dikidi's submit is
 *   the link "Продолжить". So the role is not the signal; the form context is. Outside a form
 *   the same words only lead to the form, and a stop there would end every task on the home page.
 * - A false positive costs one extra confirmation. A miss books the wrong slot. Thresholds are low.
 */
import type { ElementTable, TableElement } from "./element-table.js";

/** Below this Jev is guessing: on the spike correct steps scored 0.42 to 0.98, flailing 0.14 to 0.35. */
export const ACTION_CONFIDENCE_THRESHOLD = 0.35;
/** With the chosen element named in the state, filled-form submits scored 0.30 to 0.84, everything else at most 0.08. */
export const FINAL_STEP_THRESHOLD = 0.25;

export const IRREVERSIBLE_WORDS: readonly string[] = [
  "записаться", "записать", "подтвердить", "оплатить", "отправить", "заказать", "купить", "сохранить", "удалить",
  "забронировать", "бронировать", "продолжить", "далее", "готово",
  "book", "confirm", "pay", "submit", "order", "buy", "reserve", "delete", "continue", "next",
];
const CLICKABLE_ROLES = new Set(["button", "generic", "link", "text"]);
const WORD = new RegExp(`(?:^|[^\\p{L}])(?:${IRREVERSIBLE_WORDS.join("|")})(?:[^\\p{L}]|$)`, "iu");
const CONTACT_FIELD = /телефон|phone|тел\.|имя|name|фамили|e-?mail|почт/iu;

export function hasFormContext(table: ElementTable): boolean {
  return table.elements.some((e) => e.operations.includes("TYPE_TEXT") && CONTACT_FIELD.test(e.name));
}

export function looksIrreversible(element: Pick<TableElement, "name" | "role">, formContext: boolean): boolean {
  if (!formContext || !CLICKABLE_ROLES.has(element.role)) return false;
  return WORD.test(element.name);
}
