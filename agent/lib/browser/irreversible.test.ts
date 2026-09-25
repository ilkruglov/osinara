/**
 * Gate vocabulary tests.
 *
 * Constructs covered:
 * - Inside a form, booking and submit-like names count.
 * - Outside a form booking words do not: "Записаться онлайн" on a home page only leads to the form.
 * - Paying, deleting, confirming and ordering count everywhere: a last step has no contact fields.
 */
import { describe, expect, it } from "vitest";

import { looksIrreversible } from "./irreversible.js";

describe("looksIrreversible", () => {
  it.each(["Записаться", "Подтвердить запись", "ЗАБРОНИРОВАТЬ", "Оплатить 1500 ₽", "Book now", "Продолжить", "Далее"])
    ("flags %s inside a form", (name) => { expect(looksIrreversible(name, true)).toBe(true); });

  it.each(["Выбрать мастера", "Отправитель", "Согласие", "Трубная площадь, 2"])
    ("passes %s inside a form", (name) => { expect(looksIrreversible(name, true)).toBe(false); });

  it("does not fire on booking words outside a form", () => {
    for (const name of ["Записаться онлайн", "Забронировать", "Продолжить"]) expect(looksIrreversible(name, false)).toBe(false);
  });

  it.each(["Оплатить", "Удалить заказ", "Подтвердить запись", "Pay now", "Купить"])
    ("fires on %s without a form", (name) => { expect(looksIrreversible(name, false)).toBe(true); });
});
