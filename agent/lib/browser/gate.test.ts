/**
 * Gate tests: which act calls stop for a human, decided by code alone.
 *
 * Constructs covered:
 * - A transaction word on the element stops everywhere, form or not.
 * - A booking word stops inside a form (a contact field on the page) or once data was entered.
 * - After data was entered in this page chain, any click on a button, link or submit stops.
 * - Fills, selects, scrolls and clicks on plain cards never stop.
 */
import { describe, expect, it } from "vitest";

import { gateDecision } from "./gate.js";
import { parsePageView } from "./page-view.js";

const view = (rows: Array<Partial<{ n: number; role: string; text: string; state: string[] }>>) => parsePageView(JSON.stringify({
  epoch: "e", title: "t", url: "https://x.ru/", elements: rows.map((r, i) => ({ n: i + 1, role: "button", text: "", ...r })),
}));

describe("gateDecision", () => {
  it("stops on a transaction word anywhere", () => {
    const v = view([{ role: "button", text: "Оплатить 1500 ₽" }, { role: "link", text: "Удалить заказ" }, { role: "generic", text: "Купить сертификат" }]);
    for (const n of [1, 2, 3]) expect(gateDecision({ action: { kind: "click" }, entered: [], n, view: v })).toMatchObject({ gated: true, reason: "transaction" });
  });

  it("stops on a booking word only inside a form or after entered data", () => {
    const home = view([{ role: "link", text: "Записаться онлайн" }]);
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 1, view: home })).toMatchObject({ gated: false });
    const form = view([{ role: "textbox", text: "Номер телефона" }, { role: "link", text: "Продолжить" }]);
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 2, view: form })).toMatchObject({ gated: true, reason: "form-submit" });
    // A search box on a catalogue page is not a form: dikidi's «Продолжить» after picking a service.
    const catalogue = view([{ role: "textbox", text: "Поиск" }, { role: "link", text: "Продолжить" }]);
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 2, view: catalogue })).toMatchObject({ gated: false });
    const address = view([{ role: "textbox", text: "Адрес" }, { role: "link", text: "Сохранить" }]);
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 2, view: address })).toMatchObject({ gated: true, reason: "form-submit" });
    expect(gateDecision({ action: { kind: "click" }, entered: [{ field: "phone", label: "Телефон", n: 1 }], n: 1, view: home })).toMatchObject({ gated: true, reason: "form-submit" });
  });

  it("stops on any click once data was entered, except picking a tab or an option", () => {
    const v = view([{ role: "textbox", text: "Имя" }, { role: "button", text: "Ок" }, { role: "generic", text: "OK" }, { role: "checkbox", text: "Согласие" }, { role: "tab", text: "Вечер" }]);
    const entered = [{ field: "name", label: "Имя", n: 1 }];
    expect(gateDecision({ action: { kind: "click" }, entered, n: 2, view: v })).toMatchObject({ gated: true, reason: "after-entry" });
    // A custom button is a generic element with a label: no role proves the click safe.
    expect(gateDecision({ action: { kind: "click" }, entered, n: 3, view: v })).toMatchObject({ gated: true, reason: "after-entry" });
    expect(gateDecision({ action: { kind: "click" }, entered, n: 4, view: v })).toMatchObject({ gated: false });
    expect(gateDecision({ action: { kind: "click" }, entered, n: 5, view: v })).toMatchObject({ gated: false });
    expect(gateDecision({ action: { kind: "fill", text: "x" }, entered, n: 1, view: v })).toMatchObject({ gated: false });
  });

  it("stops on a form's submit button whatever its label and whoever filled the form", () => {
    const v = view([{ role: "submit", text: "ОК" }, { role: "button", text: "ОК" }]);
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 1, view: v })).toMatchObject({ gated: true, reason: "form-submit" });
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 2, view: v })).toMatchObject({ gated: false });
  });

  it("never stops fills, selects, scrolls or unknown numbers", () => {
    const v = view([{ role: "button", text: "Оплатить" }]);
    expect(gateDecision({ action: { kind: "scroll", direction: "down" }, entered: [], n: null, view: v })).toMatchObject({ gated: false });
    expect(gateDecision({ action: { kind: "click" }, entered: [], n: 9, view: v })).toMatchObject({ gated: false });
  });
});
