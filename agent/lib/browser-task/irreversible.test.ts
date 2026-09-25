/**
 * Gate vocabulary tests.
 *
 * Constructs covered:
 * - Inside a form, submit-like names on buttons, links, generics and text leaves count.
 * - Outside a form booking words do not count: "Записаться онлайн" on a home page only leads to the form.
 * - "Продолжить" and "Далее" count only inside a form (Dikidi submits through a link so named).
 * - Paying, deleting, confirming and ordering count everywhere: a last step has no contact fields.
 */
import { describe, expect, it } from "vitest";

import { hasFormContext, looksIrreversible } from "./irreversible.js";
import { parseSnapshot } from "./element-table.js";

describe("looksIrreversible", () => {
  it.each([
    ["button", "Записаться"], ["button", "Подтвердить запись"], ["link", "ЗАБРОНИРОВАТЬ"],
    ["generic", "Оплатить 1500 ₽"], ["text", "Записаться"], ["button", "Book now"], ["link", "Продолжить"], ["button", "Далее"],
  ])("flags %s %s inside a form", (role, name) => {
    expect(looksIrreversible({ name, role }, true)).toBe(true);
  });

  it.each([["button", "Выбрать мастера"], ["textbox", "Отправитель"], ["checkbox", "Согласие"], ["option", "Трубная площадь, 2"]])
    ("passes %s %s inside a form", (role, name) => {
      expect(looksIrreversible({ name, role }, true)).toBe(false);
    });

  it("does not fire on booking words outside a form", () => {
    expect(looksIrreversible({ name: "Записаться онлайн", role: "link" }, false)).toBe(false);
    expect(looksIrreversible({ name: "Забронировать", role: "button" }, false)).toBe(false);
    expect(looksIrreversible({ name: "Продолжить", role: "link" }, false)).toBe(false);
  });

  it.each([["button", "Оплатить"], ["button", "Удалить заказ"], ["link", "Подтвердить запись"], ["generic", "Pay now"], ["button", "Купить"]])
    ("fires on %s %s without a form", (role, name) => {
      expect(looksIrreversible({ name, role }, false)).toBe(true);
    });
});

describe("hasFormContext", () => {
  it("is true when a name, phone or e-mail field is on the page", () => {
    expect(hasFormContext(parseSnapshot(`- textbox "Номер телефона" [ref=e1]\n- button "Записаться" [ref=e2]`))).toBe(true);
    expect(hasFormContext(parseSnapshot(`- textbox "Ваше имя*" [ref=e1]`))).toBe(true);
    expect(hasFormContext(parseSnapshot(`- textbox "Найти" [ref=e1]\n- button "Записаться" [ref=e2]`))).toBe(false);
  });
});
