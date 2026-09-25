/**
 * Gate vocabulary for the browser tools: which element names end a transaction.
 *
 * Exports:
 * - `TRANSACTION_WORDS`: a transaction ends here, form or not: paying, deleting, buying,
 *   confirming, sending, ordering.
 * - `FORM_SUBMIT_WORDS`: a submit inside a form, a way into the form outside it: booking words
 *   and "continue"/"next". Dikidi submits through a link named «Продолжить»; on a home page the
 *   same words only lead to the form.
 * - `looksIrreversible`: the two vocabularies applied to one element name.
 */
export const TRANSACTION_WORDS: readonly string[] = [
  "подтвердить", "оплатить", "отправить", "заказать", "купить", "удалить",
  "confirm", "pay", "submit", "order", "buy", "delete",
];
export const FORM_SUBMIT_WORDS: readonly string[] = [
  "записаться", "записать", "сохранить", "забронировать", "бронировать", "продолжить", "далее", "готово",
  "book", "reserve", "continue", "next",
];
const wordsPattern = (words: readonly string[]): RegExp =>
  new RegExp(`(?:^|[^\\p{L}])(?:${words.join("|")})(?:[^\\p{L}]|$)`, "iu");
const TRANSACTION = wordsPattern(TRANSACTION_WORDS);
const FORM_SUBMIT = wordsPattern(FORM_SUBMIT_WORDS);

export function looksIrreversible(name: string, formContext: boolean): boolean {
  return TRANSACTION.test(name) || (formContext && FORM_SUBMIT.test(name));
}
