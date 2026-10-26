/**
 * Location message text tests.
 *
 * Constructs covered:
 * - A location shared in a private chat becomes a line the model can read, with its accuracy and
 *   whether it is a live one; a venue adds its name and address.
 * - Groups, messages that already have text and messages without a location stay as they are.
 * - Malformed coordinates never become text.
 */
import type { TelegramUpdate } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";

import { withLocationText } from "./telegram-location-message.js";

function update(raw: Record<string, unknown>, options: { chatType?: string; text?: string } = {}): TelegramUpdate {
  return {
    kind: "message",
    message: {
      attachments: [],
      caption: "",
      chat: { id: "101", type: options.chatType ?? "private" },
      from: { id: "101", isBot: false },
      messageId: "7",
      raw,
      text: options.text ?? "",
    },
  } as unknown as TelegramUpdate;
}

const textOf = (value: TelegramUpdate): string => (value as { message: { text: string } }).message.text;

describe("withLocationText", () => {
  it("writes a shared location in a private chat as coordinates the taxi tool can take", () => {
    expect(textOf(withLocationText(update({ location: { horizontal_accuracy: 19.5, latitude: 55.7539, longitude: 37.6208 } }))))
      .toBe("Геолокация: 55.753900, 37.620800, точность 20 м");
    expect(textOf(withLocationText(update({ location: { latitude: -33.8688, live_period: 900, longitude: 151.2093 } }))))
      .toBe("Геолокация (трансляция): -33.868800, 151.209300");
  });

  it("names a venue before its coordinates", () => {
    const venue = { address: "Красная площадь, 3", location: { latitude: 55.7547, longitude: 37.6215 }, title: "ГУМ" };
    expect(textOf(withLocationText(update({ location: venue.location, venue }))))
      .toBe("Место: ГУМ, Красная площадь, 3. Геолокация: 55.754700, 37.621500");
  });

  it("leaves groups, text messages and messages without a location alone", () => {
    const location = { latitude: 55.7539, longitude: 37.6208 };
    for (const original of [
      update({ location }, { chatType: "supergroup" }),
      update({ location }, { text: "я тут" }),
      update({ text: "привет" }, { text: "привет" }),
    ]) expect(withLocationText(original)).toBe(original);
  });

  it("never turns broken coordinates into text", () => {
    for (const location of [{ latitude: 91, longitude: 0 }, { latitude: "55", longitude: 37 }, { latitude: Number.NaN, longitude: 0 }, null]) {
      const original = update({ location });
      expect(withLocationText(original)).toBe(original);
    }
  });
});
