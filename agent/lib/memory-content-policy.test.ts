/**
 * Long-term memory content policy tests.
 *
 * Constructs covered:
 * - Credentials, private keys, one-time codes, and valid payment card numbers are rejected.
 * - The refusal reads the journal's secret rules: a machine form (a provider key, a Bearer token,
 *   a `NAME_KEY=` assignment) and a secret told in words (a password, a card with its expiry, a
 *   CVV) are refused alike; a masked machine value, speech about a password and code that only
 *   names a key are not.
 * - Exact coordinates of where a person was are rejected for memory writes with their own message:
 *   a pair named as a location, or one as precise as a phone's fix.
 *   A version, a price, a rounded coordinate, exchange rates and model weights are not coordinates.
 * - Ordinary durable facts pass without transforming user content.
 */
import { describe, expect, it } from "vitest";

import { memoryWriteRejectionCode, requireAllowedMemoryContent } from "./memory-content-policy.js";

describe("requireAllowedMemoryContent", () => {
  it.each([
    "Пароль: correct-horse-battery-staple",
    "API key sk_test_1234567890abcdef",
    "-----BEGIN PRIVATE KEY-----\nabc",
    "Одноразовый код: 123456",
    "Карта 4242 4242 4242 4242",
  ])("rejects prohibited secret content: %s", (content) => {
    expect(() => requireAllowedMemoryContent(content)).toThrowError(
      /AGENT_MEMORY_CONTENT_FORBIDDEN/,
    );
  });

  it.each([
    ["ключ sk-proj-abcdefgh12", "AGENT_MEMORY_SECRET_REJECTED"],
    ["Authorization: Bearer abcdefghijklmnop1234", "AGENT_MEMORY_SECRET_REJECTED"],
    ["FAL_KEY=abcdefghij0123456789", "AGENT_MEMORY_SECRET_REJECTED"],
    ["CVV: 123", "AGENT_MEMORY_SECRET_REJECTED"],
    ["Карта 4242 4242 4242 4242 12/27", "AGENT_MEMORY_SECRET_REJECTED"],
    ["Пароль: «Qwerty123»", "AGENT_MEMORY_SECRET_REJECTED"],
    ["FAL_KEY=[СКРЫТО], сменить в пятницу", null],
    ["Сбросила пароль администратора.", null],
    ["cache_key = make_key(chat, day)", null],
  ])("classifies %j by the shared secret table", (content, code) => {
    expect(memoryWriteRejectionCode(content)).toBe(code);
  });

  it.each([
    "Геолокация: 55.753900, 37.620800, точность 20 м",
    "Дом у Анны, координаты 55.7539 37.6208",
    "живёт около -33.86881;151.20935",
    "Место встречи 55.753912, 37.620845",
    "Встречаемся в точке 55.7539, 37.6208",
    "lat/lon 55.7539, 37.6208",
  ])("rejects exact coordinates: %s", (content) => {
    expect(memoryWriteRejectionCode(content)).toBe("AGENT_MEMORY_LOCATION_REJECTED");
    expect(() => requireAllowedMemoryContent(content)).toThrowError(/Координаты/u);
  });

  it.each([
    "Обновил Node до 24.8.0, Python 3.12.4",
    "Поездка стоила 540.50, чаевые 50.00",
    "Дача примерно на 55.7, 37.6",
    "Курсы покупки и продажи: 89.1234, 89.5678",
    "Коэффициенты модели: 0.1234 0.5678",
  ])("keeps numbers that are not exact coordinates: %s", (content) => {
    expect(memoryWriteRejectionCode(content)).toBeNull();
  });

  it("returns an ordinary fact unchanged", () => {
    const content = "Пользователь предпочитает путешествовать поездом";

    expect(requireAllowedMemoryContent(content)).toBe(content);
  });
});
