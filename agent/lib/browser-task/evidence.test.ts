/**
 * Evidence tests: `done` is claimed only with quotes found on the final page.
 */
import { describe, expect, it } from "vitest";

import { findEvidence, SUCCESS_TERMS } from "./evidence.js";

describe("findEvidence", () => {
  const page = "Барбершоп Франт. Вы записаны! Мастер Иван, 23 сентября 18:30, мужская стрижка. Ждём вас. Телефон +7 916 000-00-00.";

  it("returns short quotes around success phrases first, then goal terms", () => {
    const quotes = findEvidence(page, [...SUCCESS_TERMS, "Иван", "18:30"]);
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(quotes[0]!.quote).toMatch(/Вы записаны/u);
    expect(quotes.every((q) => q.quote.length <= 160)).toBe(true);
  });

  it("does not return the same stretch of text twice", () => {
    const quotes = findEvidence(page, ["Иван", "Мастер Иван", "Иван,"]);
    expect(quotes).toHaveLength(1);
  });

  it("returns nothing when no term matches", () => {
    expect(findEvidence("Главная страница. Услуги. Контакты.", ["Иван", ...SUCCESS_TERMS])).toEqual([]);
  });
});
