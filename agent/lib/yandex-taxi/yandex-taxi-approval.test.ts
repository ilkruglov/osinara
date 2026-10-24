/**
 * The confirmation window of a Yandex Go order and cancellation.
 *
 * Constructs covered:
 * - The order window shows from and to (full addresses with the city, the porch), the tariff, the price with its
 *   currency, whether it is fixed, the pickup estimate and the payment method, all from the input.
 * - A point whose text no longer matches its key is never shown, nor one whose key was computed
 *   without the installation's secret (a forged pairing of a familiar address and other coordinates).
 * - The cancellation window names the terms and shows the site's words only for a paid one.
 * - Any other input is refused rather than shown generically.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { yandexTaxiApprovalPrompt } from "./yandex-taxi-approval.js";
import { withYandexTaxiPointKey } from "./yandex-taxi-model.js";
import { fromPoint, toPoint } from "./yandex-taxi.test-fixtures.js";

const order = {
  action: "order", currency: "₽", fixedPrice: true, from: fromPoint, payment: { id: "card-1", label: "карта MIR ••1234", type: "card" },
  porch: "2", price: 350, tariff: "econom", tariffName: "Эконом", to: toPoint, waitingMinutes: 4,
};

describe("yandexTaxiApprovalPrompt", () => {
  it("shows the ride exactly as it will be ordered", () => {
    const prompt = yandexTaxiApprovalPrompt(order);
    expect(prompt).toContain("Подтверждение: заказать такси Яндекс Go за 350 ₽.");
    expect(prompt).toContain("Откуда: Россия, Москва, Корабельная улица, 11к1, подъезд 2");
    expect(prompt).toContain("Куда: Россия, Химки, аэропорт Шереметьево, терминал B");
    expect(prompt).toContain("Тариф: Эконом");
    expect(prompt).toContain("Цена: 350 ₽, фиксированная");
    expect(prompt).toContain("Не дороже: 367 ₽");
    expect(prompt).toContain("Подача: примерно через 4 мин (оценка)");
    expect(prompt).toContain("Оплата: карта MIR ••1234");
  });

  it("marks a price that is not fixed and a missing pickup estimate", () => {
    const prompt = yandexTaxiApprovalPrompt({ ...order, fixedPrice: false, payment: { label: "наличные", type: "cash" }, porch: undefined, waitingMinutes: null });
    expect(prompt).toContain("за ≈ 350 ₽");
    expect(prompt).toContain("Цена: ≈ 350 ₽, не фиксированная");
    expect(prompt).toContain("Подача: Яндекс Go не оценил");
    expect(prompt).toContain("Оплата: наличные");
    expect(prompt).toContain("Откуда: Россия, Москва, Корабельная улица, 11к1\n");
  });

  it("names the city when the full address leaves it out, so a same-named street elsewhere is visible", () => {
    const tver = withYandexTaxiPointKey({ city: "Тверь", fullText: "Тверская улица, 1", lat: 56.86, lon: 35.9, shortText: "Тверская 1", uri: "" });
    const prompt = yandexTaxiApprovalPrompt({ ...order, from: tver, porch: undefined });
    expect(prompt).toContain("Откуда: Тверь, Тверская улица, 1\n");
  });

  it("never shows a point made up outside the tool, even with a hash over its own fields", () => {
    const fields = { city: "Москва", fullText: "Россия, Москва, Корабельная улица, 11к1", lat: 55.9, lon: 37.9, shortText: "Корабельная 11к1", uri: "" };
    const forgedKey = createHash("sha256").update(JSON.stringify(["yandex-taxi-point", fields.shortText, fields.fullText, fields.lon.toFixed(6), fields.lat.toFixed(6), fields.uri, fields.city])).digest("hex").slice(0, 16);
    expect(() => yandexTaxiApprovalPrompt({ ...order, from: { ...fields, key: forgedKey } })).toThrow(expect.objectContaining({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID" }));
    const signed = withYandexTaxiPointKey(fields);
    vi.stubEnv("INVITATION_SIGNING_SECRET", "another-installation-secret-0123456789abcdef");
    try {
      expect(() => yandexTaxiApprovalPrompt({ ...order, from: signed })).toThrow(expect.objectContaining({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID" }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never shows a point whose text was changed after the lookup", () => {
    expect(() => yandexTaxiApprovalPrompt({ ...order, to: { ...toPoint, shortText: "Внуково" } })).toThrow(expect.objectContaining({ code: "AGENT_YANDEX_TAXI_POINT_REF_INVALID" }));
  });

  it("names the cancellation terms and shows the site's words only when it costs money", () => {
    const free = yandexTaxiApprovalPrompt({ action: "cancel", cancelState: "free", orderId: "o-1" });
    expect(free).toContain("отменить заказ такси Яндекс Go бесплатно");
    expect(free).toContain("Заказ: o-1");
    expect(free).not.toContain("Условия Яндекс Go");
    const paid = yandexTaxiApprovalPrompt({ action: "cancel", cancelMessage: "Отмена платная: 99 ₽", cancelState: "paid", orderId: "o-1" });
    expect(paid).toContain("Отмена: платно");
    expect(paid).toContain("Условия Яндекс Go: Отмена платная: 99 ₽");
  });

  it("refuses inputs it cannot explain", () => {
    for (const input of [{ action: "estimate", from: fromPoint, to: toPoint }, { ...order, price: undefined }, { ...order, payment: { id: "card-1", type: "card" } }, null]) {
      expect(() => yandexTaxiApprovalPrompt(input)).toThrow(expect.objectContaining({ code: "AGENT_APPROVAL_SUBJECT_INVALID" }));
    }
  });
});
