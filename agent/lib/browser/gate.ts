/**
 * The gate of the browser tools: which act call stops for a human, decided by code alone.
 *
 * Exports:
 * - `gateDecision`: `{ gated, reason }` for one action on one element of the last look.
 * - `ActAction`, `EnteredField`: the action and the record of data typed on this page chain.
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
export interface EnteredField { field: string; label: string; n: number; }
export type GateReason = "after-entry" | "form-submit" | "transaction";

const words = (list: readonly string[]) => new RegExp(`(?:^|[^\\p{L}])(?:${list.join("|")})(?:[^\\p{L}]|$)`, "iu");
const TRANSACTION = words(TRANSACTION_WORDS);
const FORM_SUBMIT = words(FORM_SUBMIT_WORDS);
const CONTACT_FIELD = /телефон|phone|тел\.|имя|name|фамили|e-?mail|почт/iu;
const FIELD_ROLES = new Set(["combobox", "date", "searchbox", "spinbutton", "textbox", "time"]);
const SUBMIT_ROLES = new Set(["button", "link", "menuitem", "submit"]);
const CLICKABLE_ROLES = new Set([...SUBMIT_ROLES, "generic", "tab", "option", "treeitem"]);

export function hasFormContext(view: PageView): boolean {
  return view.elements.some((e) => FIELD_ROLES.has(e.role) && CONTACT_FIELD.test(e.text));
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
  const entered = input.entered.length > 0;
  if (FORM_SUBMIT.test(element.text) && (entered || hasFormContext(input.view))) return { gated: true, reason: "form-submit" };
  if (entered && SUBMIT_ROLES.has(element.role)) return { gated: true, reason: "after-entry" };
  return { gated: false };
}
