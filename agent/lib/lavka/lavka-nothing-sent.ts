/**
 * The mark of a Lavka failure raised before a side effect left the tab.
 *
 * Exports:
 * - `lavkaNothingSent`: marks an error raised before an order or a cancellation was sent.
 * - `isLavkaNothingSent`: whether an error carries that mark.
 *
 * Key construct:
 * - The operation ledger keeps a call's key after any failure it cannot prove harmless, so a retry
 *   is answered «may have reached Lavka». The order re-reads the cart, the card and the depot before
 *   its submit, and a timeout there kept the key too: every retry of a confirmed order was refused
 *   though nothing had been sent (Codex review, 6 November 2026). Such failures carry this mark and
 *   the ledger frees the key, as the taxi's ledger does (`yandexTaxiNothingSent`).
 */
const NOTHING_SENT = new WeakSet<object>();

export function lavkaNothingSent<E>(error: E): E {
  if (typeof error === "object" && error !== null) NOTHING_SENT.add(error);
  return error;
}

export const isLavkaNothingSent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && NOTHING_SENT.has(error);
