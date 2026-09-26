/**
 * The gate of the browser tools: which act call stops for a human, decided by code alone.
 *
 * Exports:
 * - `gateDecision`: `{ gated, reason }` for one action on one element of the last look.
 * - `ActAction`, `EnteredField`: the action and the record of data typed on this site.
 * - `isSearchField`, `SEARCH_FIELD`: a search box is neither entered data nor a form.
 *
 * Key constructs:
 * - No model is asked whether an action is final. browser_task 1.2.x asked one, and the answer
 *   was a self-estimate: calibrated on three sites for Jev, not at all for DeepSeek.
 * - Three rules, from `irreversible.ts` vocabulary: a transaction word anywhere; a booking word
 *   inside a form or after data was entered; after data was entered, any click on a button, link
 *   or submit. A false stop costs one confirmation; a miss cannot happen by construction.
 */
import { FORM_SUBMIT_WORDS, TRANSACTION_WORDS } from "./irreversible.js";
import type { PageView } from "./page-view.js";
import type { SomAction } from "./som-script.js";

export type ActAction =
  | SomAction
  | { kind: "scroll"; direction: "down" | "up" }
  | { kind: "press"; key: string }
  | { kind: "back" };
/**
 * `value` is shown to the person in the confirmation window only; the model sees labels. `epoch`
 * and `n` identify the field within one look: re-filling it replaces the entry, a field of the
 * same label in another look is another entry, since numbers change with every look.
 */
export interface EnteredField { epoch?: string; field: string; label: string; n: number; value?: string; }
export type GateReason = "after-entry" | "form-submit" | "transaction";

const words = (list: readonly string[]) => new RegExp(`(?:^|[^\\p{L}])(?:${list.join("|")})(?:[^\\p{L}]|$)`, "iu");
const TRANSACTION = words(TRANSACTION_WORDS);
const FORM_SUBMIT = words(FORM_SUBMIT_WORDS);
export const CONTACT_FIELD = /телефон|phone|тел\.|имя|name|фамили|e-?mail|почт/iu;
const FIELD_ROLES = new Set(["checkbox", "combobox", "date", "file", "radio", "spinbutton", "textbox", "time"]);
const SUBMIT_ROLES = new Set(["button", "link", "menuitem", "submit"]);
const CLICKABLE_ROLES = new Set([...SUBMIT_ROLES, "generic", "tab", "option", "treeitem"]);
/** Picking a tab or an option changes what is shown, not what is sent. */
const SAFE_AFTER_ENTRY_ROLES = new Set(["tab", "option", "treeitem"]);
/** Cookie consent buttons: passport.yandex.ru asked to confirm «Allow essential cookies» after the phone was typed. */
const COOKIE_CONSENT = /cookie|куки|cookies/iu;

/** A search box is a way around a site, not a form: typing there and moving on sends nothing. */
export const SEARCH_FIELD = /поиск|найти|search/iu;
export function isSearchField(element: { role: string; text: string }): boolean {
  return element.role === "searchbox" || SEARCH_FIELD.test(element.text);
}

/** Any field on the page but a search box: a form is not only its contact fields. */
export function hasFormContext(view: PageView): boolean {
  return view.elements.some((e) => FIELD_ROLES.has(e.role) && !isSearchField(e));
}

export function gateDecision(input: {
  action: ActAction;
  entered: readonly EnteredField[];
  n: number | null;
  view: PageView;
}): { gated: boolean; reason?: GateReason } {
  if (input.action.kind !== "click" || input.n === null) return { gated: false };
  const element = input.view.elements.find((e) => e.n === input.n);
  if (!element || !CLICKABLE_ROLES.has(element.role)) return { gated: false };
  if (TRANSACTION.test(element.text)) return { gated: true, reason: "transaction" };
  // A form's submit button sends the form whatever it is called and whoever filled it.
  if (element.role === "submit") return { gated: true, reason: "form-submit" };
  const entered = input.entered.length > 0;
  // A booking word on a button, in a form or after entered data: a link on a home page only leads to the form.
  if (FORM_SUBMIT.test(element.text) && (entered || element.role === "button" || hasFormContext(input.view))) return { gated: true, reason: "form-submit" };
  // A cookie banner sends nothing: closing it after typing is not the form going out.
  if (entered && COOKIE_CONSENT.test(element.text)) return { gated: false };
  // A custom button is a generic element with a label; after entered data no click is proven safe.
  if (entered && !SAFE_AFTER_ENTRY_ROLES.has(element.role)) return { gated: true, reason: "after-entry" };
  return { gated: false };
}
